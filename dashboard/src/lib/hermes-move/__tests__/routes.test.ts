import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockOps = jest.fn();
const mockAfter = jest.fn();
const store = {
  getInstance: jest.fn(),
  getAgent: jest.fn(),
  latestMoveForInstance: jest.fn(),
  moveForAgent: jest.fn(),
  activeMoveForInstance: jest.fn(),
  insertMove: jest.fn(),
  listActiveMoves: jest.fn(),
  listMoves: jest.fn(),
  transitionMove: jest.fn(),
};
const mockSweep = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth(), currentUser: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/hivra/after-response", () => ({ runAfterResponse: (task: () => Promise<unknown>) => mockAfter(task) }));
jest.mock("@/lib/hermes-releases/ops-auth", () => ({ requireOpsAdmin: () => mockOps() }));
jest.mock("@/lib/bearer-auth", () => ({ verifyBearerHeader: (req: NextRequest, secret: string) => req.headers.get("authorization") === `Bearer ${secret}` }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/hermes-move/deps", () => ({
  createMoveDeps: () => ({
    store,
    now: () => new Date("2026-11-12T10:00:00Z"),
    encrypt: (s: string) => `enc(${s})`,
    randomKeyHex: () => "k".repeat(64),
  }),
}));
jest.mock("@/lib/hermes-move/orchestrator", () => ({
  ...jest.requireActual("@/lib/hermes-move/orchestrator"),
  sweepMoves: (...args: unknown[]) => mockSweep(...args),
}));

import { GET as instanceGet, POST as instancePost } from "@/app/api/instances/[id]/move/route";
import { GET as agentGet } from "@/app/api/hivra/agents/[id]/move/route";
import { POST as undoPost } from "@/app/api/hivra/agents/[id]/move/undo/route";
import { GET as cronGet } from "@/app/api/cron/advance-hermes-moves/route";
import { GET as opsGet, POST as opsPost } from "@/app/api/ops/hermes-moves/route";

const ID = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const same = { origin: "http://localhost", "sec-fetch-site": "same-origin", host: "localhost" };
const req = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", host: "localhost", ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

const instance = { id: ID, user_id: "owner", name: "Ada", status: "running", backend: "gateway", deleted_at: null, config: { infrastructure: { provider: "proxmox", vmid: 1 } } };
const doneMove = {
  id: "m1", user_id: "owner", instance_id: ID, agent_id: AGENT, state: "done", step: "done", message: "ok",
  started_at: "2026-11-12T09:00:00Z", finished_at: "2026-11-12T09:30:00Z", undo_until: "2026-11-19T09:30:00Z", lease_until: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockOps.mockResolvedValue({ ok: true, actor: "ops:x" });
  store.getInstance.mockResolvedValue(instance);
  store.activeMoveForInstance.mockResolvedValue(null);
  store.latestMoveForInstance.mockResolvedValue(null);
  process.env.CRON_SECRET = "s3cret";
});

describe("GET /api/instances/[id]/move", () => {
  it("needs a session", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    expect((await instanceGet(req(`/api/instances/${ID}/move`), ctx(ID))).status).toBe(401);
  });
  it("hides another owner's agent", async () => {
    mockAuth.mockResolvedValue({ userId: "someone-else" });
    expect((await instanceGet(req(`/api/instances/${ID}/move`), ctx(ID))).status).toBe(404);
  });
  it("returns the offer and no move", async () => {
    const res = await instanceGet(req(`/api/instances/${ID}/move`), ctx(ID));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ offer: { available: true, reason: "available" }, move: null, movedTo: null });
  });
  it("advances a move in flight whose lease is free, and leaves a held lease alone", async () => {
    store.latestMoveForInstance.mockResolvedValue({ ...doneMove, state: "packing", step: "pack-running", lease_until: null });
    const res = await instanceGet(req(`/api/instances/${ID}/move`), ctx(ID));
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect((await res.json()).data.offer.reason).toBe("move_in_progress");
    mockAfter.mockClear();
    store.latestMoveForInstance.mockResolvedValue({ ...doneMove, state: "packing", lease_until: "2999-01-01T00:00:00Z" });
    await instanceGet(req(`/api/instances/${ID}/move`), ctx(ID));
    expect(mockAfter).not.toHaveBeenCalled();
  });
  it("says where a moved agent went", async () => {
    store.getInstance.mockResolvedValue({ ...instance, status: "scheduled_for_deletion", config: { movedTo: { agentId: AGENT } } });
    store.latestMoveForInstance.mockResolvedValue(doneMove);
    const body = (await (await instanceGet(req(`/api/instances/${ID}/move`), ctx(ID))).json()).data;
    expect(body.movedTo).toEqual({ agentId: AGENT });
    expect(body.move).not.toHaveProperty("key_encrypted");
  });
});

