import { randomUUID } from "node:crypto";

const mockLoadSecret = jest.fn();
const mockLoadTarget = jest.fn();
const mockCreateRecord = jest.fn();
const mockReplaceToken = jest.fn();
const mockRefreshRecord = jest.fn();
const mockRecordExpiry = jest.fn();
const mockLoadExpiries = jest.fn();
const mockClearExpiry = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/infrastructure/digitalocean-store", () => ({
  loadDigitalOceanConnectionSecret: (...args: unknown[]) => mockLoadSecret(...args),
  loadDigitalOceanTarget: (...args: unknown[]) => mockLoadTarget(...args),
  createDigitalOceanConnectionRecord: (...args: unknown[]) => mockCreateRecord(...args),
  refreshDigitalOceanTargetRecord: (...args: unknown[]) => mockRefreshRecord(...args),
  replaceDigitalOceanConnectionToken: (...args: unknown[]) => mockReplaceToken(...args),
}));

jest.mock("@/lib/infrastructure/credential-expiry-store", () => ({
  ...jest.requireActual("@/lib/infrastructure/credential-expiry-store"),
  recordCredentialExpiry: (...args: unknown[]) => mockRecordExpiry(...args),
  loadCredentialExpiries: (...args: unknown[]) => mockLoadExpiries(...args),
  clearCredentialExpiry: (...args: unknown[]) => mockClearExpiry(...args),
}));

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { hivra_agents: [], hivra_do_session_inputs: [], infrastructure_connections: [], hivra_computer_contracts: [] };

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
      const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), error: null, provisioned_at: null, do_session_id: null, do_session_observation: null, ...this.inserted };
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
  downloadManagedSessionWorkspace,
  forgetManagedSession,
  listDigitalOceanModelsForConnection,
  readDigitalOceanBalance,
  listManagedSessionWorkspace,
  replaceDigitalOceanToken,
  setDigitalOceanTokenExpiry,
  digitalOceanSessionName,
  launchDigitalOceanSession,
  managedSessionAction,
  readManagedSessionHistory,
  resolveManagedSessionApproval,
  sendManagedSessionInput,
  sendManagedSessionSetupNote,
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
  tables.hivra_computer_contracts = [];
  tables.infrastructure_connections = [{ id: connectionId, user_id: userId, provider: "digitalocean", revision: 1 }];
  fake = new FakeDigitalOcean();
  vendorFetch = jest.fn(async () => new Response("{}", { status: 200 }));
  restore = setManagedSessionDependenciesForTest({ client: fake.client, sleep: async () => undefined, fetch: vendorFetch as unknown as typeof fetch });
  mockLoadTarget.mockResolvedValue(target);
  mockLoadSecret.mockResolvedValue({ connection: { id: connectionId, status: "ready" }, revision: 1, apiToken: TOKEN });
  mockRecordExpiry.mockReset().mockImplementation(async (input) => ({
    source: "owner-declared", noExpiry: input.expiry.mode === "none",
    expiresOn: input.expiry.mode === "date" ? input.expiry.date : null, declaredAt: input.now.toISOString(),
  }));
  mockLoadExpiries.mockReset().mockResolvedValue(new Map());
  mockClearExpiry.mockReset().mockResolvedValue(undefined);
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
    // The visible Hivra setup note goes first, then the owner's first task.
    expect(fake.inputs).toEqual([
      { sessionId: "sess_1", text: expect.stringContaining("## Your computer (from Hivra, revision 1)") },
      { sessionId: "sess_1", text: "Summarize the repo" },
    ]);
    expect(tables.hivra_do_session_inputs).toEqual([
      expect.objectContaining({ run_id: "run_1", source: "hivra-setup", text: expect.stringContaining("Reply only \"Ready.\"") }),
      expect.objectContaining({ run_id: "run_2", text: "Summarize the repo" }),
    ]);
    expect(tables.hivra_do_session_inputs[1]).not.toHaveProperty("source");
  });

  it("tells the agent where it runs in a visible setup note and records it as sent, never delivered", async () => {
    await launchDigitalOceanSession(userId, launchInput({ harness: "codex", model: { mode: "vendor", apiKey: "sk-" + "o".repeat(40) } }));
    const [setup] = fake.inputs;
    expect(setup.text).toContain("You are the Codex agent \"Builder\". You run in a DigitalOcean Managed Agents session");
    expect(setup.text).toContain("a sandbox with 2 CPU and 4 GB of memory");
    expect(setup.text).toContain("Keep your work in /workspace.");
    expect(tables.hivra_computer_contracts).toEqual([expect.objectContaining({
      revision: 1, channel: "do-setup-message", delivery_state: "sent",
      receipt: expect.objectContaining({ channel: "do-setup-message", runId: "run_1", revision: 1 }),
    })]);
    expect(tables.hivra_computer_contracts[0].delivery_state).not.toBe("delivered");
  });

  it("still launches and sends the first task when the setup note cannot be sent", async () => {
    const sendInput = fake.client;
    let calls = 0;
    restore();
    restore = setManagedSessionDependenciesForTest({
      client: (token: string) => {
        const client = sendInput(token);
        return { ...client, sendInput: async (sessionId: string, text: string) => {
          calls += 1;
          if (calls === 1) throw new DigitalOceanApiError("timeout", null, "POST", "/v2/agents/sessions/input");
          return client.sendInput(sessionId, text);
        } };
      },
      sleep: async () => undefined, fetch: vendorFetch as unknown as typeof fetch,
    });
    const session = await launchDigitalOceanSession(userId, launchInput({ firstTask: "Summarize the repo" }));
    expect(session.status).toBe("ready");
    expect(fake.inputs).toEqual([{ sessionId: "sess_1", text: "Summarize the repo" }]);
    const contract = tables.hivra_computer_contracts[0];
    expect(contract).toMatchObject({ last_error: "send_failed" });
    expect(contract.delivery_state).not.toBe("sent");
    expect(contract.delivered_at ?? null).toBeNull();
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

// INF-16: every DigitalOcean launch asked for the provider key again, because
// only a pasted key was accepted. A launch can now name a key the owner saved
// in their Vault, which is read here for that owner only.
describe("launchDigitalOceanSession with a saved Vault key", () => {
  const VAULT_KEY_ID = "44444444-4444-4444-8444-444444444444";
  const SAVED_OPENAI_KEY = "sk-" + "v".repeat(40);
  let readSavedModelKey: jest.Mock;

  beforeEach(() => {
    readSavedModelKey = jest.fn(async () => ({ provider: "openai", apiKey: SAVED_OPENAI_KEY }));
    restore();
    restore = setManagedSessionDependenciesForTest({
      client: fake.client, sleep: async () => undefined, fetch: vendorFetch as unknown as typeof fetch, readSavedModelKey,
    });
  });

  const vaultLaunch = (overrides: Record<string, unknown> = {}) => launchInput({
    harness: "codex", model: { mode: "vendor", vaultKeyId: VAULT_KEY_ID }, ...overrides,
  });

  it("sends the owner's saved key to DigitalOcean as the session secret, and stores neither it nor the reference", async () => {
    await launchDigitalOceanSession(userId, vaultLaunch());

    expect(readSavedModelKey).toHaveBeenCalledWith(userId, VAULT_KEY_ID);
    expect(fake.manifests).toHaveLength(1);
    expect(fake.manifests[0]).toMatchObject({ agent: "codex", secrets: { OPENAI_API_KEY: SAVED_OPENAI_KEY } });
    // Checked with the vendor like a pasted key, before anything is created.
    expect(vendorFetch).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
      headers: { Authorization: `Bearer ${SAVED_OPENAI_KEY}` },
    }));
    expect(JSON.stringify(tables.hivra_agents)).not.toContain(SAVED_OPENAI_KEY);
    expect(JSON.stringify(tables.hivra_agents)).not.toContain(VAULT_KEY_ID);
  });

  it.each([
    ["isn't the owner's", null],
    ["is saved for another provider", { provider: "anthropic", apiKey: "sk-ant-" + "a".repeat(40) }],
    ["is a ChatGPT sign-in, not an API key", { provider: "codex", apiKey: "x".repeat(40) }],
    ["has no stored key", { provider: "openai", apiKey: null }],
  ])("launches nothing when the saved key %s", async (_label, saved) => {
    readSavedModelKey.mockResolvedValueOnce(saved);
    await expect(launchDigitalOceanSession(userId, vaultLaunch())).rejects.toMatchObject({
      code: "not_found",
      message: "That saved OpenAI API key is no longer in your Vault. Paste the key, or choose another option.",
    });
    expect(fake.manifests).toHaveLength(0);
    expect(tables.hivra_agents).toHaveLength(0);
  });

  it("reports an unreadable Vault as a retry, and launches nothing", async () => {
    readSavedModelKey.mockRejectedValueOnce(new Error("db down"));
    await expect(launchDigitalOceanSession(userId, vaultLaunch())).rejects.toMatchObject({ code: "database_failed" });
    expect(fake.manifests).toHaveLength(0);
    expect(tables.hivra_agents).toHaveLength(0);
  });

  it("refuses a saved key that isn't a complete key before DigitalOcean sees it", async () => {
    readSavedModelKey.mockResolvedValueOnce({ provider: "openai", apiKey: "sk short" });
    await expect(launchDigitalOceanSession(userId, vaultLaunch())).rejects.toMatchObject({ code: "invalid_request" });
    expect(vendorFetch).not.toHaveBeenCalled();
    expect(fake.manifests).toHaveLength(0);
  });

  it("answers a replay with the agent the first request created, without reading the Vault again", async () => {
    const input = vaultLaunch();
    await launchDigitalOceanSession(userId, input);
    readSavedModelKey.mockClear();
    await launchDigitalOceanSession(userId, input);
    expect(readSavedModelKey).not.toHaveBeenCalled();
    expect(fake.manifests).toHaveLength(1);
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
    // run_1 is the launch's setup note.
    await expect(sendManagedSessionInput(userId, agentId, "keep going")).resolves.toEqual({ runId: "run_2" });
    expect(tables.hivra_agents[0].status).toBe("running");
    expect(tables.hivra_do_session_inputs).toEqual([
      expect.objectContaining({ run_id: "run_1", source: "hivra-setup" }),
      expect.objectContaining({ run_id: "run_2", text: "keep going" }),
    ]);
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
    // The in-memory store ignores ordering; the real query is chronological.
    expect(history.prompts).toHaveLength(2);
    expect(history.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run_1", source: "hivra-setup", text: expect.stringContaining("Hivra") }),
      expect.objectContaining({ runId: "run_2", text: "hello", source: "user" }),
    ]));
  });

  it("sends the current setup note again only when the owner asks, as one more visible message", async () => {
    const agentId = await launched();
    tables.hivra_agents[0].name = "Builder 2";
    await expect(sendManagedSessionSetupNote(userId, agentId)).resolves.toEqual({ runId: "run_2", revision: 2 });
    expect(fake.inputs[1].text).toContain("\"Builder 2\"");
    expect(tables.hivra_computer_contracts.map((row) => [row.revision, row.delivery_state])).toEqual([[1, "sent"], [2, "sent"]]);
    expect(tables.hivra_do_session_inputs[1]).toMatchObject({ run_id: "run_2", source: "hivra-setup" });
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
    await expect(managedSessionAction(userId, agentId, "pause")).rejects.toMatchObject({ code: "connection_changed" });
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

describe("owner-declared token expiry", () => {
  const NEW_TOKEN = "dop_v1_" + "9".repeat(64);
  const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

  it("records the date the owner declared at connect and returns it on the connection", async () => {
    mockCreateRecord.mockImplementation(async (input) => ({ connection: { id: connectionId }, target: input.target }));
    const result = await connectDigitalOcean(userId, { name: "Team", apiToken: TOKEN, tokenExpiry: { mode: "date", date: soon } });
    expect(mockRecordExpiry).toHaveBeenCalledWith(expect.objectContaining({ userId, connectionId, expiry: { mode: "date", date: soon } }));
    expect(result.connection.credentialExpiry).toMatchObject({ source: "owner-declared", noExpiry: false, expiresOn: soon });
  });

  it("refuses a date that has already passed before calling DigitalOcean", async () => {
    await expect(connectDigitalOcean(userId, { name: "Team", apiToken: TOKEN, tokenExpiry: { mode: "date", date: "2020-01-01" } }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.tokens).toHaveLength(0);
    expect(mockCreateRecord).not.toHaveBeenCalled();
  });

  it("still connects when the reminder cannot be saved, and reports no recorded expiry", async () => {
    mockCreateRecord.mockImplementation(async (input) => ({ connection: { id: connectionId }, target: input.target }));
    mockRecordExpiry.mockRejectedValueOnce(new InfrastructureConnectionStoreError("database_error"));
    const result = await connectDigitalOcean(userId, { name: "Team", apiToken: TOKEN, tokenExpiry: { mode: "none" } });
    expect(result.connection.credentialExpiry).toBeNull();
  });

  it("clears the old token's date when a replacement token has none, and records a new one when given", async () => {
    mockRefreshRecord.mockImplementation(async (input) => ({ connection: { id: connectionId, status: "ready" }, target: input.target }));
    await replaceDigitalOceanToken(userId, connectionId, NEW_TOKEN);
    expect(mockClearExpiry).toHaveBeenCalledWith(userId, connectionId);
    const replaced = await replaceDigitalOceanToken(userId, connectionId, NEW_TOKEN, { mode: "none" });
    expect(replaced.connection.credentialExpiry).toMatchObject({ noExpiry: true, expiresOn: null });
  });

  it("sets a reminder on an existing connection only for its owner", async () => {
    await expect(setDigitalOceanTokenExpiry("someone_else", connectionId, { mode: "none" })).rejects.toMatchObject({ code: "not_found" });
    await expect(setDigitalOceanTokenExpiry(userId, connectionId, { mode: "date", date: soon })).resolves.toMatchObject({ expiresOn: soon });
  });
});

describe("forgetManagedSession", () => {
  async function launched() {
    await launchDigitalOceanSession(userId, launchInput());
    return String(tables.hivra_agents[0].id);
  }

  it("releases an agent whose token DigitalOcean now rejects, without deleting the session there", async () => {
    const agentId = await launched();
    fake.rejectedTokens.add(TOKEN);
    await expect(forgetManagedSession(userId, agentId)).resolves.toMatchObject({ status: "deleted" });
    expect(tables.hivra_agents[0]).toMatchObject({
      status: "deleted", infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null,
      do_cleanup_receipt: expect.objectContaining({
        state: "forgotten", reason: "token_rejected", sessionId: "sess_1", acknowledgedAt: expect.any(String),
        binding: { connectionId, targetId, connectionRevision: "1" },
      }),
    });
    // Nothing was destroyed: the session is still at DigitalOcean.
    expect(fake.sessions.get("sess_1")?.status).toBe("SESSION_STATUS_READY");
  });

  it("releases an agent whose saved token can no longer be decrypted", async () => {
    const agentId = await launched();
    mockLoadSecret.mockRejectedValueOnce(new InfrastructureConnectionStoreError("credential_error", 1));
    await forgetManagedSession(userId, agentId);
    expect(tables.hivra_agents[0].do_cleanup_receipt).toMatchObject({ state: "forgotten", reason: "token_unreadable" });
  });

  it("sends the owner to Delete while Hivra can still reach the session", async () => {
    const agentId = await launched();
    const before = { ...tables.hivra_agents[0] };
    await expect(forgetManagedSession(userId, agentId)).rejects.toMatchObject({ code: "conflict" });
    expect(tables.hivra_agents[0]).toEqual(before);
  });

  it("uses the ordinary absence receipt when DigitalOcean reports the session gone", async () => {
    const agentId = await launched();
    fake.sessions.clear();
    await forgetManagedSession(userId, agentId);
    expect(tables.hivra_agents[0].do_cleanup_receipt).toMatchObject({ state: "absent", sessionId: "sess_1" });
  });

  it("does not forget on a transient DigitalOcean outage", async () => {
    const agentId = await launched();
    mockLoadSecret.mockResolvedValueOnce({ connection: { id: connectionId, status: "ready" }, revision: 1, apiToken: "outage-token-000000000000" });
    const outage = fake.client("outage-token-000000000000");
    const restoreOutage = setManagedSessionDependenciesForTest({
      client: () => ({ ...outage, getSession: async () => { throw new DigitalOceanApiError("unavailable", 503, "GET", "/v2/agents/sessions"); } }),
    });
    try {
      await expect(forgetManagedSession(userId, agentId)).rejects.toMatchObject({ code: "provider_unavailable" });
    } finally {
      restoreOutage();
    }
    expect(tables.hivra_agents[0].status).toBe("running");
  });

  it("only forgets the owner's own agents", async () => {
    const agentId = await launched();
    fake.rejectedTokens.add(TOKEN);
    await expect(forgetManagedSession("someone_else", agentId)).rejects.toMatchObject({ code: "not_found" });
    expect(tables.hivra_agents[0].status).toBe("running");
  });
});

describe("workspace files", () => {
  async function launched() {
    await launchDigitalOceanSession(userId, launchInput());
    return String(tables.hivra_agents[0].id);
  }

  beforeEach(() => {
    fake.workspace.set("README.md", { kind: "f", size: 12, content: "hello world\n" });
    fake.workspace.set("src", { kind: "d" });
    fake.workspace.set("src/app.ts", { kind: "f", size: 40, content: "export {}" });
    fake.workspace.set("a-file.txt", { kind: "f", size: 3, content: "abc" });
  });

  it("lists one folder with folders first and passes the path as an argument, never inside the script", async () => {
    const agentId = await launched();
    const root = await listManagedSessionWorkspace(userId, agentId, "");
    expect(root.entries.map((entry) => [entry.kind, entry.name])).toEqual([["directory", "src"], ["file", "a-file.txt"], ["file", "README.md"]]);
    expect(root.entries.find((entry) => entry.name === "README.md")).toMatchObject({ sizeBytes: 12, modifiedAt: expect.stringMatching(/^2026-/) });
    const nested = await listManagedSessionWorkspace(userId, agentId, "/workspace/src/");
    expect(nested).toMatchObject({ path: "src", entries: [expect.objectContaining({ name: "app.ts" })] });
    const [, , script, , pathArg] = fake.execs.at(-1)!.argv;
    expect(pathArg).toBe("/workspace/src");
    expect(script).not.toContain("src");
  });

  it("refuses paths that leave the workspace before calling DigitalOcean", async () => {
    const agentId = await launched();
    for (const bad of ["../etc", "src/../../root", "a\u0000b"]) {
      await expect(listManagedSessionWorkspace(userId, agentId, bad)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fake.execs).toHaveLength(0);
  });

  it("asks for a resume instead of waking a paused session", async () => {
    const agentId = await launched();
    await managedSessionAction(userId, agentId, "pause");
    await expect(listManagedSessionWorkspace(userId, agentId, "")).rejects.toMatchObject({ code: "session_paused" });
    expect(fake.execs).toHaveLength(0);
  });

  it("reports a missing folder and a sandbox that cannot list", async () => {
    const agentId = await launched();
    await expect(listManagedSessionWorkspace(userId, agentId, "gone")).rejects.toMatchObject({ code: "not_found" });
    fake.execResult = { exitCode: 4 };
    await expect(listManagedSessionWorkspace(userId, agentId, "")).rejects.toMatchObject({ code: "provider_rejected" });
  });

  it("marks a listing cut short at the output cap and drops the partial entry", async () => {
    const agentId = await launched();
    const name = "x".repeat(200);
    const record = `f\t1\t1790000000\t${name}\u0000`;
    fake.execResult = { exitCode: 0, stdout: record.repeat(Math.ceil((256 * 1024) / record.length)).slice(0, 256 * 1024) };
    const listing = await listManagedSessionWorkspace(userId, agentId, "");
    expect(listing.truncated).toBe(true);
    expect(listing.entries.every((entry) => entry.name === name)).toBe(true);
  });

  it("streams a file or a folder archive under a safe name", async () => {
    const agentId = await launched();
    const file = await downloadManagedSessionWorkspace(userId, agentId, "README.md", { archive: false });
    expect(file).toMatchObject({ fileName: "README.md", isArchive: false });
    expect(await new Response(file.body).text()).toBe("hello world\n");
    const folder = await downloadManagedSessionWorkspace(userId, agentId, "", { archive: true });
    expect(folder).toMatchObject({ fileName: "workspace.tar", isArchive: true });
    expect(fake.downloads.at(-1)).toMatchObject({ path: ".", asArchive: true });
    await expect(downloadManagedSessionWorkspace(userId, agentId, "", { archive: false })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a download larger than Hivra streams at once", async () => {
    const agentId = await launched();
    fake.workspace.set("big.bin", { kind: "f", size: 300 * 1024 * 1024, content: "x" });
    await expect(downloadManagedSessionWorkspace(userId, agentId, "big.bin", { archive: false })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("listDigitalOceanModelsForConnection", () => {
  it("lists models with the connection's stored token", async () => {
    const inferenceModels = jest.fn(async () => ["deepseek-v4-pro"]);
    const restoreModels = setManagedSessionDependenciesForTest({ inferenceModels });
    try {
      await expect(listDigitalOceanModelsForConnection(userId, connectionId)).resolves.toEqual(["deepseek-v4-pro"]);
      expect(mockLoadSecret).toHaveBeenCalledWith(userId, connectionId);
      expect(inferenceModels).toHaveBeenCalledWith(TOKEN);
    } finally {
      restoreModels();
    }
  });

  it("reports a rejected token as a credential problem", async () => {
    const restoreModels = setManagedSessionDependenciesForTest({
      inferenceModels: async () => { throw new DigitalOceanApiError("unauthorized", 401, "GET", "/v1/models"); },
    });
    try {
      await expect(listDigitalOceanModelsForConnection(userId, connectionId)).rejects.toMatchObject({ code: "invalid_credentials" });
    } finally {
      restoreModels();
    }
  });
});

describe("readDigitalOceanBalance", () => {
  it("reports ok, empty, blocked and unreadable from DigitalOcean's prepayment status", async () => {
    await expect(readDigitalOceanBalance(userId, connectionId)).resolves.toMatchObject({ state: "ok", balance: "25.00" });
    fake.prepayment = { balance: "0.00", blocked: false, autoPrepay: false };
    await expect(readDigitalOceanBalance(userId, connectionId)).resolves.toMatchObject({ state: "empty" });
    fake.prepayment = { balance: "4.10", blocked: true, autoPrepay: false };
    await expect(readDigitalOceanBalance(userId, connectionId)).resolves.toMatchObject({ state: "blocked", balance: "4.10" });
    fake.prepayment = null;
    await expect(readDigitalOceanBalance(userId, connectionId)).resolves.toEqual({ state: "unreadable" });
  });

  it("maps a rejected token to a credential problem", async () => {
    fake.rejectedTokens.add(TOKEN);
    await expect(readDigitalOceanBalance(userId, connectionId)).rejects.toMatchObject({ code: "invalid_credentials" });
  });
});
