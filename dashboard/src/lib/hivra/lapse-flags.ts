/**
 * Switch for stopping Hivra computers whose owner no longer pays.
 *
 * Off unless the variable is exactly "true", the same rule as
 * DUNNING_GRACE_ENFORCE_LIVE (lib/recovery/dunning-grace-enforce.ts). While it is
 * off, the sweep only logs what it would stop and the Start check lets everything
 * through, so merging the code changes nothing for a customer until it is turned on.
 */
export function isHivraLapseEnforceLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HIVRA_LAPSE_ENFORCE_LIVE === "true";
}
