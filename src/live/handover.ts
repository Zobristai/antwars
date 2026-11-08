/** The spectator side of one handover save. */
export interface SpectatorSave {
  /** JSON text, at most SPECTATOR_SAVE_META_BYTES UTF-8 bytes: the only part that goes into Firestore. */
  readonly meta: string;
  /** Bulky bytes by name ([a-z0-9-]{1,64}), stored outside Firestore and returned unchanged on resume. */
  readonly parts: ReadonlyMap<string, Uint8Array>;
}
export const SPECTATOR_SAVE_META_BYTES = 65_536;
