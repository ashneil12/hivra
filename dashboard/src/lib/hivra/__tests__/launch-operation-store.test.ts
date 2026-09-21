jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopInstallFixture } from "./provider-desktop-install.fixtures";
import {
  createHivraLaunchOperationService,
  createHivraLaunchOperationStore,
  hivraLaunchIntentDigest,
  hivraLaunchRequestDigest,
  type HivraLaunchIntent,
  type HivraLaunchOperation,
  type HivraLaunchOperationStore,
  type HivraLaunchRequestIntent,
} from "../launch-operation-store";

const OWNER = "owner-one";
const OTHER_OWNER = "owner-two";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

const requestIntent: HivraLaunchRequestIntent = {
  type: "codex",
  name: "Native Codex",
  computerProfile: null,
  cpu: 2,
  ram: 4,
  browser: true,
  goal: "build",
  context: "private working context",
  personality: "direct",
  emoji: "🧰",
  managedVenice: false,
  templateRef: null,
  modelMode: "native",
  deployment: { mode: "hivra-managed" },
};

const intent: HivraLaunchIntent = {
  resourceKind: "agent",
  runtimeId: "codex",
  name: "Native Codex",
  computerProfile: null,
  cpu: 2,
  ram: 4,
  browser: true,
  goal: "build",
  context: "private working context",
  personality: "direct",
  emoji: "🧰",
  managedVenice: false,
  templateRef: null,
  templateSkills: ["github"],
  desktopControlOrigin: null,
  deployment: { mode: "hivra-managed" },
};

function row(
  owner = OWNER,
  requestId = REQUEST_ID,
  submitted: HivraLaunchRequestIntent = requestIntent,
  effective: HivraLaunchIntent = intent,
): HivraLaunchOperation {
  return {
    user_id: owner,
    request_id: requestId,
    operation_id: OPERATION_ID,
    request_digest: hivraLaunchRequestDigest(owner, requestId, submitted),
    intent_digest: hivraLaunchIntentDigest(owner, requestId, effective),
    resource_kind: effective.resourceKind,
    runtime_id: effective.runtimeId,
    phase: "reserved",
    agent_id: null,
    response_status: null,
    failure_status: null,
    failure_code: null,
    created_at: "2026-09-04T10:00:00.000Z",
    bound_at: null,
    accepted_at: null,
    failed_at: null,
  };
}

