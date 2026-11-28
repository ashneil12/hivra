/**
 * Lite cloud agents: a light, always-available agent that lives in Cloudflare
 * Durable Objects instead of on a computer. It sleeps (and costs nothing) until
 * a message arrives, wakes, asks a model, writes the reply and sleeps again.
 *
 * - LiteAccount (one per Hivra account, named by the account id): which agents
 *   the account owns, and how many free messages it has used today.
 * - LiteAgent (one per agent, named by a random id): the agent's name and
 *   personality, its memory notes, its chat sessions and their messages, all in
 *   the object's own SQLite database.
 *
 * Only Hivra's server calls this Worker. Each request carries the account id and
 * an HMAC over the method, path, account, time and body, keyed with
 * LITE_AGENT_SECRET, so a browser or a guessed agent id gets nowhere.
 *
 * Models are any OpenAI-compatible chat endpoints, tried in order (LITE_MODELS).
 * An agent can instead use the owner's own key, which spends no free allowance.
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
  LITE_AGENT: DurableObjectNamespace<LiteAgent>;
  LITE_ACCOUNT: DurableObjectNamespace<LiteAccount>;
  LITE_AGENT_SECRET?: string;
  LITE_MODELS?: string;
  LITE_MAX_AGENTS?: string;
  LITE_MAX_SESSIONS?: string;
  LITE_DAILY_MESSAGES?: string;
  [secret: string]: unknown;
}

const MIN_SECRET_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 8000;
const MAX_MANAGED_QA_MESSAGE_CHARS = 1000;
const MANAGED_QA_CALLBACK = "https://canary.hermesos.cloud/api/internal/lite-managed-qa";
const MANAGED_QA_SIGNATURE_VERSION = "lite-managed-qa|v1";
const MAX_NAME_CHARS = 60;
const MAX_PERSONA_CHARS = 4000;
const MAX_NOTES = 100;
const MAX_NOTE_CHARS = 500;
const HISTORY_MESSAGES = 30;
const MAX_TOOL_ROUNDS = 3;
const MODEL_TIMEOUT_MS = 60_000;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const encoder = new TextEncoder();

// ── Small helpers ───────────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    // Errors cross the Durable Object RPC boundary as plain Errors that keep only
    // their message, so the status and details ride inside it.
    super(`lite-http:${JSON.stringify({ status, code, extra })}`);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function intSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function cleanText(value: unknown, max: number, field: string, { required = true } = {}): string {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field}_required`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, `${field}_invalid`);
  const text = value.trim();
  if (required && !text) throw new HttpError(400, `${field}_required`);
  if (text.length > max) throw new HttpError(400, `${field}_too_long`, { max });
  return text;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ── Models ──────────────────────────────────────────────────────────────────

export interface ModelProvider {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** The configured fallback chain, dropping entries whose key secret is missing. */
export function configuredModels(env: Env): ModelProvider[] {
  let raw: unknown;
  try {
    raw = JSON.parse(env.LITE_MODELS || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ModelProvider[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, baseUrl, model, keySecret } = entry as Record<string, unknown>;
    if (typeof baseUrl !== "string" || !isHttpsUrl(baseUrl) || typeof model !== "string" || !model) continue;
    const apiKey = typeof keySecret === "string" ? env[keySecret] : undefined;
    if (typeof apiKey !== "string" || !apiKey) continue;
    out.push({ id: typeof id === "string" && id ? id : model, baseUrl: baseUrl.replace(/\/+$/, ""), model, apiKey });
  }
  return out;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save a short, lasting fact about the person or their work (a preference, a name, a goal, a date) so you know it in every future chat. Do not save small talk.",
      parameters: {
        type: "object",
        properties: { note: { type: "string", description: "The fact, in one sentence." } },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Delete a saved memory note that is wrong or no longer true, by its number.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer", description: "The note's number from the memory list." } },
        required: ["id"],
      },
    },
  },
] as const;

interface CompletionChoice {
  content: string | null;
  toolCalls: ToolCall[];
}

