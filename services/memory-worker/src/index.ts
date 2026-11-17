/**
 * Portable agent memory.
 *
 * One MemoryStore object per person. Agents reach it over MCP (POST /mcp) or
 * the plain API (/v1/*) with a key Hivra's server mints. The agent decides
 * what is worth saving; this Worker only stores, searches and hands back, so
 * no language model runs on a save. Embeddings are optional: without them
 * search falls back to keywords.
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  MEMORY: DurableObjectNamespace<MemoryStore>;
  MEMORY_SECRET: string;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** Optional OpenAI-compatible embeddings endpoint, used when there is no AI binding. */
  MEMORY_EMBED_URL?: string;
  MEMORY_EMBED_KEY?: string;
  MEMORY_EMBED_MODEL?: string;
  MEMORY_MAX_ITEMS?: string;
  MEMORY_MAX_TEXT?: string;
  MEMORY_RATE_PER_MINUTE?: string;
  MEMORY_REPLACE_ABOVE?: string;
}

type Scope = 'rw' | 'ro';
interface Caller {
  keyId: string;
  scope: Scope;
}
interface RememberInput {
  text: string;
  kind?: string;
  project?: string;
  /** Ids of older memories this one makes out of date. */
  replaces?: string[];
}
interface RecallInput {
  query: string;
  project?: string;
  limit?: number;
  maxTokens?: number;
}

const KINDS = ['fact', 'preference', 'decision', 'project', 'note'];
const PROFILE_MAX = 2000;
/** Older memories at least this close to a new one are shown to the caller, who decides if they are out of date. */
const SIMILAR_ABOVE = 0.72;
const encoder = new TextEncoder();

// ---------------------------------------------------------------- helpers

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const b64url = (text: string): string =>
  btoa(String.fromCharCode(...encoder.encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function unb64url(text: string): string {
  const bytes = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bytes, (char) => char.charCodeAt(0)));
}

/** A key names its account, so the Worker can find the object without a lookup table. */
async function mintKey(secret: string, account: string, keyId: string, scope: Scope): Promise<string> {
  const signature = (await hmac(secret, `memory-key|v1|${account}|${keyId}|${scope}`)).slice(0, 40);
  return `hm_${b64url(account)}.${keyId}.${scope}.${signature}`;
}

async function readKey(secret: string, key: string): Promise<{ account: string; keyId: string; scope: Scope } | null> {
  const match = /^hm_([A-Za-z0-9_-]{1,200})\.([a-z0-9]{8,32})\.(rw|ro)\.([0-9a-f]{40})$/.exec(key);
  if (!match) return null;
  let account: string;
  try {
    account = unb64url(match[1]);
  } catch {
    return null;
  }
  const scope = match[3] as Scope;
  const expected = (await hmac(secret, `memory-key|v1|${account}|${match[2]}|${scope}`)).slice(0, 40);
  return sameText(expected, match[4]) ? { account, keyId: match[2], scope } : null;
}

/** Masks things shaped like credentials before they are stored. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]')
    .replace(/\b(sk|pk|rk)[-_](live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{20,}\b/g, '[key removed]')
    .replace(/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[key removed]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[key removed]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[key removed]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[token removed]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [token removed]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[:=]\s*)["']?[^\s"',;]{6,}["']?/gi,
      '$1[removed]',
    );
}

const tokens = (text: string): number => Math.ceil(text.length / 4);

/** Unit vector packed to one signed byte per dimension: 1 KB per memory at 1,024 dimensions. */
function pack(vector: number[]): Uint8Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  const packed = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) packed[i] = Math.max(-127, Math.min(127, Math.round((vector[i] / norm) * 127)));
  return new Uint8Array(packed.buffer);
}