function memoryStore() {
  const rows = new Map<string, HivraLaunchOperation>();
  const agents = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, Record<string, unknown>>();
  const key = (owner: string, requestId: string) => `${owner}:${requestId}`;
  const addAgent = (agent: Record<string, unknown>) => {
    agents.set(`${agent.user_id}:${agent.id}`, agent);
    operations.set(`${agent.user_id}:${agent.operation_id}:${agent.type}`, agent);
    if(agent.computer_substrate==="provider-vm")operations.set(`${agent.user_id}:${agent.allocation_operation_id}:${agent.type}`,agent);
  };
  const store: HivraLaunchOperationStore = {
    byRequest: jest.fn(async (owner, requestId) => rows.get(key(owner, requestId)) ?? null),
    reserve: jest.fn(async admission => {
      const existing = rows.get(key(admission.userId, admission.requestId));
      if (existing) {
        return existing.request_digest === admission.requestDigest
          ? { created: false, operation: existing }
          : { conflict: true as const };
      }
      const created = row(admission.userId, admission.requestId, admission.requestIntent, admission.intent);
      created.operation_id = admission.operationId;
      rows.set(key(admission.userId, admission.requestId), created);
      return { created: true, operation: created };
    }),
    bindAgent: jest.fn(async (admission, agentId) => {
      const saved = rows.get(key(admission.userId, admission.requestId));
      if (!saved || saved.operation_id !== admission.operationId || saved.request_digest !== admission.requestDigest
        || saved.intent_digest !== admission.intentDigest || saved.phase === "failed") return null;
      if (saved.agent_id && saved.agent_id !== agentId) return null;
      saved.agent_id = agentId;
      saved.phase = saved.phase === "accepted" ? "accepted" : "bound";
      saved.bound_at ??= "2026-09-04T10:01:00.000Z";
      return saved;
    }),
    accept: jest.fn(async (admission, agentId, responseStatus) => {
      const saved = rows.get(key(admission.userId, admission.requestId));
      if (!saved || saved.agent_id !== agentId || saved.request_digest !== admission.requestDigest
        || saved.intent_digest !== admission.intentDigest || !["bound", "accepted"].includes(saved.phase)) return null;
      saved.phase = "accepted";
      if (saved.response_status !== 201) saved.response_status = responseStatus;
      saved.accepted_at ??= "2026-09-04T10:02:00.000Z";
      return saved;
    }),
    markReconciling: jest.fn(async admission => {
      const saved = rows.get(key(admission.userId, admission.requestId));
      if (!saved || saved.operation_id !== admission.operationId || saved.phase === "failed") return null;
      if (saved.phase === "reserved") saved.phase = "reconciling";
      return saved;
    }),
    fail: jest.fn(async (admission, failureStatus, failureCode) => {
      const saved = rows.get(key(admission.userId, admission.requestId));
      if (!saved || !["reserved", "reconciling", "failed"].includes(saved.phase) || saved.agent_id) return null;
      if (saved.phase === "failed" && (saved.failure_status !== failureStatus || saved.failure_code !== failureCode)) return null;
      saved.phase = "failed";
      saved.failure_status = failureStatus;
      saved.failure_code = failureCode;
      saved.failed_at = "2026-09-04T10:03:00.000Z";
      return saved;
    }),
  };
  const service = createHivraLaunchOperationService({
    store,
    agent: async (owner, agentId) => agents.get(`${owner}:${agentId}`) ?? null,
    agentByOperation: async (owner, operationId, runtimeId) => operations.get(`${owner}:${operationId}:${runtimeId}`) ?? null,
    newId: () => randomUUID(),
  });
  return { rows, agents, operations, addAgent, store, service };
}

function managedAgent(operationId = OPERATION_ID, overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: OWNER,
    type: "codex",
    computer_profile: null,
    computer_substrate: "proxmox-kvm",
    operation_id: operationId,
    status: "provisioning",
    ...overrides,
  };
}

