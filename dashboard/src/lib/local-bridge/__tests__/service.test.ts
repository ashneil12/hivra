/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-explicit-any -- an in-memory stand-in for the store */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const SECRET = "test-relay-secret-with-at-least-32-characters";

jest.mock("@/lib/infrastructure/host-relay", () => {
  const actual = jest.requireActual("@/lib/infrastructure/host-relay");
  return {
    ...actual,
    hostRelayConfig: jest.fn(() => ({ httpBase: "https://relay.test", wsBase: "wss://relay.test", secret: "test-relay-secret-with-at-least-32-characters" })),
    hostRelayStatus: jest.fn(),
    execViaRelay: jest.fn(),
    revokeRelayConnector: jest.fn(async () => undefined),
  };
});

// An in-memory stand-in for the store, with the same conditional transitions.
jest.mock("../store", () => {
  const state = { computers: new Map<string, any>(), requests: new Map<string, any>(), allowances: new Map<string, any>(), seq: 0 };
  return {
    __state: state,
    loadComputer: async (user: string, id: string) => { const row = state.computers.get(id); return row && row.user_id === user ? row : null; },
    loadComputers: async (user: string) => [...state.computers.values()].filter((row) => row.user_id === user),
    insertRequest: async (row: any) => {
      const id = `req-${++state.seq}`;
      const saved = { id, user_id: row.userId, agent_id: row.agentId, computer_id: row.computerId, argv: row.argv, argv_sha256: row.argvSha256, cwd: row.cwd,
        timeout_seconds: row.timeoutSeconds, max_output_bytes: row.maxOutputBytes, status: "pending", decision: null, result: null, error_code: null,
        created_at: new Date().toISOString(), expires_at: row.expiresAt, finished_at: null };
      state.requests.set(id, saved);
      return { ...saved };
    },
    loadRequest: async (user: string, id: string) => { const row = state.requests.get(id); return row && row.user_id === user ? { ...row } : null; },
    loadRequestForAgent: async (user: string, agent: string, id: string) => { const row = state.requests.get(id); return row && row.user_id === user && row.agent_id === agent ? { ...row } : null; },
    countPending: async (agent: string) => [...state.requests.values()].filter((row) => row.agent_id === agent && row.status === "pending").length,
    transition: async (id: string, from: string, patch: any) => {
      const row = state.requests.get(id);
      if (!row || row.status !== from) return false;
      Object.assign(row, patch);
      return true;
    },
    findAllowance: async (user: string, agent: string, computer: string) => { const row = state.allowances.get(`${agent}|${computer}`); return row && row.user_id === user ? row : null; },
    upsertAllowance: async (user: string, agent: string, computer: string, granted: string, expires: string) => {
      state.allowances.set(`${agent}|${computer}`, { user_id: user, agent_id: agent, computer_id: computer, granted_at: granted, expires_at: expires });
    },
    deleteAllowance: async (_user: string, agent: string, computer: string) => { state.allowances.delete(`${agent}|${computer}`); },
    bumpGeneration: async (_user: string, computer: any) => { computer.generation += 1; computer.revoked_at = "now"; return computer.generation; },
    markComputerEnrolled: async (_user: string, id: string) => { state.computers.get(id).revoked_at = null; },
    insertComputer: async (user: string, label: string) => {
      const row = { id: "11111111-1111-4111-8111-111111111111", user_id: user, label, generation: 1, revoked_at: null, created_at: "x" };
      state.computers.set(row.id, row);
      return row;
    },
  };
});

import { createHmac } from "node:crypto";
import { execViaRelay, hostRelayStatus, revokeRelayConnector } from "@/lib/infrastructure/host-relay";
import {
  BRIDGE_OFF_MESSAGE, ALLOWANCE_MS, allowanceActive, decideRequest, dispatchRequest, enrollComputer, readRequestForAgent, revokeComputer, submitRequest,
} from "../service";
import * as storeModule from "../store";

