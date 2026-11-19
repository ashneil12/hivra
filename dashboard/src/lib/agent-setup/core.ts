// Setup from a coding agent: the pure parts (no I/O).
//
// A coding agent on someone's laptop reads /setup.md and either hands its person
// a Launch link with the agent preselected, or (with HIVRA_AGENT_SETUP_HANDSHAKE
// on) opens a setup request, shows its person a link and a code, and polls until
// the agent the person launched is running. The person always signs in and
// presses Launch themselves: a setup request grants nothing.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { LAUNCH_ROUTE } from "@/lib/hivra/launch-navigation";

/** The agents a coding agent may set up, in the order setup.md lists them. */
export const SETUP_AGENT_IDS = ["hermes", "claude-code", "codex", "openclaw", "agent-zero"] as const;
export type SetupAgentId = typeof SETUP_AGENT_IDS[number];

export const SETUP_AGENT_LINES: Readonly<Record<SetupAgentId, string>> = {
  hermes: "an everyday assistant that remembers, browses and runs scheduled jobs (the default)",
  "claude-code": "Anthropic's coding agent, for moving coding work to the cloud",
  codex: "OpenAI's coding agent",
  openclaw: "an assistant the person talks to from Telegram, WhatsApp, Discord or Slack",
  "agent-zero": "an agent that takes a goal, plans it and works through it",
};

export function setupAgentName(id: SetupAgentId): string {
  return getAgent(id)?.name ?? id;
}

/** How long a person has to open the link, and how long after that to launch. */
export const SETUP_OPEN_MINUTES = 30;
export const SETUP_LAUNCH_MINUTES = 120;
export const SETUP_POLL_SECONDS = 5;

export const SETUP_TOKEN_HEADER = "x-hivra-setup-token";

export const SetupRequestBody = z.object({
  agent: z.enum(SETUP_AGENT_IDS).optional(),
  inference: z.enum(["venice", "venice-key"]).optional(),
  /** The coding agent's own name, shown to the person ("Claude Code"). */
  client: z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} ._()-]+$/u).optional(),
}).strict().refine((body) => !body.inference || body.agent, {
  // Launch applies model access to a chosen agent only, so it can't be carried
  // through the agent picker.
  message: "inference needs agent",
  path: ["inference"],
});
export type SetupRequestInput = z.infer<typeof SetupRequestBody>;

// No 0/O or 1/I, so a code read aloud or retyped stays the same code.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newSetupCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** "ABCD-EFGH" for people; the stored and linked form has no dash. */
export function displaySetupCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts the code with or without the dash, any case. */
export function parseSetupCode(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").replace(/-/g, "").trim().toUpperCase();
  return /^[A-Z2-9]{8}$/.test(cleaned) ? cleaned : null;
}

export function newPollSecret(): string {
  return `hivra_setup_${randomBytes(24).toString("base64url")}`;
}

export function hashPollSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The Launch deep link: agent preselected, model access preselected if asked. */
export function setupLaunchPath(agent: SetupAgentId | null, inference: "venice" | "venice-key" | null): string {
  if (!agent) return `${LAUNCH_ROUTE}?kind=agent&start=1&ref=agent-setup`;
  const query = new URLSearchParams({ agent });
  if (inference) query.set("inference", inference);
  query.set("ref", "agent-setup");
  return `${LAUNCH_ROUTE}?${query.toString()}`;
}

export function setupApprovePath(code: string): string {
  return `/dashboard/agent-setup/${code}`;
}

export type SetupRow = {
  id: string;
  code: string;
  agent: string | null;
  inference: string | null;
  client: string | null;
  user_id: string | null;
  claimed_at: string | null;
  agent_id: string | null;
  created_at: string;
  expires_at: string;
};

export type LaunchedAgentRow = { id: string; name: string; type: string; status: string; error?: string | null };

export type SetupStatus = "waiting_for_person" | "waiting_for_launch" | "starting" | "ready" | "failed" | "expired";

export type SetupStatusBody = {
  status: SetupStatus;
  /** What to tell the person now, in one sentence. */
  message: string;
  agent?: { id: string; name: string; type: string; status: string; url: string };
  pollAgainInSeconds?: number;
};

export function claimDeadline(row: Pick<SetupRow, "claimed_at">): number | null {
  return row.claimed_at ? Date.parse(row.claimed_at) + SETUP_LAUNCH_MINUTES * 60_000 : null;
}

/**
 * Whether this person may continue the request now: it is theirs and still
 * inside its launch window. After the window the poll no longer follows a
 * launch, so continuing would only start an agent nobody tracks.
 */
export function setupClaimUsable(row: Pick<SetupRow, "user_id" | "claimed_at">, userId: string, now = Date.now()): boolean {
  const deadline = claimDeadline(row);
  return row.user_id === userId && deadline !== null && now <= deadline;
}

/** The poll answer, from the request row and the agent it found (if any). */
export function resolveSetupStatus(row: SetupRow, agent: LaunchedAgentRow | null, origin: string, now = Date.now()): SetupStatusBody {
  const again = { pollAgainInSeconds: SETUP_POLL_SECONDS };
  if (!row.claimed_at) {
    if (now > Date.parse(row.expires_at)) {
      return { status: "expired", message: "Nobody opened the setup link in time. Start a new setup request." };
    }
    return { status: "waiting_for_person", message: "Waiting for the person to open the link and sign in.", ...again };
  }
  if (!agent) {
    if (now > (claimDeadline(row) ?? 0)) {
      return { status: "expired", message: "No agent was launched from this setup. Start a new setup request if the person still wants one." };
    }
    return { status: "waiting_for_launch", message: "The person opened the link. Waiting for them to press Launch.", ...again };
  }
  const summary = {
    id: agent.id, name: agent.name, type: agent.type, status: agent.status,
    url: `${origin}/dashboard/agent/${encodeURIComponent(agent.id)}`,
  };
  if (agent.status === "running") {
    return { status: "ready", message: `${agent.name} is running. Give the person this link to open it: ${summary.url}`, agent: summary };
  }
  if (agent.status === "error") {
    return { status: "failed", message: `${agent.name} did not start. The person can open it to see why and press Try again.`, agent: summary };
  }
  return { status: "starting", message: `${agent.name} is being set up on its computer. This usually takes a few minutes.`, agent: summary, ...again };
}
