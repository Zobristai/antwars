import { expect, it } from "vitest";
import { ffaSettingsFromEnv } from "../../src/rating/ffaSettings.ts";

it("ships the live rating switch off and accepts only explicit boolean settings", () => {
  expect(ffaSettingsFromEnv({})).toEqual({ liveEnabled: false });
  expect(ffaSettingsFromEnv({ ANTWAR_FFA_RATING_ENABLED: "false" })).toEqual({ liveEnabled: false });
  expect(ffaSettingsFromEnv({ ANTWAR_FFA_RATING_ENABLED: "true" })).toEqual({ liveEnabled: true });
  for (const value of ["1", "yes", "", "TRUE"]) expect(() => ffaSettingsFromEnv({ ANTWAR_FFA_RATING_ENABLED: value })).toThrow("ANTWAR_FFA_RATING_ENABLED");
});
