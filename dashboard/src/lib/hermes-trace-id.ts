/**
 * Trace-id wiring for the chat-send pipeline. The header rides every
 * hop — browser SW → dashboard Vercel functions → Caddy on the agent
 * host → agent backend — so a single grep across logs reconstructs
 * the entire chain. Without it, debugging a chat failure today means
 * cross-referencing browser DevTools, Vercel function logs, Caddy
 * access.log on the agent host, and the agent's own logs by timestamp
 * alone, which is exactly the slog that took 8+ hours on 2026-04-30.
 *
 * Format: a v4 UUID. Treated as opaque — never parsed for meaning,
 * only used as a correlation key. Capped at 64 chars when accepted
 * from the wire so a malicious client can't blow up downstream log
 * lines.
 */

export const HERMES_TRACE_ID_HEADER = "x-hermes-trace-id";

const TRACE_ID_MAX_LENGTH = 64;
const TRACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Generate a fresh trace id. Uses crypto.randomUUID when available
 * (everywhere modern: browsers in secure contexts, Node 19+, Workers,
 * Service Workers), falls back to a randomness-shaped string only
 * when crypto isn't available (some legacy/insecure-context cases).
 * The fallback is ONLY for correlation, so it doesn't need to be
 * cryptographically strong — it just needs to be unique enough that
 * two concurrent sends don't collide.
 */
export function generateHermesTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `t-${ts}-${rand}`;
}

/**
 * Pull a trace id off a request's headers, validating shape so it
 * can flow safely into log lines and downstream sub-requests. Returns
 * null when missing or malformed — callers should generate a fresh
 * one in that case so every server-side handler still has a trace
 * even when the client forgot.
 */
export function readHermesTraceId(headers: Headers | { get(name: string): string | null }): string | null {
  const raw = headers.get(HERMES_TRACE_ID_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > TRACE_ID_MAX_LENGTH) return null;
  if (!TRACE_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Read-or-generate. Use this at every server-side entry point so
 * downstream logs and sub-requests always have a trace id to
 * propagate, even when the client didn't send one.
 */
export function ensureHermesTraceId(headers: Headers | { get(name: string): string | null }): string {
  return readHermesTraceId(headers) ?? generateHermesTraceId();
}
