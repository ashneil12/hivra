const mockLoadSecret = jest.fn();
const mockLoadTarget = jest.fn();
const mockCreateRecord = jest.fn();
const mockReplaceToken = jest.fn();
const mockRefreshRecord = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/infrastructure/digitalocean-store", () => ({
  loadDigitalOceanConnectionSecret: (...args: unknown[]) => mockLoadSecret(...args),
  loadDigitalOceanTarget: (...args: unknown[]) => mockLoadTarget(...args),
  createDigitalOceanConnectionRecord: (...args: unknown[]) => mockCreateRecord(...args),
  refreshDigitalOceanTargetRecord: (...args: unknown[]) => mockRefreshRecord(...args),
  replaceDigitalOceanConnectionToken: (...args: unknown[]) => mockReplaceToken(...args),
}));

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { hivra_agents: [], hivra_do_session_inputs: [], infrastructure_connections: [] };

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;
  private inserted: Row | null = null;
  constructor(private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  insert(row: Row) { this.inserted = row; return this; }
  update(patch: Row) { this.patch = patch; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this; }
  private run(): { data: unknown; error: unknown } {
    const rows = tables[this.table];
    if (this.inserted) {
      const row: Row = { created_at: new Date().toISOString(), error: null, provisioned_at: null, do_session_id: null, do_session_observation: null, ...this.inserted };
      if (this.table === "hivra_do_session_inputs" && rows.some((existing) => existing.agent_id === row.agent_id && existing.run_id === row.run_id)) {
        return { data: null, error: { code: "23505" } };
      }
      rows.push(row);
      return { data: { ...row }, error: null };
    }
    const matches = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.patch) {
      for (const row of matches) Object.assign(row, this.patch);
    }
    return { data: matches.map((row) => ({ ...row })), error: null };
  }
  maybeSingle() { const result = this.run(); return Promise.resolve({ ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data }); }
  single() { return this.maybeSingle(); }
  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return Promise.resolve(this.run()).then(resolve, reject); }
}

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: string) => new Query(table) } }));

import { DigitalOceanApiError } from "@/lib/digitalocean/managed-agents-client";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import {
  connectDigitalOcean,
  replaceDigitalOceanToken,
  digitalOceanSessionName,
  launchDigitalOceanSession,
  managedSessionAction,
  readManagedSessionHistory,
  resolveManagedSessionApproval,
  sendManagedSessionInput,
  setManagedSessionDependenciesForTest,
} from "../do-managed-sessions";
import { FakeDigitalOcean } from "./helpers/fake-digitalocean";

const userId = "user_do";
const connectionId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const TOKEN = "dop_v1_" + "b".repeat(64);
const ANTHROPIC_KEY = "sk-ant-" + "c".repeat(40);

const target = {
  id: targetId, connectionId, evidenceConnectionRevision: 1, status: "ready",
  capabilities: { harnesses: ["claude-code", "codex", "hermes"], sizes: ["mars-1vcpu-1gb", "mars-2vcpu-4gb"] },
};

let fake: FakeDigitalOcean;
let restore: () => void;
let vendorFetch: jest.Mock;

function launchInput(overrides: Record<string, unknown> = {}) {
  return {
    launchRequestId: "33333333-3333-4333-8333-" + String(Math.floor(Math.random() * 1e12)).padStart(12, "0"),
    connectionId, targetId, harness: "claude-code" as const, size: "mars-2vcpu-4gb" as const, name: "Builder",
    model: { mode: "vendor" as const, apiKey: ANTHROPIC_KEY },
    ...overrides,
  };
}

beforeEach(() => {
  tables.hivra_agents = [];
  tables.hivra_do_session_inputs = [];
  tables.infrastructure_connections = [{ id: connectionId, user_id: userId, provider: "digitalocean", revision: 1 }];
  fake = new FakeDigitalOcean();
  vendorFetch = jest.fn(async () => new Response("{}", { status: 200 }));
  restore = setManagedSessionDependenciesForTest({ client: fake.client, sleep: async () => undefined, fetch: vendorFetch as unknown as typeof fetch });
  mockLoadTarget.mockResolvedValue(target);
  mockLoadSecret.mockResolvedValue({ connection: { id: connectionId, status: "ready" }, revision: 1, apiToken: TOKEN });
});
afterEach(() => restore());

describe("connectDigitalOcean", () => {
  it("publishes only the sandbox sizes Hivra supports and stores the token once validated", async () => {
    mockCreateRecord.mockImplementation(async (input) => ({ connection: { id: connectionId }, target: input.target }));
    await connectDigitalOcean(userId, { name: "Team", apiToken: TOKEN });
    const stored = mockCreateRecord.mock.calls[0][0];
    expect(stored.apiToken).toBe(TOKEN);
    expect(stored.target.capabilities).toMatchObject({ kind: "digitalocean-managed-agents", launchReady: true, sizes: ["mars-1vcpu-1gb", "mars-2vcpu-4gb"] });
    expect(stored.target.capacity.sizes.map((size: { slug: string }) => size.slug)).not.toContain("mars-8vcpu-64gb");
  });

  it("refuses a token DigitalOcean rejects without storing anything", async () => {
    await expect(connectDigitalOcean(userId, { name: "Team", apiToken: "bad-token-000000000000000" })).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(mockCreateRecord).not.toHaveBeenCalled();
  });
});