describe("generic Hivra launch intent", () => {
  it("domain-binds secret-free submitted and effective digests to owner and request", () => {
    const requestDigest = hivraLaunchRequestDigest(OWNER, REQUEST_ID, requestIntent);
    const intentDigest = hivraLaunchIntentDigest(OWNER, REQUEST_ID, intent);
    expect(requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(requestDigest).not.toContain(requestIntent.context!);
    expect(hivraLaunchRequestDigest(OTHER_OWNER, REQUEST_ID, requestIntent)).not.toBe(requestDigest);
    expect(hivraLaunchRequestDigest(OWNER, randomUUID(), requestIntent)).not.toBe(requestDigest);
  });

  it.each([
    { type: "linux-desktop" }, { name: "Different" }, { cpu: 4 }, { ram: 8 },
    { browser: false }, { goal: null }, { context: "different" }, { personality: null },
    { emoji: null }, { templateRef: "template-slug" }, { modelMode: "explicit" },
    { deployment: { mode: "self-managed", connectionId: randomUUID(), targetId: randomUUID(), expectedConnectionRevision: 2 } },
  ])("changes the submitted digest for material client intent: %j", changed => {
    expect(hivraLaunchRequestDigest(OWNER, REQUEST_ID, { ...requestIntent, ...changed })).not.toBe(
      hivraLaunchRequestDigest(OWNER, REQUEST_ID, requestIntent),
    );
  });

  it("accepts Ubuntu effective intent but rejects cross-kind profiles", () => {
    const ubuntu: HivraLaunchIntent = { ...intent, resourceKind: "computer", runtimeId: "linux-desktop",
      computerProfile: "ubuntu-desktop", browser: false, desktopControlOrigin: "https://canary.hermesos.cloud" };
    expect(hivraLaunchIntentDigest(OWNER, REQUEST_ID, ubuntu)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => hivraLaunchIntentDigest(OWNER, REQUEST_ID, { ...ubuntu, resourceKind: "agent" })).toThrow();
  });
});

describe("generic Hivra launch admission", () => {
  it("serializes concurrent same-owner reservations so exactly one caller may launch", async () => {
    const f = memoryStore();
    const [first, second] = await Promise.all([
      f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent),
      f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent),
    ]);
    const outcomes = await Promise.all([
      f.service.reserve(first.admission!), f.service.reserve(second.admission!),
    ]);
    expect(outcomes.filter(outcome => outcome.created)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.created)).toHaveLength(1);
    expect(f.rows.size).toBe(1);
  });

  it("replays the accepted original after a lost HTTP response without reserving again", async () => {
    const f = memoryStore();
    const prepared = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(prepared.admission!);
    f.addAgent(managedAgent(prepared.admission!.operationId));
    await f.service.bindAgent(prepared.admission!, AGENT_ID);
    await f.service.accept(prepared.admission!, AGENT_ID, 201);

    const replay = await f.service.lookup(OWNER, REQUEST_ID, requestIntent);
    expect(replay).toMatchObject({ existing: { state: "accepted", requestId: REQUEST_ID,
      phase: "accepted", responseStatus: 201, agent: { id: AGENT_ID, user_id: OWNER } } });
    expect(f.store.reserve).toHaveBeenCalledTimes(1);
  });

  it("reads the original receipt only through its durable owner and request binding", async () => {
    const f = memoryStore();
    const prepared = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(prepared.admission!);
    f.addAgent(managedAgent(prepared.admission!.operationId));
    await f.service.bindAgent(prepared.admission!, AGENT_ID);
    await f.service.accept(prepared.admission!, AGENT_ID, 201);

    await expect(f.service.original(OWNER, REQUEST_ID)).resolves.toMatchObject({
      state: "accepted",
      requestId: REQUEST_ID,
      phase: "accepted",
      responseStatus: 201,
      agent: { id: AGENT_ID, user_id: OWNER },
    });
    await expect(f.service.original(OTHER_OWNER, REQUEST_ID)).resolves.toBeNull();
    expect(f.store.byRequest).toHaveBeenCalledWith(OWNER, REQUEST_ID);
    expect(f.store.byRequest).toHaveBeenCalledWith(OTHER_OWNER, REQUEST_ID);
    expect(f.store.reserve).toHaveBeenCalledTimes(1);
  });

  it("recovers an owner row after insert or bind acknowledgement loss without a second insert", async () => {
    const f = memoryStore();
    const prepared = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(prepared.admission!);
    f.addAgent(managedAgent(prepared.admission!.operationId));

    const replay = await f.service.lookup(OWNER, REQUEST_ID, requestIntent);
    expect(replay.existing).toMatchObject({ state: "accepted", responseStatus: 202,
      agent: { id: AGENT_ID, operation_id: prepared.admission!.operationId } });
    expect(f.store.bindAgent).toHaveBeenCalledTimes(1);
    expect(f.store.accept).toHaveBeenCalledWith(expect.objectContaining({ operationId: prepared.admission!.operationId }), AGENT_ID, 202);
    expect(f.store.reserve).toHaveBeenCalledTimes(1);
  });

  it.each(["clean","allocation","kind"])("recovers only a provider row bound to the original launch operation: %s",async fault=>{
    const f=memoryStore(),prepared=await f.service.prepare(OWNER,REQUEST_ID,requestIntent,intent);
    await f.service.reserve(prepared.admission!);
    f.addAgent(managedAgent(prepared.admission!.operationId,{computer_substrate:"provider-vm",
      allocation_operation_id:fault==="allocation"?AGENT_ID:prepared.admission!.operationId,
      operation_kind:fault==="kind"?"restart":"provision"}));
    if(fault==="clean")await expect(f.service.lookup(OWNER,REQUEST_ID,requestIntent)).resolves.toMatchObject({existing:{state:"accepted",responseStatus:202,agent:{id:AGENT_ID}}});
    else {
      await expect(f.service.lookup(OWNER,REQUEST_ID,requestIntent)).rejects.toThrow();
      expect(f.store.bindAgent).not.toHaveBeenCalled();
    }
    expect(f.store.reserve).toHaveBeenCalledTimes(1);
  });
  it.each(["running","failed","expired","allocation","identity","outcome"])("recovers converged provider Ubuntu after lost binding: %s",async state=>{
    const f=memoryStore(),submitted={...requestIntent,type:"linux-desktop" as const,computerProfile:"ubuntu-desktop",browser:false,cpu:2,ram:8};
    const wanted={...intent,resourceKind:"computer" as const,runtimeId:"linux-desktop" as const,computerProfile:"ubuntu-desktop" as const,
      cpu:2,ram:8,browser:false,templateSkills:[],desktopControlOrigin:"https://canary.hermesos.cloud"};
    const prepared=await f.service.prepare(OWNER,REQUEST_ID,submitted,wanted);await f.service.reserve(prepared.admission!);
    const op=prepared.admission!.operationId,d=desktopInstallFixture();
    const row=managedAgent(op,{type:"linux-desktop",computer_profile:"ubuntu-desktop",computer_substrate:"provider-vm",
      operation_id:null,operation_kind:null,allocation_operation_id:state==="allocation"?AGENT_ID:op,
      status:["failed","expired"].includes(state)?"error":"running",provider_install_outcome:state==="outcome"||state==="failed"?"failed":"succeeded",
      provider_install_stopped_at:new Date().toISOString(),provider_install_not_after:"2026-01-01T00:00:00Z",provider_install_dispatched_at:null,
      provider_install_identity:state==="expired"?null:{...d.identity,agentId:AGENT_ID,operationId:state==="identity"?AGENT_ID:op}});
    f.addAgent(row);
    if(state==="identity"||state==="outcome")await expect(f.service.lookup(OWNER,REQUEST_ID,submitted)).rejects.toThrow();
    else if(state==="allocation")await expect(f.service.lookup(OWNER,REQUEST_ID,submitted)).resolves.toMatchObject({existing:{state:"reconciling"}});
    else await expect(f.service.lookup(OWNER,REQUEST_ID,submitted)).resolves.toMatchObject({existing:{state:"accepted",agent:{id:AGENT_ID,status:row.status}}});
    expect(f.store.reserve).toHaveBeenCalledTimes(1);
  });
  it("records confirmed pre-row failure as terminal and does not re-reserve", async () => {
    const f = memoryStore();
    const prepared = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(prepared.admission!);
    await f.service.fail(prepared.admission!, 500, "agent_insert_failed");

    const replay = await f.service.lookup(OWNER, REQUEST_ID, requestIntent);
    expect(replay.existing).toEqual({ state: "failed", requestId: REQUEST_ID, phase: "failed",
      responseStatus: null, failureStatus: 500, failureCode: "agent_insert_failed", agent: null });
    expect(f.store.reserve).toHaveBeenCalledTimes(1);
  });

  it("keeps uncertain provider state explicitly reconciling without exposing an agent", async () => {
    const f = memoryStore();
    const prepared = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(prepared.admission!);
    const uncertain = await f.service.markReconciling(prepared.admission!);
    expect(uncertain).toEqual({ state: "reconciling", requestId: REQUEST_ID,
      phase: "reconciling", responseStatus: null, agent: null });
    expect((await f.service.lookup(OWNER, REQUEST_ID, requestIntent)).existing).toEqual(uncertain);
  });

  it("replays post-bind failure as accepted 202 and monotonically upgrades to 201", async () => {
    const f = memoryStore();
    const prepared = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(prepared.admission!);
    const agent = managedAgent(prepared.admission!.operationId);
    f.addAgent(agent);
    await f.service.bindAgent(prepared.admission!, AGENT_ID);
    await f.service.accept(prepared.admission!, AGENT_ID, 202);
    agent.status = "error";
    expect((await f.service.lookup(OWNER, REQUEST_ID, requestIntent)).existing).toMatchObject({
      state: "accepted", responseStatus: 202, agent: { id: AGENT_ID, status: "error" },
    });
    await f.service.accept(prepared.admission!, AGENT_ID, 201);
    expect((await f.service.lookup(OWNER, REQUEST_ID, requestIntent)).existing).toMatchObject({
      state: "accepted", responseStatus: 201,
    });
    await f.service.accept(prepared.admission!, AGENT_ID, 202);
    expect((await f.service.lookup(OWNER, REQUEST_ID, requestIntent)).existing).toMatchObject({ responseStatus: 201 });
  });

  it("replays the original receipt across derived template or config drift", async () => {
    const f = memoryStore();
    const prepared = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(prepared.admission!);
    f.addAgent(managedAgent(prepared.admission!.operationId));
    await f.service.bindAgent(prepared.admission!, AGENT_ID);
    await f.service.accept(prepared.admission!, AGENT_ID, 201);
    const drifted = { ...intent, name: "Changed template name", templateSkills: ["changed"] };

    const replay = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, drifted);
    expect(replay).toMatchObject({ admission: null, existing: { state: "accepted", responseStatus: 201,
      agent: { id: AGENT_ID } } });
  });

  it("rejects conflicting submitted reuse but keeps owners isolated", async () => {
    const f = memoryStore();
    const first = await f.service.prepare(OWNER, REQUEST_ID, requestIntent, intent);
    await f.service.reserve(first.admission!);
    await expect(f.service.lookup(OWNER, REQUEST_ID, { ...requestIntent, cpu: 4 }))
      .rejects.toMatchObject({ code: "request_conflict" });
    const other = await f.service.prepare(OTHER_OWNER, REQUEST_ID, requestIntent, intent);
    expect((await f.service.reserve(other.admission!)).created).toBe(true);
    expect(f.rows.size).toBe(2);
  });
});

