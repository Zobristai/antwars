/**
 * Re-exports only: House ownership lives in src/identity/houseOwnership.ts and the House label
 * table in src/rating/houseLabels.ts. This path keeps its earlier exports for importers that still name it,
 * among them src/lobby/challenges.ts (HOUSE_LABELS, HOUSE_USERNAME). It defines nothing.
 */
export { HOUSE_USERNAME, houseOwnedAmong, isHouseOwned } from "../identity/houseOwnership.js";
export { HOUSE_LABELS, houseDisplayName, houseLabel, type HouseLabel } from "./houseLabels.js";
