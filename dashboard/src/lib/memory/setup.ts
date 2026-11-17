// The copy-paste setup a person needs to give an agent their Hivra Memory.
// Pure text so the dashboard page and its tests agree on every character.

export const MEMORY_KEY_PLACEHOLDER = "YOUR_MEMORY_KEY";

/**
 * Agents with a memory of their own skip a tool nobody told them to use, so
 * the instruction block is part of setup, not an extra.
 */
export const MEMORY_INSTRUCTIONS = `## Memory

Your long-term memory is the \`memory\` MCP server. It outlives every session,
model and agent, and my other agents share it. Use it instead of any built-in
or file memory.

- At startup (mandatory): call \`wake\` before any other tool, in every session, and read all of it.
- While working (mandatory): call \`remember\` whenever you learn something that will matter later or I correct something. One memory per call. When it updates an older memory, pass \`replaces\` with that memory's number from the view; nothing is replaced unless you name it.
- If a reply contains \`merges\`, do that upkeep with \`summarize\` before your next action.
- \`recall\` searches; \`zoom\` opens a summary line.
`;

export interface MemorySetupOption {
  id: "claude-code" | "codex" | "json" | "http";
  label: string;
  /** One line on where the text goes. */
  where: string;
  code: string;
  /** Where the instruction block goes for this agent, when it reads one. */
  instructionsFile?: string;
}

export function memoryMcpUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/mcp`;
}

export function memorySetupOptions(endpoint: string, key: string = MEMORY_KEY_PLACEHOLDER): MemorySetupOption[] {
  const base = endpoint.replace(/\/+$/, "");
  const mcp = memoryMcpUrl(base);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      where: "Run this once in a terminal.",
      code: `claude mcp add --transport http --scope user memory ${mcp} --header "Authorization: Bearer ${key}"`,
      instructionsFile: "~/.claude/CLAUDE.md",
    },
    {
      id: "codex",
      label: "Codex",
      where: "Add this to ~/.codex/config.toml, and set HIVRA_MEMORY_KEY in your shell.",
      code: `[mcp_servers.memory]\nurl = "${mcp}"\nbearer_token_env_var = "HIVRA_MEMORY_KEY"\n\n# in your shell profile\nexport HIVRA_MEMORY_KEY="${key}"`,
      instructionsFile: "~/.codex/AGENTS.md",
    },
    {
      id: "json",
      label: "Cursor and other MCP apps",
      where: "Add this to the app's MCP settings file.",
      code: JSON.stringify({ mcpServers: { memory: { url: mcp, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
      instructionsFile: "the agent's rules or AGENTS.md file",
    },
    {
      id: "http",
      label: "Any script",
      where: "Plain HTTPS, for anything that cannot use MCP.",
      code: `curl -X POST ${base}/v1/remember \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "content-type: application/json" \\\n  -d '{"items":[{"text":"I prefer short answers."}]}'\n\ncurl -X POST ${base}/v1/recall \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "content-type: application/json" \\\n  -d '{"query":"how do I like answers?"}'`,
    },
  ];
}
