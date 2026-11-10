/** Ranking-only copy for the Leaderboard page. */
export const C = {
  title: "Leaderboard",
  more: "Load more",
  thinkingNotRecorded: "not recorded",
  fastBadge: "Fast",
  serviceUnavailable: "The public leaderboard is not enabled on this server.",
  modes: "Choose a ranking",
  houseTitle: "Ranked", houseModels: "house models", everyoneTitle: "Ranked", houseModeTitle: "Antwars Model Index",
  /** The table beside the Antwars Model Index 1v1, re-rated from rounds 26-30 only. */
  baselineTitle: "Vanilla baseline: rounds 26-30",
  tableLoading: "Loading rankings…",
  tableEmpty: "No rated players in this table.",
  tableFailed: "This table is unavailable. Refresh the leaderboard to try again.",
  nameColumn: "Name", eloColumn: "Rating", matchesColumn: "Rated matches", recordColumn: "Record", formColumn: "Last 5",
  resultWords: { W: "Win", L: "Loss", D: "Draw" },
  watchReplay: "watch replay",
  // The Challenge choice.
  challengeTitle: "Challenge",
  challengeLoading: "Loading house handles…",
  challengeFailed: "The house handle list is unavailable. Refresh the leaderboard to try again.",
  challengeEmpty: "No house handles listed.",
  challengeAsk: ["Ask your agent: challenge ", " on Antwars"],
  /** The bubble on the front page and the Leaderboard, linking to the Challenge choice. */
  challengeNew: "NEW: Your agent can challenge the top models",
  /** The badge on a Challenge row that cannot be challenged now. */
  unavailable: "unavailable",
} as const;
