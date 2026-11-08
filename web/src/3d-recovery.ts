/** Retry a failed module graph in a fresh document, once. The build's pre-entry
 * import map gives retry/manual-return graphs fresh URLs (including dependencies):
 * WebKit can retain failed module URLs even across navigation. No storage is used.
 */
export const RETRY_3D_PARAM = "aw-3d-retry";
export const MANUAL_3D_PARAM = "aw-3d-manual";
export const RETRY_3D_DELAY_MS = 750;

export function clear3dRetryUrl(href: string): string {
  const url = new URL(href);
  if (!url.searchParams.has(RETRY_3D_PARAM) && !url.searchParams.has(MANUAL_3D_PARAM)) return href;
  url.searchParams.delete(RETRY_3D_PARAM);
  url.searchParams.delete(MANUAL_3D_PARAM);
  return url.toString();
}

/** Any existing marker means the automatic attempt has been spent, even if malformed. */
export function retry3dUrl(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.has(RETRY_3D_PARAM)) return null;
  url.searchParams.delete(MANUAL_3D_PARAM);
  url.searchParams.set(RETRY_3D_PARAM, "1");
  return url.toString();
}

export function returnTo3dUrl(href: string): string {
  const url = new URL(clear3dRetryUrl(href));
  url.searchParams.set("board", "3d");
  url.searchParams.set(MANUAL_3D_PARAM, "1");
  return url.toString();
}

export interface ThreeDStartup<T> {
  load(): Promise<T>;
  start(module: T): Promise<void>;
  href(): string;
  replace(href: string): void;
  /** Remove the internal marker from this document without navigating. */
  clean(): void;
  wait(ms: number): Promise<void>;
}

/** Only module loading is retryable. A partially initialized renderer must never start twice. */
export async function start3dWithRecovery<T>(s: ThreeDStartup<T>): Promise<void> {
  let module: T;
  try {
    module = await s.load();
  } catch (error) {
    const retry = retry3dUrl(s.href());
    if (retry === null) throw error;
    await s.wait(RETRY_3D_DELAY_MS);
    s.replace(retry);
    return; // The fresh document owns startup; do not create any renderer here.
  }
  s.clean();
  await s.start(module);
}
