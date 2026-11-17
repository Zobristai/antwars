/** Both switches are opt-in. Placement changes only recorded metadata, never the winner. */
export interface FfaSettings {
  readonly liveEnabled: boolean;
  readonly territoryWinnerFirst: boolean;
}

export function ffaSettingsFromEnv(env: Readonly<Record<string, string | undefined>>): FfaSettings {
  const flag = (key: string): boolean => {
    const value = env[key];
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new Error(`${key} must be true or false`);
  };
  return { liveEnabled: flag("ANTWAR_FFA_RATING_ENABLED"), territoryWinnerFirst: flag("ANTWAR_FFA_TERRITORY_WINNER_FIRST") };
}