const state = (storeModule as unknown as { __state: { computers: Map<string, any>; requests: Map<string, any>; allowances: Map<string, any> } }).__state;
const OWNER = "user_owner";
const OTHER_OWNER = "user_other";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPUTER = "11111111-1111-4111-8111-111111111111";
const ARGV = ["uname", "-s"];

const mockStatus = jest.mocked(hostRelayStatus);
const mockExec = jest.mocked(execViaRelay);

beforeAll(() => {
  process.env.HOST_RELAY_URL = "https://relay.test";
  process.env.HOST_RELAY_SECRET = SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  state.computers.clear();
  state.requests.clear();
  state.allowances.clear();
  state.computers.set(COMPUTER, { id: COMPUTER, user_id: OWNER, label: "Mac", generation: 1, revoked_at: null, created_at: "x" });
  mockStatus.mockResolvedValue({ online: true, generation: 1, minGeneration: 1, sessions: 0 });
  mockExec.mockResolvedValue({ ok: true, stdout: "Darwin\n", stderr: "", exitCode: 0, truncated: false, durationMs: 4 });
});

const submit = (now?: number) => submitRequest(OWNER, AGENT, COMPUTER, { argv: ARGV }, now);

describe("local bridge service", () => {
  it("holds a request for approval and never reaches the computer before it", async () => {
    const submitted = await submit();
    expect(submitted.ok && submitted.value.dispatchNow).toBe(false);
    const id = (submitted as any).value.request.id;
    await dispatchRequest(OWNER, id);
    expect(mockExec).not.toHaveBeenCalled();
    expect(state.requests.get(id).status).toBe("pending");
  });

  it("answers plainly when the bridge is off", async () => {
    mockStatus.mockResolvedValue({ online: false, generation: null, minGeneration: 1, sessions: 0 });
    const submitted = await submit();
    expect(submitted).toEqual({ ok: false, status: 409, message: BRIDGE_OFF_MESSAGE });
    expect(BRIDGE_OFF_MESSAGE).toBe("The bridge on your computer is off.");
    expect(state.requests.size).toBe(0);
    state.computers.get(COMPUTER).revoked_at = "now";
    mockStatus.mockResolvedValue({ online: true, generation: 1, minGeneration: 1, sessions: 0 });
    expect((await submit()).ok).toBe(false);
  });

  it("refuses another owner's computer", async () => {
    const result = await submitRequest(OTHER_OWNER, AGENT, COMPUTER, { argv: ARGV });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("approving mints one ticket bound to the exact command and returns Darwin", async () => {
    const id = (await submit() as any).value.request.id;
    const decided = await decideRequest(OWNER, id, "approve");
    expect(decided.ok && decided.value.dispatchNow).toBe(true);
    await dispatchRequest(OWNER, id);
    expect(mockExec).toHaveBeenCalledTimes(1);
    const [connection, ticket, request] = mockExec.mock.calls[0];
    expect(connection).toBe(COMPUTER);
    expect(request).toMatchObject({ argv: ARGV, timeoutSeconds: 30 });
    const [body, signature] = ticket.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(claims).toMatchObject({ v: 1, owner: OWNER, agent: AGENT, computer: COMPUTER, aud: COMPUTER });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
    const bridgeKey = createHmac("sha256", SECRET).update(`bridge-ticket|v1|${COMPUTER}`).digest("hex");
    expect(createHmac("sha256", bridgeKey).update(body).digest("base64url")).toBe(signature);
    const row = state.requests.get(id);
    expect(row.status).toBe("done");
    expect(row.result).toMatchObject({ stdout: "Darwin\n", exitCode: 0 });
  });

  it("dispatches at most once", async () => {
    const id = (await submit() as any).value.request.id;
    await decideRequest(OWNER, id, "approve");
    await Promise.all([dispatchRequest(OWNER, id), dispatchRequest(OWNER, id)]);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("a denied request never gets a ticket", async () => {
    const id = (await submit() as any).value.request.id;
    await decideRequest(OWNER, id, "deny");
    await dispatchRequest(OWNER, id);
    expect(mockExec).not.toHaveBeenCalled();
    expect(state.requests.get(id).status).toBe("denied");
    expect(await decideRequest(OWNER, id, "approve")).toMatchObject({ ok: false, status: 409 });
  });

  it("another owner cannot decide or read a request", async () => {
    const id = (await submit() as any).value.request.id;
    expect(await decideRequest(OTHER_OWNER, id, "approve")).toMatchObject({ ok: false, status: 404 });
    expect(await readRequestForAgent(OTHER_OWNER, AGENT, id)).toMatchObject({ ok: false, status: 404 });
    expect(await readRequestForAgent(OWNER, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", id)).toMatchObject({ ok: false, status: 404 });
    expect(state.requests.get(id).status).toBe("pending");
  });

  it("an expired pending request cannot be approved", async () => {
    const now = Date.now();
    const id = (await submit(now) as any).value.request.id;
    expect(await decideRequest(OWNER, id, "approve", now + 11 * 60_000)).toMatchObject({ ok: false, status: 409 });
    expect(state.requests.get(id).status).toBe("expired");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("'allow for 1 hour' lets the next request through and then expires", async () => {
    const now = Date.now();
    const first = (await submit(now) as any).value.request.id;
    await decideRequest(OWNER, first, "allow_hour", now);
    const during = await submit(now + 30 * 60_000);
    expect(during.ok && during.value.dispatchNow).toBe(true);
    await dispatchRequest(OWNER, (during as any).value.request.id);
    expect(mockExec).toHaveBeenCalled();
    const after = await submit(now + ALLOWANCE_MS + 1000);
    expect(after.ok && after.value.dispatchNow).toBe(false);
    expect(state.requests.get((after as any).value.request.id).status).toBe("pending");
  });

  it("an allowance is never longer than an hour", () => {
    const granted = Date.parse("2026-11-12T10:00:00Z");
    const now = granted + 1000;
    expect(allowanceActive({ granted_at: new Date(granted).toISOString(), expires_at: new Date(granted + ALLOWANCE_MS).toISOString() }, now)).toBe(true);
    expect(allowanceActive({ granted_at: new Date(granted).toISOString(), expires_at: new Date(granted + ALLOWANCE_MS + 1).toISOString() }, now)).toBe(false);
    expect(allowanceActive(null, now)).toBe(false);
  });

  it("an allowance for one agent does not cover another", async () => {
    const now = Date.now();
    const first = (await submit(now) as any).value.request.id;
    await decideRequest(OWNER, first, "allow_hour", now);
    const other = await submitRequest(OWNER, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", COMPUTER, { argv: ARGV }, now);
    expect(other.ok && other.value.dispatchNow).toBe(false);
  });

  it("records a bridge that went off mid-request as failed", async () => {
    mockExec.mockRejectedValue(Object.assign(new Error("off"), { name: "HostRelayError", code: "host_offline" }));
    const id = (await submit() as any).value.request.id;
    await decideRequest(OWNER, id, "approve");
    await dispatchRequest(OWNER, id);
    expect(state.requests.get(id).status).toBe("failed");
  });

  it("revoke raises the generation and tells the relay", async () => {
    const result = await revokeComputer(OWNER, COMPUTER);
    expect(result).toEqual({ ok: true, value: { generation: 2 } });
    expect(revokeRelayConnector).toHaveBeenCalledWith(COMPUTER, 2);
    expect(await revokeComputer(OTHER_OWNER, COMPUTER)).toMatchObject({ ok: false, status: 404 });
  });

  it("enrolling issues a config for this owner and computer", async () => {
    const enrolled = await enrollComputer(OWNER, "Mac", COMPUTER);
    expect(enrolled.ok && enrolled.value.config).toMatchObject({ connectionId: COMPUTER, computerId: COMPUTER, ownerId: OWNER, generation: 1 });
  });
});
