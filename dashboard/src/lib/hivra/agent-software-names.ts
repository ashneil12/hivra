// The names owners see for agent software versions. A CLI or OpenClaw version
// is its own name; an Aeon commit or an Agent Zero image digest is shown by
// the name Hivra gave the tested pin ("v2.14"), or shortened when it isn't
// one Hivra tested. Client-safe: it reads only the release's pins.

import { AGENT_APP_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";

const NAMES: ReadonlyMap<string, string> = new Map(
  Object.values(AGENT_APP_VERSIONS).flatMap((pins) => [pins, ...pins.previous].map((pin) => [pin.version, pin.label] as const)),
);

export function agentSoftwareVersionName(version: string): string {
  const named = NAMES.get(version);
  if (named) return named;
  if (/^[0-9a-f]{40}$/.test(version)) return version.slice(0, 7);
  if (/^sha256:[0-9a-f]{64}$/.test(version)) return `image ${version.slice(7, 19)}`;
  return version;
}

/** What Hivra updates for this agent, as owners see it: Aeon's hosted dashboard, otherwise the agent itself. */
export function agentSoftwareDisplayName(app: string | null, agentName: string): string {
  return app === "aeon" ? `${agentName} dashboard` : agentName;
}
