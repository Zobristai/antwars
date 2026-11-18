/** The live Free-for-all rating switch is opt-in. A recorded finish always places an early territory winner first. */
export interface FfaSettings {
  readonly liveEnabled: boolean;
}

export function ffaSettingsFromEnv(env: Readonly<Record<string, string | undefined>>): FfaSettings {
  const flag = (key: string): boolean => {
    const value = env[key];
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new Error(`${key} must be true or false`);
  };
  return { liveEnabled: flag("ANTWAR_FFA_RATING_ENABLED") };
}
