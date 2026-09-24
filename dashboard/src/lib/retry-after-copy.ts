/** "You can try again in 12 minutes." from a wait in seconds, rounded up to
 * whole minutes so the owner never retries a moment too early. Safe for
 * server and browser code. */
export function tryAgainInMinutes(seconds: number): string {
  const minutes = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds / 60)) : 1;
  return `You can try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
