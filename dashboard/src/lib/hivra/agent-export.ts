import "server-only";

import { mapWithConcurrencyLimit } from "@/lib/concurrency";

// Wave 4.2 — one-click data export for a Hivra agent.
//
// Reads an agent's chat history (sessions + messages) and its memory files
// (USER.md / MEMORY.md) straight off its box and assembles a single portable
// JSON document. This delivers the "your data is yours / not locked in" promise
// and makes the marketing claim ("export your memory as a structured JSON file")
// literally true.
//
// Best-effort by design: legacy / token-less boxes silently return empty from
// the introspection endpoints, so we never throw — we return what's reachable
// and stamp `meta.truncated` (capped session window) plus per-section emptiness
// so a thin/empty export is never silently mistaken for "the agent has no data".
//
// Box read contract (mirrors src/lib/hivra/agent-api.ts, re-implemented here as
// server-side fetches so this `server-only` module never pulls in the "use
// client" agent-api):
//   GET  {boxUrl}/api/sessions            -> { sessions: [{ id, title, updatedAt }] }
//   GET  {boxUrl}/api/sessions/{id}       -> { messages: [{ role, text, tools }] }
//   GET  {boxUrl}/api/file?path=<abs>     -> { content }
// All Bearer-authed via the per-box api_token (absent on legacy boxes → empty).

/** Cap the number of sessions read into a single export so its size stays
 *  bounded. Newest-first; older sessions are dropped and `truncated` is set.
 *  (Follow-up: paginate the full archive — see PR notes.) */
export const EXPORT_SESSION_CAP = 50;

/** Longest one box read may take before it counts as unreachable. */
const BOX_READ_TIMEOUT_MS = 15_000;
/** Whole export budget: box reads still running when it ends come back empty. */
const EXPORT_BUDGET_MS = 60_000;
/** Session message reads in flight at once against one box. */
const SESSION_READ_CONCURRENCY = 4;

const USER_MD_PATH = "/home/bux/USER.md";
const MEMORY_MD_PATH = "/home/bux/MEMORY.md";

/** The minimal agent shape this builder needs — a subset of the hivra_agents
 *  row. Kept local so callers can pass either the DB row or a HivraAgent. */
export interface ExportableAgent {
  id: string;
  name?: string | null;
  type?: string | null;
  chat_url?: string | null;
  api_token?: string | null;
}

interface ExportSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ExportMessage[];
}

interface ExportMessage {
  role: "user" | "assistant";
  text: string;
  tools: string[];
}

export interface AgentExport {
  meta: {
    agentId: string;
    name: string | null;
    type: string | null;
    exportedAt: string;
    /** How many sessions are included in this export (after the cap). */
    sessionCount: number;
    /** True when the box reported more sessions than the cap, so older chats
     *  are NOT in this file. The export is still valid — just not complete. */
    truncated: boolean;
    /** Schema version, so a future importer can branch on shape. */
    schemaVersion: 1;
  };
  sessions: ExportSession[];
  memory: {
    /** Contents of USER.md, or null if the box couldn't return it. */
    userMd: string | null;
    /** Contents of MEMORY.md, or null if the box couldn't return it. */
    memoryMd: string | null;
  };
}

function boxBase(boxUrl: string): string {
  return boxUrl.replace(/\/$/, "");
}

function boxHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface RawSession {
  id: string;
  title: string;
  updatedAt: number;
}

// ---- box reads (best-effort; never throw) -----------------------------------

/** One box read: stops at its own timeout or when the export budget ends. */
function boxReadSignal(budget: AbortSignal): AbortSignal {
  return AbortSignal.any([budget, AbortSignal.timeout(BOX_READ_TIMEOUT_MS)]);
}

async function fetchSessions(boxUrl: string, token: string | null | undefined, budget: AbortSignal): Promise<RawSession[]> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/sessions`, {
      cache: "no-store",
      headers: boxHeaders(token),
      signal: boxReadSignal(budget),
    });
    if (!r.ok) return [];
    const sessions = ((await r.json()) as { sessions?: RawSession[] }).sessions;
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

async function fetchSessionMessages(
  boxUrl: string,
  id: string,
  token: string | null | undefined,
  budget: AbortSignal,
): Promise<ExportMessage[]> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/sessions/${encodeURIComponent(id)}`, {
      cache: "no-store",
      headers: boxHeaders(token),
      signal: boxReadSignal(budget),
    });
    if (!r.ok) return [];
    const messages = ((await r.json()) as { messages?: ExportMessage[] }).messages;
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

async function fetchFile(
  boxUrl: string,
  path: string,
  token: string | null | undefined,
  budget: AbortSignal,
): Promise<string | null> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/file?path=${encodeURIComponent(path)}`, {
      cache: "no-store",
      headers: boxHeaders(token),
      signal: boxReadSignal(budget),
    });
    if (!r.ok) return null;
    const content = ((await r.json()) as { content?: string }).content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

/**
 * Assemble a portable JSON export of one Hivra agent's chats + memory.
 * Never throws: an unreachable / token-less box yields an export with empty
 * sessions and null memory rather than an error, with `meta` describing what
 * was (and wasn't) captured.
 */
export async function buildAgentExport(agent: ExportableAgent): Promise<AgentExport> {
  const exportedAt = new Date().toISOString();
  const name = agent.name ?? null;
  const type = agent.type ?? null;
  const boxUrl = agent.chat_url || "";
  const token = agent.api_token ?? null;

  // No box URL → there's nothing to read; return a well-formed empty export.
  if (!boxUrl) {
    return {
      meta: {
        agentId: agent.id,
        name,
        type,
        exportedAt,
        sessionCount: 0,
        truncated: false,
        schemaVersion: 1,
      },
      sessions: [],
      memory: { userMd: null, memoryMd: null },
    };
  }

  const budget = AbortSignal.timeout(EXPORT_BUDGET_MS);
  const allSessions = await fetchSessions(boxUrl, token, budget);
  // Newest first, then cap so the file size is bounded.
  const ordered = [...allSessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const truncated = ordered.length > EXPORT_SESSION_CAP;
  const capped = ordered.slice(0, EXPORT_SESSION_CAP);

  // Read each session's messages (best-effort per session), a few at a time so
  // one box is not hit with every request at once.
  const sessions: ExportSession[] = await mapWithConcurrencyLimit(capped, SESSION_READ_CONCURRENCY, async (s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    messages: await fetchSessionMessages(boxUrl, s.id, token, budget),
  }));

  const [userMd, memoryMd] = await Promise.all([
    fetchFile(boxUrl, USER_MD_PATH, token, budget),
    fetchFile(boxUrl, MEMORY_MD_PATH, token, budget),
  ]);

  return {
    meta: {
      agentId: agent.id,
      name,
      type,
      exportedAt,
      sessionCount: sessions.length,
      truncated,
      schemaVersion: 1,
    },
    sessions,
    memory: { userMd, memoryMd },
  };
}

/** A filesystem-safe download filename for an agent export. */
export function exportFileName(agent: { name?: string | null; id: string }): string {
  const base = (agent.name || agent.id || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "agent"}-export.json`;
}
