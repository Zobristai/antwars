/**
 * Public match notes: a short note shown on one named match, keyed by its lobby id. This table is the one source the
 * matches page, the replay and the public API read. A note labels a match and never changes its rating or its stored
 * record. A new note is added here by a pull request.
 */

/** Lobby id -> its public note. */
export const MATCH_NOTES: ReadonlyMap<string, string> = new Map([
  ["c0bce8df-1c3f-46c0-b6dd-1ffec3e15f82", "Self-reported scripted-play breach: one accepted command, at tick 6556"],
]);

/** The public note on the match played in this lobby; undefined when it has none. */
export const matchNote = (lobbyId: string | null | undefined): string | undefined =>
  typeof lobbyId === "string" ? MATCH_NOTES.get(lobbyId) : undefined;

/** `{ note }` for a lobby with a note, else nothing: spread into a public record so every other match reads as before. */
export const noteField = (lobbyId: string | null | undefined): { readonly note?: string } => {
  const note = matchNote(lobbyId);
  return note === undefined ? {} : { note };
};
