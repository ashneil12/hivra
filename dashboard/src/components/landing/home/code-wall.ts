// Real source lines from the public repository
// (dashboard/src/lib/hivra/launch-navigation.ts), shown as decoration behind
// the open-source card. Copied, not generated.
export const CODE_WALL: readonly string[] = [
  "const PORTABLE_AGENT_LAUNCH_IDS = [",
  "  \"claude-code\",",
  "  \"codex\",",
  "  \"aeon\",",
  "  \"openclaw\",",
  "  \"agent-zero\",",
  "] as const;",
  "",
  "export function isPortableAgentLaunchId(",
  "  value: string | null | undefined,",
  "): value is PortableAgentLaunchId {",
  "  return Boolean(value && PORTABLE_AGENT_LAUNCH_ID_SET.has(value));",
  "}",
  "",
  "export function parsePortableLaunchResourceId(",
  "  value: string | null | undefined,",
  "): PortableLaunchResourceId | null {",
  "  if (value === \"linux-desktop\" || value === \"linux-terminal\" || value === \"windows\") return",
  "  return isPortableAgentLaunchId(value) ? value : null;",
  "}",
  "",
  "",
  "export const LAUNCH_ROUTE = \"/dashboard/launch\";",
  ""
];
