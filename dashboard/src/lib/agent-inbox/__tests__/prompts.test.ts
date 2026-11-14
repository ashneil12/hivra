jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const state: { rows: Record<string, unknown>[]; updates: Record<string, unknown>[]; agents: Record<string, unknown>[] } = { rows: [], updates: [], agents: [] };

function query(table: string) {
  const filters: [string, string, unknown][] = [];
  let update: Record<string, unknown> | null = null;
  const source = () => (table === "hivra_agents" ? state.agents : state.rows);
  const matches = () => source().filter((row) => filters.every(([op, key, value]) =>
    op === "eq" ? row[key] === value
      : op === "neq" ? row[key] !== value
        : op === "is" ? (row[key] ?? null) === value
          : op === "in" ? (value as unknown[]).includes(row[key])
            : op === "notnull" ? row[key] != null
              : true));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return api; },
    neq: (k: string, v: unknown) => { filters.push(["neq", k, v]); return api; },
    is: (k: string, v: unknown) => { filters.push(["is", k, v]); return api; },
    in: (k: string, v: unknown) => { filters.push(["in", k, v]); return api; },
    not: (k: string) => { filters.push(["notnull", k, null]); return api; },
    gt: () => api,
    order: () => api,
    limit: () => Promise.resolve({ data: matches(), error: null }),
    maybeSingle: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
    update: (values: Record<string, unknown>) => { update = values; return api; },
    then: (resolve: (value: unknown) => unknown) => {
      if (update) {
        const hit = matches();
        hit.forEach((row) => Object.assign(row, update));
        state.updates.push(update);
        return Promise.resolve({ data: hit.map((row) => ({ prompt_id: row.prompt_id })), error: null }).then(resolve);
      }
      return Promise.resolve({ data: matches(), error: null }).then(resolve);
    },
  };
  return api;
}

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: string) => query(table) } }));

import { answerPrompt, computerForToken, inboxAnswersEnabled } from "../prompts";

const TOKEN = "b".repeat(64);
const future = () => new Date(Date.now() + 5 * 60_000).toISOString();

function row(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "agent-1", user_id: "user-1", prompt_id: "req-1", kind: "approval", summary: "delete files",
    command: "rm -rf dist", command_complete: true, choices: ["once", "session", "always", "deny"],
    created_at: new Date().toISOString(), expires_at: future(), answer_choice: null, answered_at: null, resolved_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.rows = [row()];
  state.updates = [];
  state.agents = [{ id: "agent-1", user_id: "user-1", type: "hermes", status: "running", api_token: TOKEN }];
});

describe("inboxAnswersEnabled", () => {
  it("is off unless the switch is set", () => {
    expect(inboxAnswersEnabled({})).toBe(false);
    expect(inboxAnswersEnabled({ HIVRA_INBOX_ANSWERS: "0" })).toBe(false);
    expect(inboxAnswersEnabled({ HIVRA_INBOX_ANSWERS: "1" })).toBe(true);
  });
});

describe("computerForToken", () => {
  it("finds the computer by its box token and nothing else", async () => {
    await expect(computerForToken(`Bearer ${TOKEN}`)).resolves.toMatchObject({ id: "agent-1", user_id: "user-1" });
    await expect(computerForToken(`Bearer ${"c".repeat(64)}`)).resolves.toBeNull();
    await expect(computerForToken("Bearer short")).resolves.toBeNull();
    await expect(computerForToken(null)).resolves.toBeNull();
  });
});

describe("answerPrompt", () => {
  it("records an allowed answer for the owner", async () => {
    const result = await answerPrompt("user-1", "agent-1", "req-1", { choice: "once" });
    expect(result).toMatchObject({ ok: true, prompt: { answeredChoice: "once" } });
    expect(state.rows[0]).toMatchObject({ answer_choice: "once", answer_text: null });
  });

  it("keeps a reason only with a no", async () => {
    await answerPrompt("user-1", "agent-1", "req-1", { choice: "deny", text: " keep the cache " });
    expect(state.rows[0]).toMatchObject({ answer_choice: "deny", answer_text: "keep the cache" });
  });

  it("never answers for someone else", async () => {
    await expect(answerPrompt("user-2", "agent-1", "req-1", { choice: "once" })).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("refuses an allow when the whole command could not be shown", async () => {
    state.rows = [row({ command_complete: false })];
    await expect(answerPrompt("user-1", "agent-1", "req-1", { choice: "once" })).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(answerPrompt("user-1", "agent-1", "req-1", { choice: "deny" })).resolves.toMatchObject({ ok: true });
  });

  it("refuses answers Hermes did not offer, questions, and finished prompts", async () => {
    state.rows = [row({ choices: ["once", "deny"] })];
    await expect(answerPrompt("user-1", "agent-1", "req-1", { choice: "always" })).resolves.toMatchObject({ ok: false, status: 400 });
    state.rows = [row({ kind: "clarify", choices: [] })];
    await expect(answerPrompt("user-1", "agent-1", "req-1", { choice: "once" })).resolves.toMatchObject({ ok: false, status: 400 });
    state.rows = [row({ resolved_at: new Date().toISOString() })];
    await expect(answerPrompt("user-1", "agent-1", "req-1", { choice: "once" })).resolves.toMatchObject({ ok: false, status: 409 });
    state.rows = [row({ answered_at: new Date().toISOString(), answer_choice: "deny" })];
    await expect(answerPrompt("user-1", "agent-1", "req-1", { choice: "once" })).resolves.toMatchObject({ ok: false, status: 409 });
  });
});
