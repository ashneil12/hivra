/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET } from "../route";
import { BINDING_TAG, USAGE_LINE_1113 } from "@/lib/hivra/__tests__/fixtures/proxmox-usage-captures";

// GET /api/hivra/agents/[id]/usage: owner-scoped like its neighbours, one host
// read per computer per 20 s through the cache's single-flight claim, the
// last read kept when the host can't be reached, the same ownership checks as
// Stop, and never a host name, address, binding value or bearer in the answer.

const mockAuth = jest.fn();
const mockRpc = jest.fn();
const mockRun = jest.fn();
const mockRateLimit = jest.fn();
const mockMatchPrepared = jest.fn();
const mockLogError = jest.fn();
let mockHivraAllowed = true;
let mockRow: Record<string, unknown> | null;
let mockCache: Record<string, unknown> | null;
const agentQueries: Array<{ method: string; args: unknown[] }> = [];

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => mockHivraAllowed }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq"]) {
        chain[method] = (...args: unknown[]) => {
          if (table === "hivra_agents") agentQueries.push({ method, args });
          return chain;
        };
      }
      chain.maybeSingle = async () => ({ data: table === "hivra_agents" ? mockRow : mockCache, error: null });
      return chain;
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: (_env: unknown, host: string) => ({ env: { PROXMOX_SSH_HOST: `ssh-for-${host}` } }),
  runProxmoxHostScript: (...args: unknown[]) => mockRun(...args),
}));
jest.mock("@/lib/infrastructure/proxmox-execution-context", () => {
  class ProxmoxExecutionContextError extends Error {
    constructor(public readonly code: string) { super(code); }
  }
  return {
    ProxmoxExecutionContextError,
    resolveSelfManagedProxmoxExecutionContext: async () => {
      throw new ProxmoxExecutionContextError("network_unavailable");
    },
  };
});
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({ matchPreparedCanaryComputer: (...args: unknown[]) => mockMatchPrepared(...args) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: (...args: unknown[]) => mockLogError(...args) } }));

const ID = "11111111-1111-4111-8111-111111111111";
const BEARER = "fixture-bearer-token";
const PRIVATE_IP = "10.250.20.63";
const running = {
  id: ID, user_id: "owner", type: "linux-desktop", computer_profile: "ubuntu-desktop", status: "running", desired_state: "running",
  computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", managed_provisioner_channel: "default",
  proxmox_host: "fixturenode11", vmid: 1113, ip: PRIVATE_IP, cpu: 2, ram: 4, api_token: BEARER,
  infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
};
const SAMPLE = JSON.parse(USAGE_LINE_1113.slice("HIVRA_USAGE_V1 ".length));
const stored = (recordedStatus = "running") => ({ v: 1, result: "sample", recordedStatus, sample: SAMPLE });
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function get(query = "", id = ID) {
  return GET(new NextRequest(`https://hivra.cloud/api/hivra/agents/${id}/usage${query}`, { headers: { Host: "hivra.cloud" } }),
    { params: Promise.resolve({ id }) });
}
const rpcNames = () => mockRpc.mock.calls.map(([name]) => name);
const rpcArgs = (name: string) => mockRpc.mock.calls.find(([called]) => called === name)?.[1];

beforeEach(() => {
  jest.clearAllMocks();
  agentQueries.length = 0;
  mockHivraAllowed = true;
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockRow = { ...running };
  mockCache = null;
  mockRateLimit.mockReturnValue(null);
  mockMatchPrepared.mockReturnValue(null);
  mockRun.mockResolvedValue({ ok: true, stdout: `${USAGE_LINE_1113}\n`, stderr: "" });
  mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_hivra_computer_usage_refresh") return { data: { claimed: true, refreshing: false, sample: mockCache?.sample ?? null, observedAt: mockCache?.observed_at ?? null, lastErrorCode: null }, error: null };
    if (name === "record_hivra_computer_usage") {
      return { data: { sample: args.p_clear_sample ? null : args.p_sample ?? mockCache?.sample ?? null, observedAt: args.p_sample ? new Date().toISOString() : args.p_clear_sample ? null : mockCache?.observed_at ?? null, lastErrorCode: args.p_error_code }, error: null };
    }
    return { data: null, error: { message: "unexpected" } };
  });
});

