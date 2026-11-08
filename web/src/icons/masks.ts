// Loads the icon set's masks once, publishing each as it arrives; until then (or if it fails) the vector stays.
import type { IconKey, IconSet } from "./set.ts";
export interface ReadyMask<T> { readonly src: string; readonly texture: T; readonly second?: { readonly src: string; readonly texture: T } }
export class IconMasks<T> {
  private started: Promise<void> | undefined;
  private ready = new Map<IconKey, ReadyMask<T>>();
  private listeners = new Set<() => void>();
  version = 0;
  constructor(private readonly set: IconSet, private readonly load: (src: string) => Promise<T>) {}
  get(key: IconKey) { return this.ready.get(key); }
  /** DOM handoff needs every declared layer; the board draws the fill as soon as it is ready. */
  isReady(key: IconKey): boolean {
    const mask = this.ready.get(key);
    const expected = this.set[key];
    return !!mask && !!expected && (!expected.second || !!mask.second);
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  /** Starts loading on the first call; later calls return the same load. */
  start(): Promise<void> {
    return this.started ??= Promise.all(Object.entries(this.set).map(async ([key, mask]) => {
      try {
        const texture = await this.load(mask.src);
        const ready: ReadyMask<T> = { src: mask.src, texture };
        this.ready.set(key as IconKey, ready); this.changed();
        if (mask.second) {
          // Keep the ready fill if the optional shade fails.
          try {
            const second = await this.load(mask.second.src);
            this.ready.set(key as IconKey, { ...ready, second: { src: mask.second.src, texture: second } }); this.changed();
          } catch { /* The ready first mask remains unchanged. */ }
        }
      } catch { /* The original vector remains visible; a failed asset never blanks an icon. */ }
    })).then(() => {});
  }
}
