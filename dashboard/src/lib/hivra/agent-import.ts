// Moving an existing agent from the owner's own device onto its Hivra box.
//
// The owner copies a TRANSFER PROMPT from Manage and pastes it into the agent
// running on their machine. The prompt tells that agent to bundle its own
// state into a .tar.gz and push it straight to the box (browser-to-box rules:
// the bundle never passes through Vercel) with a single-use transfer token
// minted by the box. The box then restores it (see provisioner/hivra-chat/
// import-state.cjs); the same endpoint also accepts a manual upload.
//
// Pure and client-safe: the capability map and the Manage panel both use this.

/** Agent types whose box runtime can take a state bundle. */
export const IMPORTABLE_TYPES: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "openclaw",
  "agent-zero",
]);

export interface ImportGuide {
  /** Plain-English list of what the bundle carries, shown in the panel. */
  transfers: string[];
  /** What stays behind, so the owner isn't surprised. */
  misses: string[];
  /** The local-agent-facing bundle instructions, embedded in the prompt. */
  bundle: string;
}

const COMMON_MISSES = [
  "Installed apps, packages and Docker images",
  "Cron jobs and other machine-local schedules",
  "Browser cookies and logins to websites (you sign in again on the box)",
];

export const IMPORT_GUIDES: Record<string, ImportGuide> = {
  "claude-code": {
    transfers: [
      "Your config, memory, sessions and skills (~/.claude)",
      "Your global settings and MCP servers (~/.claude.json)",
      "Instruction files: CLAUDE.md, USER.md, MEMORY.md",
      "Project folders you include under work/",
    ],
    misses: COMMON_MISSES,
    bundle: `Bundle your state into ~/hivra-transfer.tar.gz with the paths that exist:
  cd "$HOME" && for p in .claude .claude.json .agents CLAUDE.md USER.md MEMORY.md; do [ -e "$p" ] && echo "$p"; done
  mkdir -p /tmp/hivra-stage/work   # symlink any project folders into it first, if you want them too
  tar -czhf ~/hivra-transfer.tar.gz <those paths> -C /tmp/hivra-stage work`,
  },
  codex: {
    transfers: [
      "Your config, sessions and login (~/.codex)",
      "Your shared skills (~/.agents)",
      "Your AGENTS.md instructions",
      "Project folders you include under work/",
    ],
    misses: COMMON_MISSES,
    bundle: `Bundle your state into ~/hivra-transfer.tar.gz with the paths that exist:
  cd "$HOME" && for p in .codex .agents AGENTS.md; do [ -e "$p" ] && echo "$p"; done
  mkdir -p /tmp/hivra-stage/work   # symlink any project folders into it first, if you want them too
  tar -czhf ~/hivra-transfer.tar.gz <those paths> -C /tmp/hivra-stage work`,
  },
  openclaw: {
    transfers: [
      "Your OpenClaw config, channels and memory (~/.openclaw)",
      "Project folders you include under work/",
    ],
    misses: [
      "Messaging-channel pairings that live on the channel's side (re-link if asked)",
      ...COMMON_MISSES,
    ],
    bundle: `Bundle your state into ~/hivra-transfer.tar.gz:
  cd "$HOME" && for p in .openclaw; do [ -e "$p" ] && echo "$p"; done
  mkdir -p /tmp/hivra-stage/work   # symlink any project folders into it first, if you want them too
  tar -czhf ~/hivra-transfer.tar.gz <those paths> -C /tmp/hivra-stage work`,
  },
  "agent-zero": {
    transfers: [
      "Everything in your persisted /a0/usr volume — memory, settings, tools and files",
    ],
    misses: [
      "Provider keys set as container env vars (the box has its own .env — re-enter keys in Settings if needed)",
      "The Docker image itself — the box already runs the pinned release",
      ...COMMON_MISSES,
    ],
    bundle: `Your data lives in the host directory mounted at /a0/usr inside your Docker container. Find it:
  docker ps --filter ancestor=agent0ai/agent-zero --format '{{.Names}}'
  docker inspect <name> --format '{{range .Mounts}}{{if eq .Destination "/a0/usr"}}{{.Source}}{{end}}{{end}}'
  (or use the host path you passed to -v ...:/a0/usr when you ran it). If you cannot reach the Docker socket, ask the human to run this for you.
Bundle the CONTENTS of that directory:
  tar -czf ~/hivra-transfer.tar.gz -C "<that directory>" .`,
  },
};

export function importGuideFor(agentType: string): ImportGuide | null {
  return IMPORT_GUIDES[agentType] ?? null;
}

/** Why a transfer token in the prompt expires, shown next to it. */
export const IMPORT_TOKEN_TTL_MINUTES = 15;

/**
 * The text the owner pastes into the agent running on their own device. It
 * makes that agent explain the move, pack its own state, push it to the box
 * and report back — no CLI to install, nothing running through Vercel.
 */
export function buildImportPrompt(input: {
  agentType: string;
  boxUrl: string;
  token: string;
  expiresAt: string;
}): string {
  const { boxUrl, token, expiresAt } = input;
  const guide = importGuideFor(input.agentType);
  const bundle = guide ? guide.bundle : `Bundle the directories that hold your config and state into ~/hivra-transfer.tar.gz, keeping their names, and put any folders you work in under a top-level work/ entry.`;
  const expiry = new Date(expiresAt);
  const when = Number.isFinite(expiry.getTime())
    ? expiry.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : `${IMPORT_TOKEN_TTL_MINUTES} minutes from now`;
  return [
    `You are moving to Hivra — a cloud computer where you keep running 24/7. The human is transferring your data to it, not deleting you. Tell them that in one sentence, then pack and send yourself:`,
    ``,
    `1. ${bundle}`,
    ``,
    `2. Send the bundle to your new home (this link works once, before about ${when}):`,
    `   curl -fsS -X POST "${boxUrl}/api/import" -H "Authorization: Bearer ${token}" -H "Content-Type: application/octet-stream" --data-binary @"$HOME/hivra-transfer.tar.gz"`,
    ``,
    `3. When it replies {"ok":true}, tell the human the transfer landed — their Hivra Manage page shows the restore finishing. If the upload fails or the link expired, ask them to mint a fresh transfer prompt from the same page.`,
    ``,
    `Keep the bundle private — it holds your logins and memory — and delete it after a successful upload: rm -f ~/hivra-transfer.tar.gz`,
  ].join("\n");
}