function cosine(a: Int8Array, b: Int8Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const asInt8 = (blob: ArrayBuffer): Int8Array => new Int8Array(blob);

/** Words of the query, joined with OR, each quoted so FTS5 syntax can't be injected. */
function ftsQuery(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  return [...new Set(words)]
    .slice(0, 24)
    .map((word) => `"${word}"`)
    .join(' OR ');
}

async function embed(env: Env, texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return [];
  const model = env.MEMORY_EMBED_MODEL || '@cf/baai/bge-m3';
  try {
    if (env.AI) {
      const result = (await env.AI.run(model, { text: texts })) as { data?: number[][] };
      return result.data && result.data.length === texts.length ? result.data : null;
    }
    if (env.MEMORY_EMBED_URL) {
      const response = await fetch(env.MEMORY_EMBED_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.MEMORY_EMBED_KEY ? { authorization: `Bearer ${env.MEMORY_EMBED_KEY}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: { embedding: number[] }[] };
      return body.data && body.data.length === texts.length ? body.data.map((row) => row.embedding) : null;
    }
  } catch {
    // Search still works on keywords alone.
  }
  return null;
}

// ---------------------------------------------------------------- the object

export class MemoryStore extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly windows = new Map<string, { minute: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.prepare();
  }

  private prepare(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        valid_to INTEGER,
        replaced_by TEXT,
        vec BLOB,
        digest TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS memories_active ON memories (valid_to, project);
      CREATE INDEX IF NOT EXISTS memories_digest ON memories (digest);
      -- Keyed by the memory's rowid, so removing one entry does not scan the index.
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tokenize = 'porter unicode61');
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        scope TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (
        at INTEGER NOT NULL,
        agent TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
  }

  // -- bookkeeping

  /** Runs a statement and adds what it read and wrote to this person's meter. */
  private run<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.pending.read += cursor.rowsRead;
    this.pending.written += cursor.rowsWritten;
    return rows;
  }

  private pending = { read: 0, written: 0 };
  private tally: Record<string, number> = {};

  private count(name: string, by: number): void {
    if (by) this.tally[name] = (this.tally[name] ?? 0) + by;
  }

  /** Writes the request's whole meter in one statement, and counts that statement too. */
  private settle(): void {
    this.count('rows_read', this.pending.read);
    this.count('rows_written', this.pending.written);
    const entries = Object.entries(this.tally);
    this.pending = { read: 0, written: 0 };
    this.tally = {};
    if (!entries.length) return;
    entries.push(['rows_read', entries.length], ['rows_written', entries.length]);
    const cursor = this.sql.exec(
      `INSERT INTO counters (name, value) VALUES ${entries.map(() => '(?, ?)').join(', ')}
       ON CONFLICT (name) DO UPDATE SET value = value + excluded.value`,
      ...entries.flat(),
    );
    cursor.toArray();
  }

  private active(): number {
    return this.run<{ value: number }>("SELECT value FROM counters WHERE name = 'active'")[0]?.value ?? 0;
  }

  private note(agent: string, action: string, detail: string): void {
    this.run('INSERT INTO activity (at, agent, action, detail) VALUES (?, ?, ?, ?)', Date.now(), agent, action, detail.slice(0, 200));
    // Trim now and then, not on every request: a delete is a billed write.
    if (Math.random() < 0.02) this.run('DELETE FROM activity WHERE rowid <= (SELECT MAX(rowid) FROM activity) - 500');
  }

  private limit(name: 'MEMORY_MAX_ITEMS' | 'MEMORY_MAX_TEXT' | 'MEMORY_RATE_PER_MINUTE', fallback: number): number {
    const value = Number(this.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /** Checks the key is known here and under its rate limit; returns its label and project. */
  private admit(caller: Caller, writes: boolean): { label: string; project: string } {
    const [key] = this.run<{ label: string; scope: string; project: string }>(
      'SELECT label, scope, project FROM keys WHERE id = ?',
      caller.keyId,
    );
    if (!key) throw new Refusal(401, 'key_revoked', 'This key is not valid any more.');
    if (writes && (key.scope !== 'rw' || caller.scope !== 'rw')) {
      throw new Refusal(403, 'read_only', 'This key can read memory but not change it.');
    }
    const minute = Math.floor(Date.now() / 60000);
    const window = this.windows.get(caller.keyId);
    if (!window || window.minute !== minute) this.windows.set(caller.keyId, { minute, count: 1 });
    else if ((window.count += 1) > this.limit('MEMORY_RATE_PER_MINUTE', 120)) {
      throw new Refusal(429, 'slow_down', 'Too many requests this minute. Try again shortly.');
    }
    return { label: key.label, project: key.project };
  }

  // -- keys (called only by the signed admin routes)

  async createKey(keyId: string, label: string, scope: Scope, project: string): Promise<void> {
    this.run(
      'INSERT INTO keys (id, label, scope, project, created_at) VALUES (?, ?, ?, ?, ?)',
      keyId,
      label.slice(0, 60) || 'agent',
      scope,
      project.slice(0, 80),
      Date.now(),
    );
    this.settle();
  }

  async listKeys(): Promise<Record<string, SqlStorageValue>[]> {
    return this.sql.exec('SELECT id, label, scope, project, created_at, last_used_at FROM keys ORDER BY created_at').toArray();
  }

  async revokeKey(keyId: string): Promise<boolean> {
    const before = this.pending.written;
    this.run('DELETE FROM keys WHERE id = ?', keyId);
    const removed = this.pending.written > before;
    this.settle();
    return removed;
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.prepare();
    this.windows.clear();
  }

  // -- memory

  async remember(caller: Caller, items: RememberInput[]): Promise<unknown> {
    try {
      const key = this.admit(caller, true);
      if (!Array.isArray(items) || !items.length || items.length > 50) {
        throw new Refusal(400, 'bad_request', 'Send between 1 and 50 memories at a time.');
      }
      const maxText = this.limit('MEMORY_MAX_TEXT', 4000);
      const cleaned = items.map((item) => {
        const text = scrubSecrets(String(item?.text ?? '').trim());
        if (!text) throw new Refusal(400, 'bad_request', 'A memory needs some text.');
        if (text.length > maxText) throw new Refusal(400, 'too_long', `A memory can be at most ${maxText} characters.`);
        const kind = KINDS.includes(String(item.kind)) ? String(item.kind) : 'note';
        const project = (key.project || String(item.project ?? '')).trim().slice(0, 80);
        const replaces = Array.isArray(item.replaces) ? item.replaces.map(String).slice(0, 10) : [];
        return { text, kind, project, replaces };
      });
      if (this.active() + cleaned.length > this.limit('MEMORY_MAX_ITEMS', 10000)) {
        throw new Refusal(403, 'memory_full', 'This memory is full. Forget some memories or upgrade for more room.');
      }

      const vectors = await embed(this.env, cleaned.map((item) => item.text));
      if (vectors) this.count('embed_tokens', cleaned.reduce((sum, item) => sum + tokens(item.text), 0));
      const replaceAbove = Number(this.env.MEMORY_REPLACE_ABOVE) || 0.97;
      const now = Date.now();
      const saved: { id: string; replaced?: string[]; duplicate?: boolean; similar?: { id: string; text: string }[] }[] = [];
      // The caller named what is out of date; only memories this key may touch are retired.
      const retireNamed = (ids: string[], project: string, by: string): string[] =>
        ids.filter((old) => {
          if (old === by) return false;
          const [row] = this.run<{ id: string }>(
            `SELECT id FROM memories WHERE id = ? AND valid_to IS NULL ${key.project ? 'AND project = ?' : ''}`,
            ...(key.project ? [old, project] : [old]),
          );
          if (row) this.retire(old, now, by);
          return Boolean(row);
        });

      const digests = await Promise.all(
        cleaned.map(async (item) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${item.project}\n${item.text}`))).slice(0, 24)),
      );
      cleaned.forEach((item, index) => {
        const [same] = this.run<{ id: string }>('SELECT id FROM memories WHERE digest = ? AND valid_to IS NULL LIMIT 1', digests[index]);
        if (same) {
          const replaced = retireNamed(item.replaces, item.project, same.id);
          saved.push(replaced.length ? { id: same.id, duplicate: true, replaced } : { id: same.id, duplicate: true });
          return;
        }
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        const vec = vectors ? pack(vectors[index]) : null;
        const replaced: string[] = [];
        const close: { id: string; score: number }[] = [];
        if (vec) {
          const mine = asInt8(vec.buffer as ArrayBuffer);
          const others = this.run<{ id: string; vec: ArrayBuffer }>(
            'SELECT id, vec FROM memories WHERE valid_to IS NULL AND project = ? AND vec IS NOT NULL',
            item.project,
          );
          for (const other of others) {
            const score = cosine(mine, asInt8(other.vec));
            // Only a near word-for-word restatement is replaced without asking.
            if (score >= replaceAbove) replaced.push(other.id);
            else if (score >= SIMILAR_ABOVE && !item.replaces.includes(other.id)) close.push({ id: other.id, score });
          }
        }
        this.run(
          'INSERT INTO memories (id, text, kind, project, agent, created_at, vec, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          item.text,
          item.kind,
          item.project,
          key.label,
          now,
          vec,
          digests[index],
        );
        this.count('active', 1);
        this.run('INSERT INTO memories_fts (rowid, text) SELECT rowid, text FROM memories WHERE id = ?', id);
        for (const old of replaced) this.retire(old, now, id);
        replaced.push(...retireNamed(item.replaces, item.project, id));
        const entry: (typeof saved)[number] = replaced.length ? { id, replaced } : { id };
        if (close.length) {
          const top = close.sort((a, b) => b.score - a.score).slice(0, 3);
          const texts = this.run<{ id: string; text: string }>(
            `SELECT id, text FROM memories WHERE id IN (${top.map(() => '?').join(',')})`,
            ...top.map((row) => row.id),
          );
          entry.similar = top.map((row) => ({ id: row.id, text: texts.find((t) => t.id === row.id)?.text.slice(0, 300) ?? '' }));
        }
        saved.push(entry);
      });

      this.count('saves', cleaned.length);
      this.note(key.label, 'remember', `${cleaned.length} saved`);
      const hint = saved.some((entry) => entry.similar)
        ? 'Some older memories look similar. If the new one makes any of them out of date, call remember again with the same text and "replaces" set to their ids. If they are simply different facts, do nothing.'
        : undefined;
      return { ok: true, saved, meaningSearch: Boolean(vectors), hint };
    } catch (error) {
      return refusalBody(error);
    } finally {
      this.settle();
    }
  }

  private retire(id: string, at: number, replacedBy: string | null): void {
    this.run('DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)', id);
    this.run('UPDATE memories SET valid_to = ?, replaced_by = ?, vec = NULL WHERE id = ? AND valid_to IS NULL', at, replacedBy, id);
    this.count('active', -1);
    this.count('replaced', 1);
  }

  async recall(caller: Caller, input: RecallInput): Promise<unknown> {
    try {
      const key = this.admit(caller, false);
      const query = String(input?.query ?? '').trim().slice(0, 1000);
      if (!query) throw new Refusal(400, 'bad_request', 'Say what to look for.');
      const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit) || 6)));
      const budget = Math.max(100, Math.min(4000, Math.floor(Number(input.maxTokens) || 800)));
      const project = (key.project || String(input.project ?? '')).trim();
      const scores = new Map<string, number>();
      const bump = (id: string, rank: number, weight: number) =>
        scores.set(id, (scores.get(id) ?? 0) + weight / (60 + rank));

      const match = ftsQuery(query);
      if (match) {
        const hits = this.run<{ id: string }>(
          'SELECT m.id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT 30',
          match,
        );
        hits.forEach((hit, rank) => bump(hit.id, rank, 1));
      }

      const vectors = await embed(this.env, [query]);
      if (vectors) {
        this.count('embed_tokens', tokens(query));
        const mine = asInt8(pack(vectors[0]).buffer as ArrayBuffer);
        const rows = project
          ? this.run<{ id: string; vec: ArrayBuffer }>(
              "SELECT id, vec FROM memories WHERE valid_to IS NULL AND vec IS NOT NULL AND project IN (?, '')",
              project,
            )
          : this.run<{ id: string; vec: ArrayBuffer }>('SELECT id, vec FROM memories WHERE valid_to IS NULL AND vec IS NOT NULL');
        rows
          .map((row) => ({ id: row.id, score: cosine(mine, asInt8(row.vec)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 30)
          .forEach((row, rank) => bump(row.id, rank, 1.2));
      }

      const results: Record<string, unknown>[] = [];
      let used = 0;
      const now = Date.now();
      const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
      const rows = ranked.length
        ? this.run<{ id: string; text: string; kind: string; project: string; agent: string; created_at: number }>(
            `SELECT id, text, kind, project, agent, created_at FROM memories
             WHERE valid_to IS NULL AND id IN (${ranked.map(() => '?').join(',')})`,
            ...ranked.map(([id]) => id),
          )
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const finalists = ranked
        .map(([id, score]) => ({ row: byId.get(id), score }))
        .filter((entry) => entry.row && (!project || entry.row.project === project || entry.row.project === ''))
        // A small lift for newer memories: at most 10%, fading over about three months.
        .map((entry) => ({
          row: entry.row!,
          score: entry.score * (1 + 0.1 * Math.exp(-(now - entry.row!.created_at) / (90 * 86400000))),
        }))
        .sort((a, b) => b.score - a.score);
      for (const { row, score } of finalists) {
        if (results.length >= limit) break;
        const cost = tokens(row.text);
        if (results.length && used + cost > budget) continue;
        used += cost;
        results.push({
          id: row.id,
          text: row.text,
          kind: row.kind,
          project: row.project || undefined,
          savedBy: row.agent,
          savedAt: new Date(row.created_at).toISOString().slice(0, 10),
          score: Math.round(score * 1000) / 1000,
        });
      }
      this.count('recalls', 1);
      this.note(key.label, 'recall', query);
      return { ok: true, results, meaningSearch: Boolean(vectors) };
    } catch (error) {
      return refusalBody(error);
    } finally {
      this.settle();
    }
  }

  async profile(caller: Caller, set?: string): Promise<unknown> {
    try {
      const key = this.admit(caller, set !== undefined);
      if (set !== undefined) {
        const text = scrubSecrets(String(set).trim());
        if (text.length > PROFILE_MAX) throw new Refusal(400, 'too_long', `The profile can be at most ${PROFILE_MAX} characters.`);
        this.run(
          "INSERT INTO settings (name, value) VALUES ('profile', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
          text,
        );
        this.note(key.label, 'profile', 'updated');
      }
      const [row] = this.run<{ value: string }>("SELECT value FROM settings WHERE name = 'profile'");
      return { ok: true, profile: row?.value ?? '' };
    } catch (error) {
      return refusalBody(error);
    } finally {
      this.settle();
    }
  }

  async forget(caller: Caller, input: { id?: string; project?: string }): Promise<unknown> {
    try {
      const key = this.admit(caller, true);
      let ids: string[] = [];
      if (input?.id) {
        ids = this.run<{ id: string }>('SELECT id FROM memories WHERE id = ? AND valid_to IS NULL', String(input.id)).map((row) => row.id);
        if (key.project) {
          ids = this.run<{ id: string }>('SELECT id FROM memories WHERE id = ? AND valid_to IS NULL AND project = ?', String(input.id), key.project).map(
            (row) => row.id,
          );
        }
      } else if (input?.project) {
        if (key.project && key.project !== input.project) throw new Refusal(403, 'other_project', 'This key only covers its own project.');
        ids = this.run<{ id: string }>('SELECT id FROM memories WHERE project = ? AND valid_to IS NULL', String(input.project)).map((row) => row.id);
      } else {
        throw new Refusal(400, 'bad_request', 'Name a memory id or a project to forget.');
      }
      // Forgetting removes the words, not just the listing.
      for (const id of ids) {
        this.run('DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)', id);
        this.run('DELETE FROM memories WHERE id = ?', id);
        this.count('active', -1);
      }
      this.note(key.label, 'forget', `${ids.length} removed`);
      return { ok: true, forgotten: ids.length };
    } catch (error) {
      return refusalBody(error);
    } finally {
      this.settle();
    }
  }

  async exportAll(caller: Caller, format: 'json' | 'markdown'): Promise<unknown> {
    try {
      const key = this.admit(caller, false);
      const [profile] = this.run<{ value: string }>("SELECT value FROM settings WHERE name = 'profile'");
      const rows = this.run<{ id: string; text: string; kind: string; project: string; agent: string; created_at: number; valid_to: number | null; replaced_by: string | null }>(
        `SELECT id, text, kind, project, agent, created_at, valid_to, replaced_by FROM memories
         ${key.project ? 'WHERE project = ?' : ''} ORDER BY project, created_at`,
        ...(key.project ? [key.project] : []),
      );
      this.note(key.label, 'export', `${rows.length} memories`);
      if (format === 'json') return { ok: true, profile: profile?.value ?? '', memories: rows };
      const day = (at: number) => new Date(at).toISOString().slice(0, 10);
      const lines = ['# About me', '', profile?.value || '(empty)', ''];
      let heading: string | null = null;
      for (const row of rows) {
        if (row.project !== heading) {
          heading = row.project;
          lines.push('', `# ${heading || 'General'}`, '');
        }
        lines.push(`- [${row.kind}] ${row.text.replace(/\n+/g, ' ')} (${day(row.created_at)}, ${row.agent}${row.valid_to ? `, replaced ${day(row.valid_to)}` : ''})`);
      }
      return { ok: true, markdown: lines.join('\n') };
    } catch (error) {
      return refusalBody(error);
    } finally {
      this.settle();
    }
  }

  /** What this person's memory has used: the numbers Cloudflare bills on. */
  async stats(): Promise<unknown> {
    const counters = Object.fromEntries(
      this.sql.exec<{ name: string; value: number }>('SELECT name, value FROM counters').toArray().map((row) => [row.name, row.value]),
    );
    return { ok: true, active: 0, replaced: 0, ...counters, storedBytes: this.sql.databaseSize };
  }

  async activity(caller: Caller): Promise<unknown> {
    try {
      this.admit(caller, false);
      return { ok: true, activity: this.run('SELECT at, agent, action, detail FROM activity ORDER BY rowid DESC LIMIT 100') };
    } catch (error) {
      return refusalBody(error);
    } finally {
      this.settle();
    }
  }
}