describe("POST /api/instances/[id]/move", () => {
  const post = () => instancePost(req(`/api/instances/${ID}/move`, { method: "POST", headers: same }), ctx(ID));
  it("needs a session and a same-origin request", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    expect((await post()).status).toBe(401);
    mockAuth.mockResolvedValue({ userId: "owner" });
    expect((await instancePost(req(`/api/instances/${ID}/move`, { method: "POST" }), ctx(ID))).status).toBe(403);
  });
  it("refuses an agent that belongs to someone else", async () => {
    mockAuth.mockResolvedValue({ userId: "someone-else" });
    expect((await post()).status).toBe(404);
  });
  it("starts the move: 202 with the view, advancing after the response", async () => {
    store.insertMove.mockResolvedValue({ ...doneMove, state: "queued", step: "queued", agent_id: null, finished_at: null, undo_until: null });
    const res = await post();
    expect(res.status).toBe(202);
    expect((await res.json()).data.move).toMatchObject({ id: "m1", state: "queued" });
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(store.insertMove).toHaveBeenCalledWith(expect.objectContaining({ user_id: "owner", initiated_by: "owner" }));
  });
  it("answers 409 when a move is already running", async () => {
    store.activeMoveForInstance.mockResolvedValue({ state: "packing" });
    expect((await post()).status).toBe(409);
  });
});

describe("agent move routes", () => {
  it("GET needs the owner and reports movedFrom and canUndo", async () => {
    store.getAgent.mockResolvedValue({ id: AGENT, user_id: "owner" });
    store.moveForAgent.mockResolvedValue(doneMove);
    const res = await agentGet(req(`/api/hivra/agents/${AGENT}/move`), ctx(AGENT));
    expect((await res.json()).data).toMatchObject({ movedFrom: { instanceId: ID, name: "Ada", undoUntil: doneMove.undo_until }, canUndo: true, move: { state: "done" } });
    mockAuth.mockResolvedValue({ userId: "intruder" });
    expect((await agentGet(req(`/api/hivra/agents/${AGENT}/move`), ctx(AGENT))).status).toBe(404);
    mockAuth.mockResolvedValue({ userId: null });
    expect((await agentGet(req(`/api/hivra/agents/${AGENT}/move`), ctx(AGENT))).status).toBe(401);
  });
  it("undo needs a session, same origin and the owner; then returns 202", async () => {
    const call = () => undoPost(req(`/api/hivra/agents/${AGENT}/move/undo`, { method: "POST", headers: same }), ctx(AGENT));
    mockAuth.mockResolvedValue({ userId: null });
    expect((await call()).status).toBe(401);
    mockAuth.mockResolvedValue({ userId: "owner" });
    expect((await undoPost(req(`/api/hivra/agents/${AGENT}/move/undo`, { method: "POST" }), ctx(AGENT))).status).toBe(403);
    store.moveForAgent.mockResolvedValue({ ...doneMove, user_id: "someone-else" });
    expect((await call()).status).toBe(404);
    store.moveForAgent.mockResolvedValue(doneMove);
    store.transitionMove.mockResolvedValue({ ...doneMove, state: "undoing", step: "undo-stop-new" });
    const res = await call();
    expect(res.status).toBe(202);
    expect((await res.json()).data).toMatchObject({ instanceId: ID, move: { state: "undoing" } });
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });
});

describe("cron and ops", () => {
  it("cron needs the bearer secret and passes the concurrency", async () => {
    expect((await cronGet(req("/api/cron/advance-hermes-moves"))).status).toBe(401);
    mockSweep.mockResolvedValue({ advanced: 1, started: 1, active: 1, queued: 0 });
    const res = await cronGet(req("/api/cron/advance-hermes-moves", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    expect(mockSweep.mock.calls[0][0]).toBe(2);
    process.env.HERMES_MOVE_CONCURRENCY = "3";
    await cronGet(req("/api/cron/advance-hermes-moves", { headers: { authorization: "Bearer s3cret" } }));
    expect(mockSweep.mock.calls[1][0]).toBe(3);
    delete process.env.HERMES_MOVE_CONCURRENCY;
  });
  it("ops routes need an ops admin", async () => {
    mockOps.mockResolvedValue({ ok: false, status: 403, message: "Forbidden" });
    expect((await opsGet()).status).toBe(403);
    expect((await opsPost(req("/api/ops/hermes-moves", { method: "POST", body: { all: true } }))).status).toBe(403);
  });
  it("ops POST validates the body", async () => {
    expect((await opsPost(req("/api/ops/hermes-moves", { method: "POST", body: {} }))).status).toBe(400);
    expect((await opsPost(req("/api/ops/hermes-moves", { method: "POST", body: { instanceIds: ["not-a-uuid"] } }))).status).toBe(400);
  });
});