describe("launchDigitalOceanSession", () => {
  it("creates one ask-by-default session under the deterministic name and reaches running only after READY", async () => {
    fake.readyAfterPolls = 1;
    const session = await launchDigitalOceanSession(userId, launchInput({ firstTask: "Summarize the repo" }));
    expect(session.status).toBe("ready");
    const row = tables.hivra_agents[0];
    expect(row).toMatchObject({ computer_substrate: "do-managed-session", status: "running", do_session_id: "sess_1", cpu: 2, ram: 4 });
    expect(fake.manifests).toHaveLength(1);
    expect(fake.manifests[0]).toEqual({
      name: digitalOceanSessionName(String(row.id)), agent: "claude-code", description: "Hivra agent Builder", size: "mars-2vcpu-4gb",
      persistent_workspace: true, secrets: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, permissions: { default: "ask" },
    });
    // The model key is a write-only session secret: Hivra never persists it.
    expect(JSON.stringify(tables.hivra_agents)).not.toContain(ANTHROPIC_KEY);
    expect(fake.inputs).toEqual([{ sessionId: "sess_1", text: "Summarize the repo" }]);
    expect(tables.hivra_do_session_inputs).toEqual([expect.objectContaining({ run_id: "run_1", text: "Summarize the repo" })]);
  });

  it("replays the same launch request instead of creating a second billable session", async () => {
    const input = launchInput();
    await launchDigitalOceanSession(userId, input);
    await launchDigitalOceanSession(userId, input);
    expect(fake.manifests).toHaveLength(1);
    expect(tables.hivra_agents).toHaveLength(1);
    await expect(launchDigitalOceanSession(userId, { ...input, size: "mars-1vcpu-1gb" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("closes the reservation with a never-created receipt when DigitalOcean refuses the create", async () => {
    fake.failNextCreate = { error: new DigitalOceanApiError("payment_required", 402, "POST", "/v2/agents/sessions") };
    await expect(launchDigitalOceanSession(userId, launchInput())).rejects.toMatchObject({ code: "payment_required" });
    expect(tables.hivra_agents[0]).toMatchObject({
      status: "deleted", infrastructure_connection_id: null, deployment_target_id: null,
      do_cleanup_receipt: expect.objectContaining({ state: "never-created" }),
    });
  });

  it("keeps an ambiguous create and reconciles it by name instead of creating again", async () => {
    fake.failNextCreate = { error: new DigitalOceanApiError("timeout", null, "POST", "/v2/agents/sessions"), createAnyway: true };
    await expect(launchDigitalOceanSession(userId, launchInput())).rejects.toMatchObject({ code: "provider_unavailable" });
    const row = tables.hivra_agents[0];
    expect(row).toMatchObject({ status: "provisioning", do_session_id: null });
    const deleted = await managedSessionAction(userId, String(row.id), "delete");
    expect(deleted.status).toBe("deleted");
    expect([...fake.sessions.values()].map((session) => session.status)).toEqual(["SESSION_STATUS_DESTROYED"]);
    expect(tables.hivra_agents[0].do_cleanup_receipt).toMatchObject({ state: "absent", sessionId: "sess_1" });
    expect(fake.manifests).toHaveLength(1);
  });

  it("rejects a vendor key the vendor refuses before creating anything", async () => {
    vendorFetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(launchDigitalOceanSession(userId, launchInput())).rejects.toMatchObject({ code: "model_key_rejected" });
    expect(fake.manifests).toHaveLength(0);
    expect(tables.hivra_agents).toHaveLength(0);
  });

  it("requires DigitalOcean Inference for Hermes and turns off keep_warm", async () => {
    await expect(launchDigitalOceanSession(userId, launchInput({ harness: "hermes" }))).rejects.toMatchObject({ code: "invalid_request" });
    await launchDigitalOceanSession(userId, launchInput({ harness: "hermes", model: { mode: "digitalocean-inference", apiKey: "do-model-" + "d".repeat(30), model: "deepseek-v4-pro" } }));
    expect(fake.manifests[0]).toMatchObject({ agent: "hermes", keep_warm: false, env: { HARNESS_INFERENCE_MODEL: "deepseek-v4-pro" }, secrets: { HARNESS_INFERENCE_API_KEY: expect.any(String) } });
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("refuses a target that does not offer the requested size", async () => {
    await expect(launchDigitalOceanSession(userId, launchInput({ size: "mars-16vcpu-32gb" }))).rejects.toMatchObject({ code: "not_ready" });
    expect(tables.hivra_agents).toHaveLength(0);
  });
});

describe("session lifecycle", () => {
  async function launched() {
    await launchDigitalOceanSession(userId, launchInput());
    return String(tables.hivra_agents[0].id);
  }

  it("maps pause and resume to DigitalOcean's observed state", async () => {
    const agentId = await launched();
    await expect(managedSessionAction(userId, agentId, "pause")).resolves.toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(tables.hivra_agents[0]).toMatchObject({ status: "stopped", desired_state: "stopped" });
    await expect(managedSessionAction(userId, agentId, "resume")).resolves.toMatchObject({ status: "ready" });
  });

  it("forwards input to a paused session, which DigitalOcean resumes, and records the prompt", async () => {
    const agentId = await launched();
    await managedSessionAction(userId, agentId, "pause");
    await expect(sendManagedSessionInput(userId, agentId, "keep going")).resolves.toEqual({ runId: "run_1" });
    expect(tables.hivra_agents[0].status).toBe("running");
    expect(tables.hivra_do_session_inputs).toEqual([expect.objectContaining({ run_id: "run_1", text: "keep going" })]);
  });

  it("sends approvals out of band and returns sanitized history with recorded prompts", async () => {
    const agentId = await launched();
    await resolveManagedSessionApproval(userId, agentId, "hitl_1", "reject");
    expect(fake.decisions).toEqual([{ sessionId: "sess_1", requestId: "hitl_1", outcome: "HITL_OUTCOME_REJECT" }]);
    await sendManagedSessionInput(userId, agentId, "hello");
    fake.events = [
      { eventId: "e1", runId: "run_1", seq: 1, at: null, type: "run.token_delta", data: { text: "hi", source_raw: "raw" } },
      { eventId: "e2", runId: "run_1", seq: 2, at: null, type: "run.sandbox_allocated", data: {} },
    ];
    const history = await readManagedSessionHistory(userId, agentId);
    expect(history.events).toEqual([{ id: "e1", runId: "run_1", type: "run.token_delta", at: null, data: { text: "hi", isReasoning: false } }]);
    expect(history.prompts).toEqual([expect.objectContaining({ runId: "run_1", text: "hello" })]);
  });

  it("deletes only after DigitalOcean reports the session gone", async () => {
    const agentId = await launched();
    fake.destroyedAfterPolls = 1;
    const deleted = await managedSessionAction(userId, agentId, "delete");
    expect(deleted.status).toBe("deleted");
    expect(tables.hivra_agents[0]).toMatchObject({
      status: "deleted", infrastructure_connection_id: null,
      do_cleanup_receipt: expect.objectContaining({ state: "absent", sessionId: "sess_1", binding: { connectionId, targetId, connectionRevision: "1" } }),
    });
    await expect(sendManagedSessionInput(userId, agentId, "hello?")).rejects.toMatchObject({ code: "not_ready" });
  });

  it("refuses to act when the connection was re-bound under a newer revision", async () => {
    const agentId = await launched();
    mockLoadSecret.mockResolvedValue({ connection: { id: connectionId, status: "ready" }, revision: 2, apiToken: TOKEN });
    await expect(managedSessionAction(userId, agentId, "pause")).rejects.toMatchObject({ code: "not_ready" });
  });
});

describe("replaceDigitalOceanToken", () => {
  const NEW_TOKEN = "dop_v1_" + "9".repeat(64);
  beforeEach(() => {
    mockRefreshRecord.mockImplementation(async (input) => ({ connection: { id: connectionId, status: input.errorCode ? "error" : "ready" }, target: input.target }));
  });

  it("swaps in a token from the same team without touching the agents, then republishes the target", async () => {
    await launchDigitalOceanSession(userId, launchInput());
    const before = { ...tables.hivra_agents[0] };
    await expect(replaceDigitalOceanToken(userId, connectionId, NEW_TOKEN)).resolves.toMatchObject({ connection: { status: "ready" } });
    expect(mockReplaceToken).toHaveBeenCalledWith({ userId, connectionId, expectedRevision: 1, apiToken: NEW_TOKEN });
    expect(tables.hivra_agents[0]).toEqual(before);
  });

  it("refuses a token from another team that cannot see this connection's sessions", async () => {
    await launchDigitalOceanSession(userId, launchInput());
    fake.sessions.clear();
    await expect(replaceDigitalOceanToken(userId, connectionId, NEW_TOKEN)).rejects.toMatchObject({ code: "provider_rejected" });
    expect(mockReplaceToken).not.toHaveBeenCalled();
  });

  it("refuses a token DigitalOcean rejects", async () => {
    await expect(replaceDigitalOceanToken(userId, connectionId, "bad-token-000000000000000")).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(mockReplaceToken).not.toHaveBeenCalled();
  });

  it("still repairs a connection whose stored token can no longer be read", async () => {
    mockLoadSecret.mockRejectedValueOnce(new InfrastructureConnectionStoreError("credential_error", 1));
    await replaceDigitalOceanToken(userId, connectionId, NEW_TOKEN);
    expect(mockReplaceToken).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, apiToken: NEW_TOKEN }));
  });
});
