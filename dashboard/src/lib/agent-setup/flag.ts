// Off-by-default switch for the setup handshake (POST /api/agent-setup, the poll,
// and the /dashboard/agent-setup/<code> page). Server-only, read per request so
// Canary can turn it on without a rebuild. With it off, /setup.md still teaches
// coding agents the plain Launch link, which needs nothing new on the server.

export function agentSetupHandshakeEnabled(value: string | undefined = process.env.HIVRA_AGENT_SETUP_HANDSHAKE): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