describe("service-role SQL store", () => {
  it("recovers the exact row after a lost reservation acknowledgement", async () => {
    const saved = row();
    const query = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(async () => ({ data: saved, error: null })) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
    const db = { from: jest.fn(() => query), rpc: jest.fn(async () => { throw new Error("lost acknowledgement"); }) };
    const store = createHivraLaunchOperationStore(db as never);
    const admission = { userId: OWNER, requestId: REQUEST_ID, operationId: OPERATION_ID,
      requestIntent, intent, requestDigest: saved.request_digest, intentDigest: saved.intent_digest,
      resourceKind: intent.resourceKind, runtimeId: intent.runtimeId };
    await expect(store.reserve(admission)).resolves.toEqual({ created: false, operation: saved });
    expect(query.eq.mock.calls).toEqual([["user_id", OWNER], ["request_id", REQUEST_ID]]);
  });

  it("defines owner-scoped service-only fencing, exact correlation, and terminal/reconciling transitions", () => {
    const migration = readFileSync(path.resolve(__dirname,
      "../../../../supabase/migrations/20260904110000_hivra_launch_operations.sql"), "utf8").replace(/\s+/g, " ").toLowerCase();
    expect(migration).toContain("primary key (user_id, request_id)");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("q.request_digest is distinct from p_request_digest");
    expect(migration).toContain("a.operation_id is distinct from q.operation_id");
    expect(migration).toContain("phase in ('reserved', 'reconciling', 'bound', 'accepted', 'failed')");
    expect(migration).toContain("q.response_status = 202 and p_response_status = 201");
    expect(migration).not.toContain("agent_id uuid references public.hivra_agents");
    expect(migration).toContain("revoke all on table public.hivra_launch_operations from public, anon, authenticated, service_role");
    expect(migration).toContain("grant select on table public.hivra_launch_operations to service_role");
    for (const name of ["reserve_hivra_launch_operation", "bind_hivra_launch_operation_agent",
      "accept_hivra_launch_operation", "reconcile_hivra_launch_operation", "fail_hivra_launch_operation"]) {
      expect(migration).toContain(`revoke all on function public.${name}(`);
      expect(migration).toContain(`grant execute on function public.${name}(`);
    }
  });
});