describe("GET /api/hivra/agents/[id]/usage", () => {
  describe("access", () => {
    it("needs a signed-in owner", async () => {
      mockAuth.mockResolvedValue({ userId: null });
      expect((await get()).status).toBe(401);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("is not found outside Hivra, for a malformed id, and for another owner's or a deleted computer", async () => {
      mockHivraAllowed = false;
      expect((await get()).status).toBe(404);
      mockHivraAllowed = true;
      expect((await get("", "not-a-uuid")).status).toBe(404);
      mockRow = null;
      expect((await get()).status).toBe(404);
      // The row is read for this owner only, never a deleted one.
      expect(agentQueries).toEqual(expect.arrayContaining([
        { method: "eq", args: ["id", ID] }, { method: "eq", args: ["user_id", "owner"] }, { method: "neq", args: ["status", "deleted"] },
      ]));
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("is rate limited per owner before anything is read", async () => {
      const limited = new Response(JSON.stringify({ success: false, error: "Too Many Requests" }), { status: 429, headers: { "Retry-After": "42" } });
      mockRateLimit.mockReturnValue(limited);
      const response = await get();
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("42");
      expect(mockRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ routeKey: "hivra_computer_usage", userId: "owner" }));
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  describe("the cache", () => {
    it("serves a fresh read without claiming or reading the host", async () => {
      mockCache = { sample: stored(), observed_at: secondsAgo(5), last_error_code: null };
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
      expect((await response.json()).data).toMatchObject({ supported: true, stale: false, refreshing: false, cpu: { percent: 1.1, vcpus: 4 } });
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("never reads the host for ?cached=1, even with nothing stored", async () => {
      const response = await get("?cached=1");
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ observedAt: null, stale: true, power: { observed: "unknown" } });
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("reads the host once when the claim is won, stores the read and answers with it", async () => {
      mockCache = { sample: stored(), observed_at: secondsAgo(45), last_error_code: null };
      const response = await get();
      expect(response.status).toBe(200);
      expect(rpcNames()).toEqual(["claim_hivra_computer_usage_refresh", "record_hivra_computer_usage"]);
      expect(rpcArgs("claim_hivra_computer_usage_refresh")).toEqual({ p_agent_id: ID, p_user_id: "owner", p_source: "proxmox", p_fresh_seconds: 20, p_claim_seconds: 20 });
      expect(rpcArgs("record_hivra_computer_usage")).toEqual({ p_agent_id: ID, p_user_id: "owner", p_sample: stored(), p_error_code: null, p_clear_sample: false });
      expect(mockRun).toHaveBeenCalledTimes(1);
      const [script, env, options] = mockRun.mock.calls[0];
      expect(script).toContain(`EXPECTED_BINDING_TAG='${BINDING_TAG}'`);
      expect(env).toEqual({ PROXMOX_SSH_HOST: "ssh-for-fixturenode11" });
      expect(options).toEqual({ timeoutMs: 20_000, maxOutputBytes: 16_384 });
      const body = await response.json();
      expect(body.data).toMatchObject({
        supported: true, source: "proxmox", stale: false,
        power: { observed: "running", recorded: "running", matches: true },
        uptimeSeconds: 688433,
        memory: { usedBytes: 4209631232, maximumBytes: 8589934592, includesCache: true },
        disk: { usedBytes: 21686575104, sizeBytes: 41412915200, allocatedBytes: 42949672960, guestReported: true },
      });
      const text = JSON.stringify(body);
      for (const secret of [BEARER, PRIVATE_IP, "fixturenode11", BINDING_TAG, "b".repeat(32)]) expect(text).not.toContain(secret);
    });

    it("serves the last read, marked as refreshing, when another request is reading the host", async () => {
      mockCache = { sample: stored(), observed_at: secondsAgo(45), last_error_code: null };
      mockRpc.mockImplementation(async (name: string) => name === "claim_hivra_computer_usage_refresh"
        ? { data: { claimed: false, refreshing: true, sample: stored(), observedAt: mockCache?.observed_at, lastErrorCode: null }, error: null }
        : { data: null, error: null });
      const response = await get();
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ refreshing: true, cpu: { percent: 1.1 } });
      expect(mockRun).not.toHaveBeenCalled();
    });

    // Regression: a failed read keeps other readers off for 20 s, and a
    // Refresh inside that window was answered "refreshing" with nothing
    // stored, so the page showed "Reading…" for a read that wasn't happening
    // and hid the failure.
    it("doesn't call a failed read's back-off a read in progress, and says the host couldn't be reached", async () => {
      mockRun.mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "connect ECONNREFUSED" });
      expect((await get()).status).toBe(503);
      expect(mockRun).toHaveBeenCalledTimes(1);

      mockCache = { sample: null, observed_at: null, last_error_code: "host_unreachable" };
      mockRpc.mockImplementation(async (name: string) => name === "claim_hivra_computer_usage_refresh"
        ? { data: { claimed: false, refreshing: false, sample: null, observedAt: null, lastErrorCode: "host_unreachable" }, error: null }
        : { data: null, error: null });
      const response = await get();
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ observedAt: null, refreshing: false, notes: ["host_unreachable"] });
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("keeps the last read, not refreshing, while a failed read is backed off", async () => {
      mockCache = { sample: stored(), observed_at: secondsAgo(300), last_error_code: "host_unreachable" };
      mockRpc.mockImplementation(async (name: string) => name === "claim_hivra_computer_usage_refresh"
        ? { data: { claimed: false, refreshing: false, sample: stored(), observedAt: mockCache?.observed_at, lastErrorCode: "host_unreachable" }, error: null }
        : { data: null, error: null });
      const response = await get();
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ refreshing: false, stale: true, notes: ["host_unreachable"], cpu: { percent: 1.1 } });
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("reads again at once after the computer changed state, instead of serving a read from before", async () => {
      mockRow = { ...running, status: "stopped", desired_state: "stopped" };
      mockCache = { sample: stored("running"), observed_at: secondsAgo(3), last_error_code: null };
      mockRun.mockResolvedValue({ ok: true, stdout: `HIVRA_USAGE_V1 ${JSON.stringify({ ...SAMPLE, vm: { ...SAMPLE.vm, status: "stopped", uptime: 0, cpu: 0, mem: 0 }, guest: { rc: 2, readable: false, root: null } })}\n`, stderr: "" });
      const response = await get();
      expect(rpcArgs("claim_hivra_computer_usage_refresh")).toMatchObject({ p_fresh_seconds: 0 });
      expect((await response.json()).data).toMatchObject({ power: { observed: "stopped", recorded: "stopped", matches: true }, notes: [] });
    });

    it("shares one host read between concurrent requests in the same server", async () => {
      let finish!: (value: unknown) => void;
      mockRun.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const first = get();
      const second = get();
      await new Promise((resolve) => setTimeout(resolve, 20));
      finish({ ok: true, stdout: `${USAGE_LINE_1113}\n`, stderr: "" });
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("failures", () => {
    it("keeps the last read, and says the host couldn't be reached, when the read fails", async () => {
      mockCache = { sample: stored(), observed_at: secondsAgo(300), last_error_code: null };
      mockRun.mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "Proxmox SSH operation timed out after 20000ms" });
      const response = await get();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toMatchObject({ stale: true, notes: ["host_unreachable"], cpu: { percent: 1.1 } });
      expect(rpcArgs("record_hivra_computer_usage")).toMatchObject({ p_sample: null, p_error_code: "host_unreachable", p_clear_sample: false });
      expect(JSON.stringify(body)).not.toContain("SSH");
    });

    it("answers 503 when the host can't be reached and nothing was read before", async () => {
      mockRun.mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "connect ECONNREFUSED" });
      const response = await get();
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("Hivra couldn't reach this computer's host just now.");
    });

    it("refuses, drops the stored read and logs it when the host's computer doesn't carry this row's binding", async () => {
      mockCache = { sample: stored(), observed_at: secondsAgo(300), last_error_code: null };
      mockRun.mockResolvedValue({ ok: false, stdout: "HIVRA_USAGE_BINDING_MISMATCH\n", stderr: "", error: "Remote bash exited with code 3" });
      const response = await get();
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("Hivra couldn't confirm this computer belongs to you, so it didn't read it.");
      expect(rpcArgs("record_hivra_computer_usage")).toMatchObject({ p_sample: null, p_error_code: "binding_mismatch", p_clear_sample: true });
      expect(mockLogError).toHaveBeenCalledWith(expect.any(String), expect.any(Error), expect.objectContaining({ failureType: "hivra_usage_binding_mismatch" }));
      // A cached read afterwards stays refused.
      mockCache = { sample: null, observed_at: null, last_error_code: "binding_mismatch" };
      expect((await get("?cached=1")).status).toBe(409);
    });

    it("stores a missing computer as missing", async () => {
      mockRow = { ...running, status: "stopped", desired_state: "stopped" };
      mockRun.mockResolvedValue({ ok: true, stdout: "HIVRA_USAGE_VM_MISSING\n", stderr: "" });
      const body = await (await get()).json();
      expect(body.data).toMatchObject({ power: { observed: "missing", matches: true }, notes: ["vm_missing"] });
      expect(rpcArgs("record_hivra_computer_usage")).toMatchObject({ p_sample: { v: 1, result: "missing", recordedStatus: "stopped" } });
    });

    it("treats output it doesn't recognise as a failed read, never as usage", async () => {
      mockRun.mockResolvedValue({ ok: true, stdout: "some other output\n", stderr: "" });
      expect((await get()).status).toBe(503);
      expect(rpcArgs("record_hivra_computer_usage")).toMatchObject({ p_error_code: "probe_invalid" });
    });
  });

  describe("authority", () => {
    it("reads an older Hivra Cloud computer without a binding tag under its exact VM name", async () => {
      mockRow = { ...running, vmid: 1104, infrastructure_binding_token_enforced: false };
      await get();
      const [script] = mockRun.mock.calls[0];
      expect(script).toContain("EXPECTED_BINDING_TAG=''");
      expect(script).toContain("EXPECTED_NAME='hivra-cc-1104'");
    });

    it("reads a prepared computer only when its slot matches, by its claim marker", async () => {
      mockRow = { ...running, computer_profile: "windows", managed_provisioner_channel: "canary", vmid: 2098 };
      const refused = await get();
      expect(refused.status).toBe(409);
      expect(mockRun).not.toHaveBeenCalled();

      mockMatchPrepared.mockReturnValue({ profile: "windows", slot: { host: "fixturenode11", node: "fixturenode11", vmid: 2098, ip: "10.250.20.98", claim: "33333333-3333-4333-8333-333333333333" } });
      await get();
      const [script, env] = mockRun.mock.calls[0];
      expect(script).toContain("EXPECTED_MARKER_ENCODED='hivra-windows-operation%3A33333333-3333-4333-8333-333333333333'");
      expect(script).toContain("EXPECTED_NAME='hivra-windows-canary'");
      expect(script).toContain(`EXPECTED_BINDING_TAG='${BINDING_TAG}'`);
      expect(env).toEqual({ PROXMOX_SSH_HOST: "ssh-for-fixturenode11" });
    });

    it("refuses a My server computer without ownership checks", async () => {
      mockRow = { ...running, deployment_mode: "self-managed", infrastructure_binding_token_enforced: false };
      expect((await get()).status).toBe(409);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("passes on the execution context's own refusal, without a host read", async () => {
      mockRow = {
        ...running, deployment_mode: "self-managed", proxmox_host: "__hivra_self_managed_no_ambient_authority__",
        infrastructure_connection_id: "22222222-2222-4222-8222-222222222222", deployment_target_id: "44444444-4444-4444-8444-444444444444",
        infrastructure_connection_revision: 3,
      };
      const response = await get();
      expect(response.status).toBe(503);
      expect(mockRun).not.toHaveBeenCalled();
      expect(rpcArgs("record_hivra_computer_usage")).toMatchObject({ p_error_code: "context_unavailable" });
    });

    it("waits for a computer that isn't set up yet", async () => {
      mockRow = { ...running, status: "provisioning", vmid: null };
      const response = await get();
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("Usage appears once this computer is set up.");
    });
  });

  describe("computers without live usage", () => {
    it.each([
      ["a Linux Sandbox", { computer_substrate: "gvisor", computer_profile: "linux-terminal", vmid: null, gvisor_observation: { state: "running", cpu: 1, memoryMb: 2048 } }, "gvisor", { cpu: 1, ramGb: 2 }],
      ["a DigitalOcean session", { type: "codex", computer_profile: null, computer_substrate: "do-managed-session", vmid: null, cpu: 2, ram: 4 }, "digitalocean", { cpu: 2, ramGb: 4 }],
      ["a My cloud computer", { computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, ip: "192.0.2.80", cpu: 4, ram: 8 }, "hetzner", { cpu: 4, ramGb: 8 }],
    ])("says why for %s, with the status and size Hivra holds, and makes no host or provider call", async (_case, fields, source, size) => {
      mockRow = { ...running, ...fields };
      const response = await get();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toMatchObject({ supported: false, source, reason: expect.stringMatching(/^Live usage isn't available/), size, power: { recorded: "running" } });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain("192.0.2.80");
    });
  });
});
