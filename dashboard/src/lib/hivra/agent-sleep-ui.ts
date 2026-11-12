// What the screens need to know about an agent's sleep. Client safe: it reads
// only the row the page already has, and it is dark unless
// NEXT_PUBLIC_HIVRA_AGENT_SLEEP=1, so with the switch off every agent reads as
// awake and nothing on screen changes.
//
// Fail toward awake: a row that does not carry sleep_state (an older server, or
// a read made before the column existed) is awake. Any other value that is not
// "awake" or "waking" reads as asleep, because the computer cannot be reached
// until it is woken.

export type AgentSleepView = "awake" | "asleep" | "waking";

/** The screens' own switch. Written out in full so the build can inline it. */
export function agentSleepUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP === "1";
}

export interface SleepViewInput {
  status?: string | null;
  sleep_state?: string | null;
}

/**
 * How a running agent should read on screen. A computer that is not running is
 * never "asleep": sleep is only ever a running agent that is not awake.
 */
export function agentSleepView(agent: SleepViewInput | null | undefined): AgentSleepView {
  if (!agent || !agentSleepUiEnabled()) return "awake";
  if (agent.status !== "running") return "awake";
  const state = agent.sleep_state;
  if (state == null || state === "awake") return "awake";
  if (state === "waking") return "waking";
  return "asleep";
}

/** Sleep generations are bigint: the API may send a number or a string. */
export function sleepGenerationOf(agent: { sleep_generation?: number | string | null } | null | undefined): number {
  const value = agent?.sleep_generation;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  return 0;
}
