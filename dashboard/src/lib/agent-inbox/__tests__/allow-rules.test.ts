jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

type Row = Record<string, unknown>;
const state: { prompts: Row[]; rules: Row[]; agents: Row[] } = { prompts: [], rules: [], agents: [] };

function query(table: string) {
  const filters: [string, string, unknown][] = [];
  let update: Row | null = null;
  let upsert: Row | null = null;
  let insert: Row | null = null;
  const source = () => (table === "hivra_agents" ? state.agents : table === "agent_inbox_allow_rules" ? state.rules : state.prompts);
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
    update: (values: Row) => { update = values; return api; },
    upsert: (values: Row) => { upsert = values; return api; },
    insert: (values: Row) => { insert = values; return api; },
    then: (resolve: (value: unknown) => unknown) => {
      if (upsert) {
        const exists = state.prompts.some((r) => r.agent_id === upsert!.agent_id && r.prompt_id === upsert!.prompt_id);
        if (!exists) state.prompts.push({ id: `row-${state.prompts.length + 1}`, ...upsert });
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (insert) {
        state.rules.push({ id: `rule-${state.rules.length + 1}`, revoked_at: null, created_at: new Date().toISOString(), ...insert });
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (update) {
        const hit = matches();
        hit.forEach((row) => Object.assign(row, update));
        return Promise.resolve({ data: hit.map((row) => ({ id: row.id, prompt_id: row.prompt_id })), error: null }).then(resolve);
      }
      return Promise.resolve({ data: matches(), error: null }).then(resolve);
    },
  };
  return api;
}

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: string) => query(table) } }));

import { listRules, revokeRule, safeRuleCommand } from "../allow-rules";
import { answerPrompt, answersFor, recordPending } from "../prompts";

const computer = { id: "agent-1", user_id: "user-1", type: "claude-code", status: "running" };
const HOOK_CHOICES = ["once", "session", "deny"];

function pending(overrides: Record<string, unknown> = {}) {
  return {
    promptId: "p-1", kind: "approval" as const, tool: "Bash", command: "npm run build", commandComplete: true,
    choices: HOOK_CHOICES, sessionId: "s-1", ...overrides,
  };
}

const original = process.env.HIVRA_INBOX_ALWAYS_ALLOW;
beforeEach(() => {
  state.prompts = [];
  state.rules = [];
  state.agents = [{ id: "agent-1", user_id: "user-1", status: "running" }];
  process.env.HIVRA_INBOX_ALWAYS_ALLOW = "1";
});
afterAll(() => {
  if (original === undefined) delete process.env.HIVRA_INBOX_ALWAYS_ALLOW;
  else process.env.HIVRA_INBOX_ALWAYS_ALLOW = original;
});

