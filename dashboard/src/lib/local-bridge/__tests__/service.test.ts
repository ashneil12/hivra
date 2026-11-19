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
    RESULT_RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
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
      // Same rule as the real store and the database trigger.
      const { canMoveBridgeRequest } = jest.requireActual("../states");
      if (!canMoveBridgeRequest(from, patch.status)) throw new Error(`bridge request cannot move ${from} -> ${patch.status}`);
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
    bumpGeneration: async (_user: string, computer: any, key: string, revoked: boolean) => {
      computer.generation += 1; computer.revoked_at = revoked ? "now" : null; computer.bridge_key_encrypted = key; return computer.generation;
    },
    deleteAllowancesForComputer: async (_user: string, computer: string) => {
      for (const key of [...state.allowances.keys()]) if (state.allowances.get(key).computer_id === computer) state.allowances.delete(key);
    },
    expireOpenRequests: async (_user: string, computer: string) => {
      for (const row of state.requests.values()) if (row.computer_id === computer && ["pending", "approved"].includes(row.status)) row.status = "expired";
    },
    purgeOldResults: async () => undefined,
    // Same conditional update as the real store: one match, unexpired, not revoked, cleared on use.
    setEnrolCode: async (_user: string, id: string, hash: string, expires: string) => { Object.assign(state.computers.get(id), { enrol_token_hash: hash, enrol_expires_at: expires }); },
    consumeEnrolCode: async (hash: string, nowIso: string) => {
      const row = [...state.computers.values()].find((c) => c.enrol_token_hash === hash && c.enrol_expires_at > nowIso && !c.revoked_at);
      if (!row) return null;
      row.enrol_token_hash = null; row.enrol_expires_at = null;
      return { ...row };
    },
    markComputerEnrolled: async (_user: string, id: string, key: string) => { const row = state.computers.get(id); row.revoked_at = null; row.bridge_key_encrypted = key; },
    insertComputer: async (user: string, label: string, key: string) => {
      const row = { id: "11111111-1111-4111-8111-111111111111", user_id: user, label, generation: 1, revoked_at: null, created_at: "x", bridge_key_encrypted: key };
      state.computers.set(row.id, row);
      return row;
    },
  };
});

import { createHmac } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { execViaRelay, hostRelayStatus, revokeRelayConnector } from "@/lib/infrastructure/host-relay";
import {
  BRIDGE_OFF_MESSAGE, ALLOWANCE_MS, allowanceActive, decideRequest, dispatchRequest, enrollComputer, redeemEnrolCode, readRequestForAgent, revokeComputer, submitRequest, withoutOldResult, expireStale, publicRequest,
} from "../service";
import * as storeModule from "../store";

const state = (storeModule as unknown as { __state: { computers: Map<string, any>; requests: Map<string, any>; allowances: Map<string, any> } }).__state;
const OWNER = "user_owner";
const OTHER_OWNER = "user_other";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPUTER = "11111111-1111-4111-8111-111111111111";
const ARGV = ["uname", "-s"];
const STORED_KEY = "c3".repeat(32);

const mockStatus = jest.mocked(hostRelayStatus);
const mockExec = jest.mocked(execViaRelay);

beforeAll(() => {
  process.env.HOST_RELAY_URL = "https://relay.test";
  process.env.HOST_RELAY_SECRET = SECRET;
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  process.env.NEXT_PUBLIC_APP_URL = "https://canary.example.test";
});

beforeEach(() => {
  jest.clearAllMocks();
  state.computers.clear();
  state.requests.clear();
  state.allowances.clear();
  state.computers.set(COMPUTER, { id: COMPUTER, user_id: OWNER, label: "Mac", generation: 1, revoked_at: null, created_at: "x", bridge_key_encrypted: encryptSecret(STORED_KEY) });
  mockStatus.mockResolvedValue({ online: true, generation: 1, minGeneration: 1, sessions: 0 });
  mockExec.mockResolvedValue({ ok: true, stdout: "Darwin\n", stderr: "", exitCode: 0, truncated: false, durationMs: 4 });
});

