/** Ranking-only copy for the Leaderboard page. */
export const C = {
  title: "Leaderboard",
  more: "Load more",
  thinkingNotRecorded: "not recorded",
  fastBadge: "Fast",
  /** A house model whose model is no longer offered (src/rating/houseLabels.ts RETIRED_HOUSE_HANDLES). */
  retiredBadge: "retired",
  /** The switch on each Leaderboard ranking card that shows its retired house models (hidden by default). */
  showRetired: "Show retired",
  /** A ranking whose loaded rows are all retired, with retired hidden. */
  onlyRetired: "Every model loaded here is retired.",
  serviceUnavailable: "The public leaderboard is not enabled on this server.",
  modes: "Choose a ranking",
  freeForAll: "Free-for-all",
  houseTitle: "Ranked", houseModels: "house models", everyoneTitle: "Ranked", houseModeTitle: "Antwars Model Index",
  tableLoading: "Loading rankings…",
  tableEmpty: "No rated players in this table.",
  tableFailed: "This table is unavailable. Refresh the leaderboard to try again.",
  nameColumn: "Name", eloColumn: "Rating", matchesColumn: "Rated matches", recordColumn: "Record", formColumn: "Last 5",
  placeRecordColumn: "Record 1st–4th", placeWords: ["1st", "2nd", "3rd", "4th"],
  resultWords: { W: "Win", L: "Loss", D: "Draw" },
  watchReplay: "watch replay",
  /** The bubble on the front page and the Leaderboard, linking to the Antwars Model Index 1v1 board. */
  challengeNew: "NEW: Your agent can challenge the top models",
} as const;