describe("Always allow for Claude Code", () => {
  it("offers always only when the switch is on", async () => {
    await recordPending(computer, pending());
    expect(state.prompts[0].choices).toEqual(["once", "session", "always", "deny"]);
    process.env.HIVRA_INBOX_ALWAYS_ALLOW = "0";
    await recordPending(computer, pending({ promptId: "p-2" }));
    expect(state.prompts[1].choices).toEqual(HOOK_CHOICES);
  });

  it("does not offer always without a safe match", async () => {
    await recordPending(computer, pending({ promptId: "a", commandComplete: false }));
    await recordPending(computer, pending({ promptId: "b", command: "curl -H 'token=***' x" }));
    await recordPending(computer, pending({ promptId: "c", tool: "Write", command: "Write a file" }));
    await recordPending(computer, pending({ promptId: "d", tool: "Write", command: "Write ../etc/x" }));
    expect(state.prompts.map((p) => p.choices)).toEqual([HOOK_CHOICES, HOOK_CHOICES, HOOK_CHOICES, HOOK_CHOICES]);
    expect(safeRuleCommand("Write", "Write /home/bux/a.txt", true)).toBe("Write /home/bux/a.txt");
    expect(safeRuleCommand("Read", "Read /x", true)).toBeNull();
  });

  it("creates a rule when the owner answers always, and delivers it to the hook as allow", async () => {
    await recordPending(computer, pending());
    const result = await answerPrompt("user-1", "agent-1", "p-1", { choice: "always" });
    expect(result.ok).toBe(true);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]).toMatchObject({ agent_id: "agent-1", user_id: "user-1", tool: "Bash", command_pattern: "npm run build", created_from_prompt: "row-1" });
    await expect(answersFor(computer, ["p-1"])).resolves.toEqual([{ prompt_id: "p-1", choice: "once", text: null }]);
  });

  it("refuses always on a Claude Code prompt that was never offered it", async () => {
    process.env.HIVRA_INBOX_ALWAYS_ALLOW = "0";
    await recordPending(computer, pending());
    await expect(answerPrompt("user-1", "agent-1", "p-1", { choice: "always" })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(state.rules).toHaveLength(0);
  });

  it("answers the same command automatically in a new chat", async () => {
    await recordPending(computer, pending());
    await answerPrompt("user-1", "agent-1", "p-1", { choice: "always" });
    const auto = await recordPending(computer, pending({ promptId: "p-2", sessionId: "s-2" }));
    expect(auto).toEqual({ choice: "once" });
    expect(state.prompts[1]).toMatchObject({ answer_choice: "once", resolved_outcome: "allowed_always" });
    expect(state.prompts[1].resolved_at).toBeTruthy();
  });

  it("does not match a different command or another tool", async () => {
    await recordPending(computer, pending());
    await answerPrompt("user-1", "agent-1", "p-1", { choice: "always" });
    await expect(recordPending(computer, pending({ promptId: "p-2", command: "npm run build && rm -rf /" }))).resolves.toBeNull();
    await expect(recordPending(computer, pending({ promptId: "p-3", tool: "Write", command: "Write /tmp/x" }))).resolves.toBeNull();
    expect(state.prompts[1].answer_choice).toBeUndefined();
  });

  it("ignores a revoked rule", async () => {
    await recordPending(computer, pending());
    await answerPrompt("user-1", "agent-1", "p-1", { choice: "always" });
    const [rule] = (await listRules("user-1", "agent-1")) ?? [];
    await expect(revokeRule("user-2", "agent-1", rule.id)).resolves.toBe(false);
    await expect(revokeRule("user-1", "agent-1", rule.id)).resolves.toBe(true);
    await expect(listRules("user-1", "agent-1")).resolves.toEqual([]);
    await expect(recordPending(computer, pending({ promptId: "p-2" }))).resolves.toBeNull();
    expect(state.prompts[1].choices).toContain("always");
  });

  it("applies no rules when the switch is off", async () => {
    await recordPending(computer, pending());
    await answerPrompt("user-1", "agent-1", "p-1", { choice: "always" });
    process.env.HIVRA_INBOX_ALWAYS_ALLOW = "";
    await expect(recordPending(computer, pending({ promptId: "p-2" }))).resolves.toBeNull();
  });

  it("matches a file tool by exact path", async () => {
    await recordPending(computer, pending({ tool: "Write", command: "Write /home/bux/out.txt" }));
    await answerPrompt("user-1", "agent-1", "p-1", { choice: "always" });
    await expect(recordPending(computer, pending({ promptId: "p-2", tool: "Write", command: "Write /home/bux/out.txt" }))).resolves.toEqual({ choice: "once" });
    await expect(recordPending(computer, pending({ promptId: "p-3", tool: "Write", command: "Write /home/bux/other.txt" }))).resolves.toBeNull();
  });

  it("leaves Hermes prompts (no tool) alone", async () => {
    await recordPending(computer, { promptId: "h-1", kind: "approval", command: "ls", commandComplete: true, choices: ["once", "always", "deny"] });
    expect(state.prompts[0].choices).toEqual(["once", "always", "deny"]);
    await answerPrompt("user-1", "agent-1", "h-1", { choice: "always" });
    expect(state.rules).toHaveLength(0);
    await expect(answersFor(computer, ["h-1"])).resolves.toEqual([{ prompt_id: "h-1", choice: "always", text: null }]);
  });
});
