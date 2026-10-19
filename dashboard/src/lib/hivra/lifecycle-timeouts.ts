// How long the host work behind an agent's in-place update may take, in one
// place: the update itself uses these, and the automatic-update cron budgets
// around them so an update it starts always ends inside its function's limit.

/** One host readiness check (Hivra Cloud or My server) before the update runs. */
export const HOST_READINESS_TIMEOUT_MS = 20_000;

/**
 * The in-place runtime update's host script. It runs synchronously inside its
 * request, so it is bounded below the route's maxDuration: a stalled guest
 * yields a recorded unknown outcome for the reconciler instead of a killed
 * function with nothing saved.
 */
export const RUNTIME_UPDATE_TIMEOUT_MS = 240_000;

/**
 * One read of an agent's computer (its software meta, or whether it is idle),
 * every request of it together. The automatic-update cron budgets its reads
 * around this as well.
 */
export const AGENT_COMPUTER_READ_TIMEOUT_MS = 8_000;
