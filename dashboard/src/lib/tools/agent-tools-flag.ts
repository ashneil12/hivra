// Off-by-default switch for the agent tools added in November 2026 (agent picker, running-cost
// calculator, model finder, job library, bot connect wizard, security check, SOUL.md builder).
// Client-safe: the NEXT_PUBLIC value is inlined at build time, so read it by its literal name.

export function isAgentToolsEnabled(value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_AGENT_TOOLS_ENABLED): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
