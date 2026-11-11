/**
 * r96 (Critiquito, c02 BLIND 6968): a step's row showed the raw command it ran ("git diff --stat && echo '---' && git
 * diff -- packages/ui …", "node -e \"", "rg -n --heading 'BoardTally|…' packages/ui; npm test",
 * "mcp__ash-os__ash_remember"). Rows read in plain words: "Look at the changes", "Run a script", "Search the code, then
 * run the tests", "Remember". The full command stays behind the row (its title and detail). A command we can't put
 * into words is left as it was, so nothing is guessed.
 */
const MCP = /^mcp__[A-Za-z0-9-]+__([A-Za-z0-9_]+)$/;

const MCP_WORDS: Record<string, string> = {
  ash_remember: "Remember",
  ash_recall: "Look it up in memory",
  ash_forget: "Forget",
};

/** One simple command (no &&, ;, |) in plain words, "" for one that says nothing (cd, echo), undefined if unknown. */
function plainPart(part: string): string | undefined {
  const words = part.trim().split(/\s+/);
  const [cmd, sub] = words;
  if (!cmd) return "";
  switch (cmd) {
    case "cd":
    case "echo":
    case "printf":
    case "true":
      return "";
    case "git":
      if (sub === "diff" || sub === "status") return "Look at the changes";
      if (sub === "log" || sub === "show") return "Read the history";
      return undefined;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (sub === "test" || sub === "t" || (sub === "run" && /^test\b/.test(words[2] ?? ""))) return "Run the tests";
      if (sub === "run" && words[2]) return `Run ${words[2]}`;
      if (sub === "install" || sub === "i" || sub === "ci") return "Install packages";
      return undefined;
    case "npx":
      if (sub === "vitest" || sub === "jest" || sub === "mocha") return "Run the tests";
      if (sub === "tsc") return "Check the types";
      return undefined;
    case "node":
    case "python":
    case "python3":
    case "deno":
      return words.includes("-e") || words.includes("-c") || words.includes("--eval") ? "Run a script" : undefined;
    case "rg":
    case "grep":
      return words.includes("--files") ? "Search the project's files" : "Search the code";
    case "cat":
    case "head":
    case "tail":
    case "sed":
    case "wc":
      return "Read files";
    case "ls":
    case "find":
    case "tree":
      return "List files";
    default:
      return undefined;
  }
}

const SHELL_START = /^(?:cd|echo|printf|git|npm|pnpm|yarn|bun|npx|node|python3?|deno|rg|grep|cat|head|tail|sed|wc|ls|find|tree)\b/;

/** A row's label in plain words when it is a raw command or a raw MCP tool name; anything else as it was. */
export function plainCommandRow(label: string): string {
  const text = label.trim();
  const mcp = MCP.exec(text);
  if (mcp) return MCP_WORDS[mcp[1]] ?? label;
  if (!SHELL_START.test(text)) return label;
  // An unfinished quote (a cut multi-line script, "node -e \"") still names its command.
  // Split on && || ; and |, keeping which one came before each part.
  const pieces = text
    .split("\n")[0]
    .replace(/'[^']*'|"[^"]*"/g, "''")
    .replace(/2>&1|>\s*\/dev\/null/g, " ")
    .split(/(&&|\|\||;|\|)/);
  const said: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const part = pieces[i];
    // What a pipe feeds into (| tail -20, | grep x) only trims the output: it adds nothing to say.
    if (pieces[i - 1] === "|") continue;
    const words = plainPart(part.replace(/^\s*\(+|\)+\s*$/g, ""));
    if (words === undefined) return label;
    if (words && !said.includes(words)) said.push(words);
  }
  if (!said.length) return label;
  return said.map((w, i) => (i ? w.charAt(0).toLowerCase() + w.slice(1) : w)).join(", then ");
}
