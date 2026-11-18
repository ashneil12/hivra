// The names owners see for agent software versions. A CLI or OpenClaw version
// is its own name; an Aeon commit or an Agent Zero image digest is shortened.
// Client-safe.

export function agentSoftwareVersionName(version: string): string {
  if (/^[0-9a-f]{40}$/.test(version)) return version.slice(0, 7);
  if (/^sha256:[0-9a-f]{64}$/.test(version)) return `image ${version.slice(7, 19)}`;
  return version;
}
/** What Hivra updates for this agent, as owners see it: Aeon's hosted dashboard, otherwise the agent itself. */
export function agentSoftwareDisplayName(app: string | null, agentName: string): string {
  return app === "aeon" ? `${agentName} dashboard` : agentName;
}