function refusalBody(error: unknown): { ok: false; status: number; code: string; message: string } {
  if (error instanceof Refusal) return { ok: false, status: error.status, code: error.code, message: error.message };
  throw error;
}

// ---------------------------------------------------------------- MCP

const INSTRUCTIONS = `This is the person's own long-term memory, shared by every agent they use.
At the start of a task, call "profile" once, then "recall" with what the task is about.
Call "remember" when you learn something that will still matter in a later session: a preference, a decision and its reason, a fact about the person or their project, or how something was solved. Save one clear, self-contained sentence or two per memory. Do not save secrets, passwords or keys, and do not save things that only matter right now.
When something saved has changed, save the new version with "replaces" naming the old memory's id (recall shows ids). If the person asks you to forget something, call "forget", which deletes it for good.`;

const TOOLS = [
  {
    name: 'remember',
    description:
      'Save something worth knowing in a later session: a fact, preference, decision or project note. One self-contained memory per item. When it corrects or updates older memories, pass their ids in "replaces" so agents stop seeing the old version.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory, written so it makes sense on its own.' },
        kind: { type: 'string', enum: KINDS },
        project: { type: 'string', description: 'Optional project name, e.g. the repository name.' },
        replaces: { type: 'array', items: { type: 'string' }, description: 'Ids of older memories this one makes out of date.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description: "Search the person's memory by meaning and by keyword. Returns the few most relevant memories.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in plain words.' },
        project: { type: 'string', description: 'Optional: also prefer memories of this project.' },
        limit: { type: 'number', description: 'How many to return (default 6, at most 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'profile',
    description:
      'Read the short "about me" every agent should know (who the person is, how they like to work). Pass "set" with the full new text to replace it.',
    inputSchema: { type: 'object', properties: { set: { type: 'string' } } },
  },
  {
    name: 'forget',
    description: 'Permanently delete one memory by id, or every memory of a project.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, project: { type: 'string' } } },
  },
  {
    name: 'export',
    description: 'Everything in memory as plain Markdown.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(store: DurableObjectStub<MemoryStore>, caller: Caller, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'remember':
      return store.remember(caller, [
        { text: String(args.text ?? ''), kind: args.kind as string, project: args.project as string, replaces: args.replaces as string[] },
      ]);
    case 'recall':
      return store.recall(caller, { query: String(args.query ?? ''), project: args.project as string, limit: args.limit as number });
    case 'profile':
      return store.profile(caller, typeof args.set === 'string' ? args.set : undefined);
    case 'forget':
      return store.forget(caller, { id: args.id as string, project: args.project as string });
    case 'export':
      return store.exportAll(caller, 'markdown');
    default:
      return { ok: false, status: 404, code: 'unknown_tool', message: `There is no tool called ${name}.` };
  }
}

async function mcp(request: Request, store: DurableObjectStub<MemoryStore>, caller: Caller): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let message: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    message = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (Array.isArray(message)) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } }, 400);
  const reply = (result: unknown) => json({ jsonrpc: '2.0', id: message.id, result });
  // Notifications carry no id and get no body back.
  if (message.id === undefined || message.id === null) return new Response(null, { status: 202 });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hivra-memory', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      const outcome = (await callTool(store, caller, name, (message.params?.arguments ?? {}) as Record<string, unknown>)) as {
        ok: boolean;
        message?: string;
        markdown?: string;
      };
      const text = outcome.ok ? (outcome.markdown ?? JSON.stringify({ ...outcome, ok: undefined })) : (outcome.message ?? 'That did not work.');
      return reply({ content: [{ type: 'text', text }], isError: !outcome.ok });
    }
    default:
      return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
  }
}