const codeOf = (enrolled: { ok: boolean; value?: { command: string } }) => enrolled.value?.command.split(" ").pop() ?? "";
/** What a computer gets back for the code in a setup command (the config, once). */
const redeem = async (enrolled: any, now?: number) => {
  const result = await redeemEnrolCode(codeOf(enrolled), now);
  return result.ok ? result.value as any : null;
};

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
    // Signed with the bridge's own stored key, and not with anything the relay can derive.
    expect(createHmac("sha256", STORED_KEY).update(body).digest("base64url")).toBe(signature);
    const relayDerived = [
      createHmac("sha256", SECRET).update(`bridge-ticket|v1|${COMPUTER}`).digest("hex"),
      createHmac("sha256", SECRET).update("client-ticket|v1").digest("hex"),
      createHmac("sha256", SECRET).update("admin|v1").digest("hex"),
    ];
    for (const key of relayDerived) expect(createHmac("sha256", key).update(body).digest("base64url")).not.toBe(signature);
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

  it("enrolling returns one command with a one-time code and no secrets", async () => {
    const enrolled = await enrollComputer(OWNER, "Mac", COMPUTER);
    expect(enrolled.ok && enrolled.value.command).toMatch(/^curl -fsSL https:\/\/canary\.example\.test\/api\/hivra\/bridge\/install \| bash -s -- hvb_[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(enrolled)).not.toMatch(/bridgeKey|"secret"/);
    // Only a hash of the code is stored.
    const stored = state.computers.get(COMPUTER);
    expect(stored.enrol_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(codeOf(enrolled));
  });

  it("the code is swapped for this owner's config once, then refused", async () => {
    const enrolled = await enrollComputer(OWNER, "Mac", COMPUTER);
    expect(await redeem(enrolled)).toMatchObject({ connectionId: COMPUTER, computerId: COMPUTER, ownerId: OWNER, generation: 2, bridgeKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await redeemEnrolCode(codeOf(enrolled))).toMatchObject({ ok: false, status: 400 });
  });

  it("an expired code, a malformed code and a made-up code are refused", async () => {
    const now = Date.now();
    const enrolled = await enrollComputer(OWNER, "Mac", COMPUTER, now);
    expect(await redeemEnrolCode(codeOf(enrolled), now + 15 * 60_000 + 1)).toMatchObject({ ok: false, status: 400 });
    expect(await redeemEnrolCode("hvb_short")).toMatchObject({ ok: false, status: 400 });
    expect(await redeemEnrolCode(`hvb_${"A".repeat(32)}`)).toMatchObject({ ok: false, status: 400 });
    expect(await redeemEnrolCode(codeOf(enrolled), now + 1000)).toMatchObject({ ok: true });
  });

  it("setting up again voids the old code, and a revoke voids the new one", async () => {
    const first = await enrollComputer(OWNER, "Mac", COMPUTER);
    const second = await enrollComputer(OWNER, "Mac", COMPUTER);
    expect(await redeemEnrolCode(codeOf(first))).toMatchObject({ ok: false });
    await revokeComputer(OWNER, COMPUTER);
    expect(await redeemEnrolCode(codeOf(second))).toMatchObject({ ok: false });
  });

  it("revoke removes the computer's allowances and expires its waiting and approved requests", async () => {
    const now = Date.now();
    const waiting = (await submit(now) as any).value.request.id;
    const approved = (await submit(now) as any).value.request.id;
    await decideRequest(OWNER, approved, "allow_hour", now);
    expect(state.allowances.size).toBe(1);
    // The approved one has not been dispatched yet; revoke lands first.
    await revokeComputer(OWNER, COMPUTER);
    expect(state.allowances.size).toBe(0);
    expect(state.requests.get(waiting).status).toBe("expired");
    expect(state.requests.get(approved).status).toBe("expired");
    await dispatchRequest(OWNER, approved);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("every enroll of an existing computer raises the generation, tells the relay and clears allowances", async () => {
    const now = Date.now();
    const id = (await submit(now) as any).value.request.id;
    await decideRequest(OWNER, id, "allow_hour", now);
    const enrolled = await enrollComputer(OWNER, "Mac", COMPUTER);
    expect(await redeem(enrolled)).toMatchObject({ generation: 2 });
    expect(revokeRelayConnector).toHaveBeenCalledWith(COMPUTER, 2);
    expect(state.allowances.size).toBe(0);
    await enrollComputer(OWNER, "Mac", COMPUTER);
    expect(revokeRelayConnector).toHaveBeenLastCalledWith(COMPUTER, 3);
    expect(state.computers.get(COMPUTER).revoked_at).toBeNull();
  });

  it("a brand-new computer needs no relay revoke", async () => {
    state.computers.clear();
    const enrolled = await enrollComputer(OWNER, "New");
    expect(await redeem(enrolled)).toMatchObject({ generation: 1 });
    expect(revokeRelayConnector).not.toHaveBeenCalled();
  });

  it("an allowance is granted only by the call that approved the request", async () => {
    const now = Date.now();
    const id = (await submit(now) as any).value.request.id;
    await decideRequest(OWNER, id, "deny", now);
    expect(await decideRequest(OWNER, id, "allow_hour", now)).toMatchObject({ ok: false, status: 409 });
    expect(state.allowances.size).toBe(0);
  });

  it("the ticket also binds the time limit and the output cap", async () => {
    const id = (await submit() as any).value.request.id;
    await decideRequest(OWNER, id, "approve");
    await dispatchRequest(OWNER, id);
    const claims = JSON.parse(Buffer.from(mockExec.mock.calls[0][1].split(".")[0], "base64url").toString());
    expect(claims).toMatchObject({ timeoutSeconds: 30, maxOutputBytes: 256 * 1024 });
  });

  it("stale pending requests are flipped to expired and the list carries no output", async () => {
    const now = Date.now();
    const id = (await submit(now) as any).value.request.id;
    const rows = await expireStale([{ ...state.requests.get(id) }], now + 11 * 60_000);
    expect(rows[0].status).toBe("expired");
    expect(state.requests.get(id).status).toBe("expired");
    const done = { ...state.requests.get(id), status: "done", result: { stdout: "secret" } };
    expect(publicRequest(done, false)).not.toHaveProperty("result");
    expect(publicRequest(done, false)).toMatchObject({ hasResult: true });
  });

  it("the bridge key is random, stored encrypted, rotated on re-enroll and on revoke, and never relay-derived", async () => {
    const first = await enrollComputer(OWNER, "Mac", COMPUTER);
    const key1 = (await redeem(first)).bridgeKey as string;
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    const derived = createHmac("sha256", SECRET).update(`bridge-ticket|v1|${COMPUTER}`).digest("hex");
    expect(key1).not.toBe(derived);
    const stored1 = state.computers.get(COMPUTER).bridge_key_encrypted as string;
    expect(stored1).not.toContain(key1);
    expect(decryptSecret(stored1)).toBe(key1);
    const second = await enrollComputer(OWNER, "Mac", COMPUTER);
    const key2 = (await redeem(second)).bridgeKey as string;
    expect(key2).not.toBe(key1);
    await revokeComputer(OWNER, COMPUTER);
    const stored3 = state.computers.get(COMPUTER).bridge_key_encrypted as string;
    expect(decryptSecret(stored3)).not.toBe(key2);
  });

  it("a revoked computer gets no ticket even if a request was already approved", async () => {
    const id = (await submit() as any).value.request.id;
    await decideRequest(OWNER, id, "approve");
    state.computers.get(COMPUTER).revoked_at = "now";
    await dispatchRequest(OWNER, id);
    expect(mockExec).not.toHaveBeenCalled();
    expect(state.requests.get(id).status).toBe("failed");
  });

  it("output older than 7 days reads as gone", () => {
    const row = { result: { stdout: "x" }, finished_at: "2026-11-01T00:00:00Z" } as any;
    expect(withoutOldResult(row, Date.parse("2026-11-07T00:00:00Z")).result).toEqual({ stdout: "x" });
    expect(withoutOldResult(row, Date.parse("2026-11-09T00:00:01Z")).result).toBeNull();
  });
});
