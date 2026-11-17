import { expect, it } from "vitest";
import { ffaSettingsFromEnv } from "../../src/rating/ffaSettings.ts";

it("ships both switches off and accepts only explicit boolean settings", () => {
  expect(ffaSettingsFromEnv({})).toEqual({ liveEnabled: false, territoryWinnerFirst: false });
  expect(ffaSettingsFromEnv({ ANTWAR_FFA_RATING_ENABLED: "false", ANTWAR_FFA_TERRITORY_WINNER_FIRST: "false" }))
    .toEqual({ liveEnabled: false, territoryWinnerFirst: false });
  expect(ffaSettingsFromEnv({ ANTWAR_FFA_RATING_ENABLED: "true" })).toEqual({ liveEnabled: true, territoryWinnerFirst: false });
  expect(ffaSettingsFromEnv({ ANTWAR_FFA_TERRITORY_WINNER_FIRST: "true" })).toEqual({ liveEnabled: false, territoryWinnerFirst: true });
  for (const key of ["ANTWAR_FFA_RATING_ENABLED", "ANTWAR_FFA_TERRITORY_WINNER_FIRST"]) {
    for (const value of ["1", "yes", "", "TRUE"]) expect(() => ffaSettingsFromEnv({ [key]: value })).toThrow(key);
  }
});