// ---------------------------------------------------------------- routes

/** Admin calls come only from Hivra's server, signed like the other Hivra Workers. */
async function verifyAdmin(request: Request, env: Env, path: string, text: string): Promise<string> {
  const account = request.headers.get('x-hivra-account') ?? '';
  const timestamp = request.headers.get('x-hivra-timestamp') ?? '';
  const signature = request.headers.get('x-hivra-signature') ?? '';
  if (!account || account.length > 120 || !/^\d{9,11}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new Refusal(401, 'unauthorized', 'Not signed in.');
  }
  const digest = hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  const expected = await hmac(env.MEMORY_SECRET, `memory|v1|${request.method}|${path}|${account}|${timestamp}|${digest}`);
  if (!sameText(expected, signature)) throw new Refusal(401, 'unauthorized', 'Not signed in.');
  return account;
}

const respond = (outcome: unknown): Response => {
  const body = outcome as { ok: boolean; status?: number };
  return json(body, body.ok ? 200 : (body.status ?? 400));
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (!env.MEMORY_SECRET || env.MEMORY_SECRET.length < 32) return json({ ok: false, code: 'not_configured' }, 503);
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/health') return json({ ok: true });

      if (path.startsWith('/admin/')) {
        const text = request.method === 'GET' ? '' : await request.text();
        const account = await verifyAdmin(request, env, path, text);
        const store = env.MEMORY.get(env.MEMORY.idFromName(account));
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (path === '/admin/keys' && request.method === 'POST') {
          const scope: Scope = body.scope === 'ro' ? 'ro' : 'rw';
          const keyId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
          await store.createKey(keyId, String(body.label ?? 'agent'), scope, String(body.project ?? ''));
          return json({ ok: true, keyId, key: await mintKey(env.MEMORY_SECRET, account, keyId, scope) });
        }
        if (path === '/admin/keys' && request.method === 'GET') return json({ ok: true, keys: await store.listKeys() });
        if (path === '/admin/keys' && request.method === 'DELETE') return json({ ok: await store.revokeKey(String(body.keyId ?? '')) });
        if (path === '/admin/stats' && request.method === 'GET') return json(await store.stats());
        if (path === '/admin/account' && request.method === 'DELETE') {
          await store.destroy();
          return json({ ok: true });
        }
        return json({ ok: false, code: 'not_found' }, 404);
      }

      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? url.searchParams.get('key') ?? '';
      const key = bearer ? await readKey(env.MEMORY_SECRET, bearer) : null;
      if (!key) {
        return new Response(JSON.stringify({ ok: false, code: 'unauthorized', message: 'A memory key is needed.' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
        });
      }
      const store = env.MEMORY.get(env.MEMORY.idFromName(key.account));
      const caller: Caller = { keyId: key.keyId, scope: key.scope };

      if (path === '/mcp') return mcp(request, store, caller);
      const body = request.method === 'POST' || request.method === 'PUT' ? ((await request.json()) as Record<string, unknown>) : {};
      if (path === '/v1/remember' && request.method === 'POST') {
        const items = Array.isArray(body.items) ? (body.items as RememberInput[]) : [body as unknown as RememberInput];
        return respond(await store.remember(caller, items));
      }
      if (path === '/v1/recall' && request.method === 'POST') return respond(await store.recall(caller, body as unknown as RecallInput));
      if (path === '/v1/profile' && request.method === 'GET') return respond(await store.profile(caller));
      if (path === '/v1/profile' && request.method === 'PUT') return respond(await store.profile(caller, String(body.profile ?? '')));
      if (path === '/v1/forget' && request.method === 'POST') return respond(await store.forget(caller, body));
      if (path === '/v1/export' && request.method === 'GET') {
        const outcome = (await store.exportAll(caller, url.searchParams.get('format') === 'json' ? 'json' : 'markdown')) as {
          ok: boolean;
          markdown?: string;
        };
        if (outcome.ok && outcome.markdown !== undefined) {
          return new Response(outcome.markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });
        }
        return respond(outcome);
      }
      if (path === '/v1/activity' && request.method === 'GET') return respond(await store.activity(caller));
      return json({ ok: false, code: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof Refusal) return json({ ok: false, code: error.code, message: error.message }, error.status);
      if (error instanceof SyntaxError) return json({ ok: false, code: 'bad_request', message: 'That was not valid JSON.' }, 400);
      console.error('memory worker error', error instanceof Error ? error.message : 'unknown');
      return json({ ok: false, code: 'server_error', message: 'Something went wrong.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