async function callModel(provider: ModelProvider, messages: ChatMessage[], withTools: boolean): Promise<CompletionChoice> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages,
        ...(withTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
        max_tokens: 1500,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`model ${provider.id} answered ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error(`model ${provider.id} sent no message`);
    return { content: message.content ?? null, toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [] };
  } finally {
    clearTimeout(timer);
  }
}

// ── LiteAccount ─────────────────────────────────────────────────────────────

export interface AgentSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface Allowance {
  day: string;
  used: number;
  limit: number;
}

export class LiteAccount extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, used INTEGER NOT NULL)`);
  }

  listAgents(): AgentSummary[] {
    return this.sql
      .exec<{ id: string; name: string; created_at: string }>(`SELECT id, name, created_at FROM agents ORDER BY created_at`)
      .toArray()
      .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  owns(agentId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM agents WHERE id = ?`, agentId).toArray().length > 0;
  }

  /** Records a new agent, or refuses when the account is at its limit. */
  addAgent(agent: AgentSummary, maxAgents: number): { ok: true } | { ok: false; limit: number } {
    const count = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agents`).one().n;
    if (count >= maxAgents) return { ok: false, limit: maxAgents };
    this.sql.exec(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`, agent.id, agent.name, agent.createdAt);
    return { ok: true };
  }

  renameAgent(agentId: string, name: string): void {
    this.sql.exec(`UPDATE agents SET name = ? WHERE id = ?`, name, agentId);
  }

  removeAgent(agentId: string): void {
    this.sql.exec(`DELETE FROM agents WHERE id = ?`, agentId);
  }

  allowance(day: string, limit: number): Allowance {
    const row = this.sql.exec<{ used: number }>(`SELECT used FROM usage WHERE day = ?`, day).toArray()[0];
    return { day, used: row?.used ?? 0, limit };
  }

  /** Takes one free message for `day`, or refuses when the day's allowance is spent. */
  consume(day: string, limit: number): { ok: boolean } & Allowance {
    const current = this.allowance(day, limit);
    if (current.used >= limit) return { ok: false, ...current };
    // Keep only today's row: older days are never read again.
    this.sql.exec(`DELETE FROM usage WHERE day <> ?`, day);
    this.sql.exec(`INSERT INTO usage (day, used) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET used = used + 1`, day);
    return { ok: true, day, used: current.used + 1, limit };
  }

  /** Gives back a message taken by consume() when no reply could be made. */
  refund(day: string): void {
    this.sql.exec(`UPDATE usage SET used = MAX(used - 1, 0) WHERE day = ?`, day);
  }
}

// ── LiteAgent ───────────────────────────────────────────────────────────────

export interface OwnKey {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AgentView {
  id: string;
  name: string;
  persona: string;
  createdAt: string;
  usesOwnKey: boolean;
  ownKeyModel: string | null;
  notes: Array<{ id: number; text: string; createdAt: string }>;
  sessions: Array<{ id: string; title: string; updatedAt: string }>;
}

export interface MessageView {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export class LiteAgent extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, id)`);
  }

  private get(key: string): string | null {
    return this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]?.value ?? null;
  }

  private set(key: string, value: string | null): void {
    if (value === null) this.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
    else this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  /** The owner check every call makes: an agent that is not yours does not exist. */
  private assertOwner(owner: string): void {
    if (this.get("owner") !== owner) throw new HttpError(404, "agent_not_found");
  }

  init(owner: string, name: string, persona: string, createdAt: string): void {
    if (this.get("owner")) throw new HttpError(409, "agent_exists");
    this.set("owner", owner);
    this.set("name", name);
    this.set("persona", persona);
    this.set("created_at", createdAt);
  }

  view(owner: string, agentId: string): AgentView {
    this.assertOwner(owner);
    const ownKey = this.ownKey();
    return {
      id: agentId,
      name: this.get("name") ?? "",
      persona: this.get("persona") ?? "",
      createdAt: this.get("created_at") ?? "",
      usesOwnKey: ownKey !== null,
      ownKeyModel: ownKey?.model ?? null,
      notes: this.sql
        .exec<{ id: number; text: string; created_at: string }>(`SELECT id, text, created_at FROM notes ORDER BY id`)
        .toArray()
        .map((n) => ({ id: n.id, text: n.text, createdAt: n.created_at })),
      sessions: this.sql
        .exec<{ id: string; title: string; updated_at: string }>(`SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC`)
        .toArray()
        .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at })),
    };
  }

  update(owner: string, patch: { name?: string; persona?: string; ownKey?: OwnKey | null; deleteNote?: number }): void {
    this.assertOwner(owner);
    if (patch.name !== undefined) this.set("name", patch.name);
    if (patch.persona !== undefined) this.set("persona", patch.persona);
    if (patch.ownKey !== undefined) this.set("own_key", patch.ownKey ? JSON.stringify(patch.ownKey) : null);
    if (patch.deleteNote !== undefined) this.sql.exec(`DELETE FROM notes WHERE id = ?`, patch.deleteNote);
  }

  /** Wipes every row this agent holds. */
  async destroy(owner: string): Promise<void> {
    this.assertOwner(owner);
    await this.ctx.storage.deleteAll();
  }

  createSession(owner: string, maxSessions: number): { id: string } {
    this.assertOwner(owner);
    const count = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`).one().n;
    if (count >= maxSessions) throw new HttpError(409, "session_limit", { limit: maxSessions });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql.exec(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`, id, "New chat", now, now);
    return { id };
  }

  deleteSession(owner: string, sessionId: string): void {
    this.assertOwner(owner);
    this.sql.exec(`DELETE FROM messages WHERE session_id = ?`, sessionId);
    this.sql.exec(`DELETE FROM sessions WHERE id = ?`, sessionId);
  }

  messages(owner: string, sessionId: string): MessageView[] {
    this.assertOwner(owner);
    this.assertSession(sessionId);
    return this.sql
      .exec<{ id: number; role: "user" | "assistant"; content: string; created_at: string }>(
        `SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id`,
        sessionId,
      )
      .toArray()
      .map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at }));
  }

  private assertSession(sessionId: string): void {
    if (this.sql.exec(`SELECT 1 FROM sessions WHERE id = ?`, sessionId).toArray().length === 0) {
      throw new HttpError(404, "session_not_found");
    }
  }

  private ownKey(): OwnKey | null {
    const raw = this.get("own_key");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OwnKey;
    } catch {
      return null;
    }
  }

  private systemPrompt(): string {
    const name = this.get("name") || "your agent";
    const persona = this.get("persona");
    const notes = this.sql.exec<{ id: number; text: string }>(`SELECT id, text FROM notes ORDER BY id`).toArray();
    const lines = [
      `You are ${name}, a personal AI agent living in the cloud on Hivra. Today is ${utcDay()} (UTC).`,
      "Be warm, direct and useful. Keep replies short unless asked for detail.",
      "You have a long-term memory. When the person tells you something lasting about themselves or their work, call `remember`. When a note is wrong, call `forget`.",
      "You cannot run code, browse or use a computer yet. If asked, say so plainly and suggest giving the agent a computer on a paid Hivra plan.",
    ];
    if (persona) lines.push("", "Your personality and instructions from your owner:", persona);
    lines.push("", notes.length ? "What you remember:" : "You have no memories saved yet.");
    for (const note of notes) lines.push(`${note.id}. ${note.text}`);
    return lines.join("\n");
  }

  private runTool(call: ToolCall): string {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return "error: arguments were not valid JSON";
    }
    if (call.function.name === "remember") {
      const note = typeof args.note === "string" ? args.note.trim().slice(0, MAX_NOTE_CHARS) : "";
      if (!note) return "error: note is empty";
      const count = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM notes`).one().n;
      if (count >= MAX_NOTES) return `error: memory is full (${MAX_NOTES} notes); forget one first`;
      this.sql.exec(`INSERT INTO notes (text, created_at) VALUES (?, ?)`, note, new Date().toISOString());
      return "saved";
    }
    if (call.function.name === "forget") {
      const id = Number(args.id);
      if (!Number.isInteger(id)) return "error: id must be a number";
      this.sql.exec(`DELETE FROM notes WHERE id = ?`, id);
      return "deleted";
    }
    return `error: unknown tool ${call.function.name}`;
  }

  /**
   * Answers one message. Free allowance is taken from the account first (unless
   * the agent uses its owner's own key) and given back if no model answers, so a
   * failed message never costs the person a free message.
   */
  async send(
    owner: string,
    sessionId: string,
    content: string,
    settings: { dailyMessages: number; managedRequestId?: string; requireOwnKey?: boolean },
  ): Promise<{ reply: MessageView; model: string; allowance: Allowance | null }> {
    this.assertOwner(owner);
    this.assertSession(sessionId);

    const managedRequestId = settings.managedRequestId;
    const ownKey = managedRequestId ? null : this.ownKey();
    if (settings.requireOwnKey && !ownKey) throw new HttpError(409, "own_key_required");
    const providers: ModelProvider[] = managedRequestId ? [] : ownKey
      ? [{ id: "own-key", baseUrl: ownKey.baseUrl, model: ownKey.model, apiKey: ownKey.apiKey }]
      : configuredModels(this.env);
    if (!managedRequestId && providers.length === 0) throw new HttpError(503, "no_model_configured");

    const account = this.env.LITE_ACCOUNT.get(this.env.LITE_ACCOUNT.idFromName(owner));
    const day = utcDay();
    let allowance: Allowance | null = null;
    if (!ownKey && !managedRequestId) {
      const taken = await account.consume(day, settings.dailyMessages);
      if (!taken.ok) throw new HttpError(429, "daily_limit", { allowance: { day: taken.day, used: taken.used, limit: taken.limit } });
      allowance = { day: taken.day, used: taken.used, limit: taken.limit };
    }

    const now = new Date().toISOString();
    const userRow = this.sql
      .exec<{ id: number }>(
        `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?) RETURNING id`,
        sessionId,
        content,
        now,
      )
      .one();

    const history = this.sql
      .exec<{ role: "user" | "assistant"; content: string }>(
        `SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`,
        sessionId,
        HISTORY_MESSAGES,
      )
      .toArray();

    let lastError: unknown = null;
    for (const provider of managedRequestId ? [null] : providers) {
      try {
        const reply = managedRequestId
          ? await callManagedQa(this.env, owner, managedRequestId, content)
          : await this.converse(provider!, history);
        const createdAt = new Date().toISOString();
        const row = this.sql
          .exec<{ id: number }>(
            `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'assistant', ?, ?) RETURNING id`,
            sessionId,
            reply,
            createdAt,
          )
          .one();
        const title = this.sql.exec<{ title: string }>(`SELECT title FROM sessions WHERE id = ?`, sessionId).one().title;
        const nextTitle = title === "New chat" ? content.replace(/\s+/g, " ").slice(0, 60) : title;
        this.sql.exec(`UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?`, createdAt, nextTitle, sessionId);
        return { reply: { id: row.id, role: "assistant", content: reply, createdAt }, model: provider?.id ?? "hivra-credits-qa", allowance };
      } catch (error) {
        lastError = error;
        if (provider) console.warn(JSON.stringify({ event: "lite_model_failed", provider: provider.id, error: String(error) }));
      }
    }

    // No model answered: undo the user's message and give the free message back.
    this.sql.exec(`DELETE FROM messages WHERE id = ?`, userRow.id);
    if (managedRequestId) {
      throw asHttpError(lastError) ?? new HttpError(502, "managed_reply_failed");
    }
    if (!ownKey) await account.refund(day);
    throw new HttpError(502, ownKey ? "own_key_failed" : "model_unavailable", { detail: String(lastError) });
  }

  private async converse(provider: ModelProvider, history: Array<{ role: "user" | "assistant"; content: string }>): Promise<string> {
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt() }, ...history];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const withTools = round < MAX_TOOL_ROUNDS;
      const choice = await callModel(provider, messages, withTools);
      if (choice.toolCalls.length === 0 || !withTools) {
        const text = (choice.content ?? "").trim();
        if (!text) throw new Error(`model ${provider.id} sent an empty reply`);
        return text;
      }
      messages.push({ role: "assistant", content: choice.content, tool_calls: choice.toolCalls });
      for (const call of choice.toolCalls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: this.runTool(call) });
      }
    }
    throw new Error("unreachable");
  }
}

// ── HTTP surface (Hivra's server only) ──────────────────────────────────────

async function verify(request: Request, env: Env, body: string): Promise<string> {
  const secret = env.LITE_AGENT_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) throw new HttpError(503, "not_configured");
  const account = request.headers.get("x-hivra-account") ?? "";
  const timestamp = request.headers.get("x-hivra-timestamp") ?? "";
  const signature = (request.headers.get("x-hivra-signature") ?? "").toLowerCase();
  if (!ACCOUNT_ID.test(account) || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new HttpError(401, "unauthorized");
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > CLOCK_SKEW_SECONDS) throw new HttpError(401, "stale_request");
  const url = new URL(request.url);
  const expected = await hmacHex(secret, signedMessage(request.method, url.pathname, account, timestamp, await sha256Hex(body)));
  if (!timingSafeEqualHex(expected, signature)) throw new HttpError(401, "unauthorized");
  return account;
}

/** What Hivra signs. Restated on the dashboard side in lib/lite-agents/client.ts. */
export function signedMessage(method: string, path: string, account: string, timestamp: string, bodySha256: string): string {
  return `lite|v1|${method.toUpperCase()}|${path}|${account}|${timestamp}|${bodySha256}`;
}

async function callManagedQa(env: Env, owner: string, requestId: string, content: string): Promise<string> {
  const secret = env.LITE_AGENT_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) throw new HttpError(503, "not_configured");
  const body = JSON.stringify({ requestId, content });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const path = new URL(MANAGED_QA_CALLBACK).pathname;
  const digest = await sha256Hex(body);
  const signature = await hmacHex(secret, `${MANAGED_QA_SIGNATURE_VERSION}|POST|${path}|${owner}|${timestamp}|${digest}`);
  const response = await fetch(MANAGED_QA_CALLBACK, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-hivra-account": owner,
      "x-hivra-timestamp": timestamp,
      "x-hivra-signature": signature,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (response.status === 402) throw new HttpError(402, "managed_credits_required");
  if (response.status === 409) throw new HttpError(409, "managed_request_already_used");
  if (!response.ok) throw new HttpError(502, "managed_reply_failed");
  const data = await response.json() as { text?: unknown };
  if (typeof data.text !== "string" || !data.text.trim()) throw new HttpError(502, "managed_reply_failed");
  return data.text.trim();
}

function parseOwnKey(value: unknown): OwnKey | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new HttpError(400, "own_key_invalid");
  const { baseUrl, model, apiKey } = value as Record<string, unknown>;
  if (typeof baseUrl !== "string" || !isHttpsUrl(baseUrl)) throw new HttpError(400, "own_key_base_url_invalid");
  if (typeof model !== "string" || !model.trim() || model.length > 200) throw new HttpError(400, "own_key_model_invalid");
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 500) throw new HttpError(400, "own_key_api_key_invalid");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model: model.trim(), apiKey: apiKey.trim() };
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/health") return json(200, { ok: true, service: "lite-agent" });

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
  if (body.length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  const owner = await verify(request, env, body);
  let input: Record<string, unknown> = {};
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
      else throw new Error();
    } catch {
      throw new HttpError(400, "invalid_json");
    }
  }

  const limits = {
    maxAgents: intSetting(env.LITE_MAX_AGENTS, 1, 0, 100),
    maxSessions: intSetting(env.LITE_MAX_SESSIONS, 256, 1, 10_000),
    dailyMessages: intSetting(env.LITE_DAILY_MESSAGES, 20, 0, 100_000),
  };
  const account = env.LITE_ACCOUNT.get(env.LITE_ACCOUNT.idFromName(owner));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") throw new HttpError(404, "not_found");
  const method = request.method;

  // /v1/me
  if (parts.length === 2 && parts[1] === "me" && method === "GET") {
    return json(200, {
      agents: await account.listAgents(),
      allowance: await account.allowance(utcDay(), limits.dailyMessages),
      limits: { maxAgents: limits.maxAgents, maxSessions: limits.maxSessions },
      modelsConfigured: configuredModels(env).length > 0,
    });
  }

  if (parts[1] !== "agents") throw new HttpError(404, "not_found");

  // /v1/agents
  if (parts.length === 2 && method === "POST") {
    const name = cleanText(input.name, MAX_NAME_CHARS, "name");
    const persona = cleanText(input.persona, MAX_PERSONA_CHARS, "persona", { required: false });
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const added = await account.addAgent({ id, name, createdAt }, limits.maxAgents);
    if (!added.ok) throw new HttpError(409, "agent_limit", { limit: added.limit });
    const agent = env.LITE_AGENT.get(env.LITE_AGENT.idFromName(id));
    try {
      await agent.init(owner, name, persona, createdAt);
    } catch (error) {
      await account.removeAgent(id);
      throw error;
    }
    return json(201, { agent: await agent.view(owner, id) });
  }

  const agentId = parts[2] ?? "";
  if (!OBJECT_ID.test(agentId)) throw new HttpError(404, "agent_not_found");
  // The account list is checked first so an id from someone else's account
  // never even wakes that agent.
  if (!(await account.owns(agentId))) throw new HttpError(404, "agent_not_found");
  const agent = env.LITE_AGENT.get(env.LITE_AGENT.idFromName(agentId));

  if (parts.length === 3) {
    if (method === "GET") return json(200, { agent: await agent.view(owner, agentId) });
    if (method === "PATCH") {
      const patch: { name?: string; persona?: string; ownKey?: OwnKey | null; deleteNote?: number } = {};
      if ("name" in input) patch.name = cleanText(input.name, MAX_NAME_CHARS, "name");
      if ("persona" in input) patch.persona = cleanText(input.persona, MAX_PERSONA_CHARS, "persona", { required: false });
      if ("ownKey" in input) patch.ownKey = parseOwnKey(input.ownKey);
      if ("deleteNote" in input) {
        if (!Number.isInteger(input.deleteNote)) throw new HttpError(400, "delete_note_invalid");
        patch.deleteNote = input.deleteNote as number;
      }
      await agent.update(owner, patch);
      if (patch.name !== undefined) await account.renameAgent(agentId, patch.name);
      return json(200, { agent: await agent.view(owner, agentId) });
    }
    if (method === "DELETE") {
      await agent.destroy(owner);
      await account.removeAgent(agentId);
      return json(200, { deleted: true });
    }
  }

  if (parts[3] === "sessions") {
    if (parts.length === 4 && method === "POST") return json(201, { session: await agent.createSession(owner, limits.maxSessions) });
    const sessionId = parts[4] ?? "";
    if (!OBJECT_ID.test(sessionId)) throw new HttpError(404, "session_not_found");
    if (parts.length === 5 && method === "GET") return json(200, { messages: await agent.messages(owner, sessionId) });
    if (parts.length === 5 && method === "DELETE") {
      await agent.deleteSession(owner, sessionId);
      return json(200, { deleted: true });
    }
    if (parts.length === 6 && parts[5] === "managed-messages" && method === "POST") {
      if (typeof input.requestId !== "string" || !OBJECT_ID.test(input.requestId)) {
        throw new HttpError(400, "invalid_managed_request");
      }
      const content = cleanText(input.content, MAX_MANAGED_QA_MESSAGE_CHARS, "content");
      return json(200, await agent.send(owner, sessionId, content, {
        dailyMessages: limits.dailyMessages, managedRequestId: input.requestId,
      }));
    }
    if (parts.length === 6 && (parts[5] === "messages" || parts[5] === "own-key-messages") && method === "POST") {
      const content = cleanText(input.content, MAX_MESSAGE_CHARS, "content");
      return json(200, await agent.send(owner, sessionId, content, { dailyMessages: limits.dailyMessages, requireOwnKey: parts[5] === "own-key-messages" }));
    }
  }

  throw new HttpError(404, "not_found");
}

/** Errors thrown inside a Durable Object arrive as plain Errors; recover the code. */
function asHttpError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : "";
  const at = message.indexOf("lite-http:");
  if (at === -1) return null;
  try {
    const parsed = JSON.parse(message.slice(at + "lite-http:".length)) as { status?: unknown; code?: unknown; extra?: unknown };
    if (typeof parsed.status === "number" && typeof parsed.code === "string") {
      return new HttpError(parsed.status, parsed.code, (parsed.extra as Record<string, unknown>) ?? {});
    }
  } catch {
    // fall through
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const http = asHttpError(error);
      if (http) return json(http.status, { error: http.code, ...http.extra });
      console.error(JSON.stringify({ event: "lite_unhandled", error: String(error) }));
      return json(500, { error: "internal_error" });
    }
  },
} satisfies ExportedHandler<Env>;
