/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  runProxmoxHostScriptWithStdin: jest.fn(),
  resolveProxmoxTargetConfiguration: jest.fn(),
}));
jest.mock("@/lib/hivra/agent-wake", () => ({
  readHivraAgentRow: jest.fn(),
  resolveSleepTarget: jest.fn(),
  ensureHivraAgentAwake: jest.fn(),
}));

import { log } from "@/lib/logger";
import type { TunnelConnector } from "@/lib/services/cloudflare-tunnel";
import { enableHostIngress, ingressAgentRefusal, type IngressDeps } from "../enable";
import { releaseHostIngressOnDelete, rollbackHostIngress } from "../rollback";
import type { AgentIngressRow, IngressPatch } from "../store";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TUNNEL = "22222222-2222-4222-8222-222222222222";
const HOSTNAME = "box-4321.example.test";
const SECRET_ENV = { HIVRA_HOST_INGRESS: "canary", HIVRA_INGRESS_SECRET: "s".repeat(40) };
const ids = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

type Step = "preflight" | "forwarder" | "attach" | "detach" | "guest_disable" | "guest_enable" | "rotate" | "edge" | "origin" | "list_host";

/**
 * A fake world: one guest connector and maybe one host connector, a tunnel
 * secret generation, and which side is reachable. Each step can be made to
 * fail. Every script, stdin, store patch and log line is kept so the tests can
 * check where the run document went.
 */
function world(options: { fail?: Step[]; mode?: "guest" | "host"; phase?: string; agent?: Record<string, unknown> } = {}) {
  const fail = new Set(options.fail ?? []);
  let serial = 1;
  const state = {
    secret: 1,
    guest: (options.mode ?? "guest") === "guest" ? { id: ids(serial++), secret: 1, on: true } : { id: "", secret: 0, on: false },
    host: (options.mode ?? "guest") === "host" ? { id: ids(serial++), secret: 1, on: true } : { id: "", secret: 0, on: false },
    guestTokenFile: (options.mode ?? "guest") === "guest",
    hostFiles: (options.mode ?? "guest") === "host",
    origin: "http://localhost:8080",
  };
  let row: AgentIngressRow = {
    agent_id: AGENT, vmid: 4321, host_id: "hosta", mode: options.mode ?? "guest", phase: options.phase ?? ((options.mode ?? "guest") === "host" ? "cutover" : "none"),
    metrics_port: null, generation: 3, last_error: null, lease_id: null, lease_expires_at: null, updated_at: null,
  };
  let rowExists = options.mode !== undefined;
  const scripts: string[] = [];
  const stdins: string[] = [];
  const patches: IngressPatch[] = [];
  const token = () => `run-doc-${"x".repeat(40)}-gen${state.secret}`;
  const answer = (step: string, ok: boolean, reason?: string) =>
    ({ ok: true, stderr: "", stdout: `HIVRA_INGRESS_STEP ${JSON.stringify({ step, ok, ms: 1, ...(ok ? {} : { reason: reason ?? "injected" }) })}\n` });

  const deps: Partial<IngressDeps> = {
    env: SECRET_ENV,
    readAgent: async () => ({
      id: AGENT, user_id: "u", status: "running", desired_state: "running", operation_id: null, sleep_state: "awake",
      computer_substrate: "proxmox-kvm", cf_tunnel_id: TUNNEL, cf_hostname: HOSTNAME, ip: "10.250.20.57", vmid: 4321,
      ...(options.agent ?? {}),
    }),
    resolveTarget: async () => ({ env: {}, vmid: 4321, bindingTag: "hivra-agent-abc", hostId: "hosta", managed: true }),
    readHostRow: async () => ({ ingress_mode: "canary" }),
    runHostScript: async (script) => {
      scripts.push(script);
      if (script.includes("HIVRA_INGRESS_FWD")) {
        return fail.has("forwarder")
          ? { ok: true, stderr: "", stdout: "HIVRA_INGRESS_FWD_REFUSED asleep\n" }
          : { ok: true, stderr: "", stdout: 'HIVRA_INGRESS_FWD {"v":1,"op":"install","ok":true,"ms":1,"kind":"proxyd","gateway":"10.250.20.1","port":18080}\n' };
      }
      if (script.includes("SCRIPT='preflight'")) return answer("preflight", !fail.has("preflight"), "proxy_unhealthy");
      if (script.includes("SCRIPT='detach'")) {
        if (fail.has("detach")) return answer("detach", false, "remove_incomplete");
        state.host.on = false;
        state.hostFiles = false;
        return answer("detach", true);
      }
      if (script.includes("SCRIPT='guest_disable'")) {
        if (fail.has("guest_disable")) return answer("guest_disable", false, "still_active");
        state.guest.on = false;
        state.guestTokenFile = false;
        return answer("guest_disable", true);
      }
      if (script.includes("SCRIPT='status'")) return answer("status", true);
      return { ok: false, stderr: "", stdout: "" };
    },
    runHostScriptWithStdin: async (script, stdin) => {
      scripts.push(script);
      stdins.push(stdin);
      const doc = JSON.parse(stdin) as { token: string };
      const generation = Number(/gen(\d+)$/.exec(doc.token)?.[1]);
      if (script.includes("SCRIPT='attach'")) {
        if (fail.has("attach")) return answer("connector", false, "connector_not_ready");
        state.host = { id: ids(serial++), secret: generation, on: true };
        state.hostFiles = true;
        return answer("attach", true);
      }
      if (script.includes("SCRIPT='guest_enable'")) {
        if (fail.has("guest_enable")) return answer("guest_enable", false, "restart_failed");
        state.guest = { id: ids(serial++), secret: generation, on: true };
        state.guestTokenFile = true;
        return answer("guest_enable", true);
      }
      return { ok: false, stderr: "", stdout: "" };
    },
    store: {
      read: async () => (rowExists ? { ...row } : null),
      ensure: async () => { if (!rowExists) { rowExists = true; } },
      claim: async ({ leaseId }) => {
        if (row.lease_id) return false;
        row = { ...row, lease_id: leaseId, lease_expires_at: "later" };
        return true;
      },
      update: async ({ leaseId, patch }) => {
        if (row.lease_id !== leaseId) return false;
        patches.push(patch);
        row = { ...row, ...patch } as AgentIngressRow;
        return true;
      },
      release: async ({ leaseId, patch }) => {
        if (row.lease_id !== leaseId) return false;
        if (patch) patches.push(patch);
        row = { ...row, ...(patch ?? {}), lease_id: null, lease_expires_at: null } as AgentIngressRow;
        return true;
      },
      listPorts: async () => [21000],
    },
    cf: {
      getToken: async () => token(),
      listConnections: async () => {
        const list: TunnelConnector[] = [];
        if (state.guest.on) list.push({ clientId: state.guest.id, version: null, runAt: null, connections: 4 });
        if (state.host.on && !(fail.has("list_host") && state.host.id)) list.push({ clientId: state.host.id, version: null, runAt: null, connections: 4 });
        return list;
      },
      rotateSecret: async () => {
        if (fail.has("rotate")) throw new Error("rotate failed");
        state.secret += 1;
      },
      deleteConnection: async (_tunnel, clientId) => {
        if (state.guest.id === clientId && !state.guestTokenFile) state.guest.on = false;
        if (state.host.id === clientId && !state.hostFiles) state.host.on = false;
      },
      getOrigin: async () => state.origin,
      setOrigin: async (_tunnel, _host, service) => {
        if (fail.has("origin")) throw new Error("origin failed");
        state.origin = service;
      },
    },
    edgeHealthy: async () => !fail.has("edge") && (state.guest.on || state.host.on),
    ensureAwake: async () => true,
    sleep: async () => undefined,
    newLeaseId: () => ids(900 + serial++),
  };
  const reachable = () => state.guest.on || state.host.on;
  // After every connector reconnects: only one holding the current secret registers again.
  const reachableAfterReconnect = () =>
    (state.guest.on && state.guest.secret === state.secret) || (state.host.on && state.host.secret === state.secret);
  const leaks = () => {
    const pattern = /run-doc-x{40}/;
    const logged = JSON.stringify([(log.info as jest.Mock).mock.calls, (log.warn as jest.Mock).mock.calls, (log.error as jest.Mock).mock.calls]);
    return {
      scripts: scripts.some((script) => pattern.test(script)),
      patches: patches.some((patch) => pattern.test(JSON.stringify(patch))),
      logs: pattern.test(logged),
    };
  };
  return { deps, state, row: () => row, patches, stdins, reachable, reachableAfterReconnect, leaks };
}

beforeEach(() => jest.clearAllMocks());

describe("enableHostIngress", () => {
  it("moves the connector to the host, deletes the guest token file and records host/cutover", async () => {
    const w = world();
    const result = await enableHostIngress(AGENT, w.deps);
    expect(result).toMatchObject({ ok: true, mode: "host", phase: "cutover" });
    expect(w.state.host.on).toBe(true);
    expect(w.state.host.secret).toBe(2);
    expect(w.state.guest.on).toBe(false);
    expect(w.state.guestTokenFile).toBe(false);
    expect(w.state.origin).toBe("http://127.0.0.1:8080");
    expect(w.row()).toMatchObject({ mode: "host", phase: "cutover", generation: 4, metrics_port: 21001, lease_id: null });
    expect(w.leaks()).toEqual({ scripts: false, patches: false, logs: false });
    // The token went only as stdin, and only to the attach step.
    expect(w.stdins).toHaveLength(1);
    // The lease is renewed before the long steps (an empty patch only renews it).
    expect(w.patches.filter((patch) => Object.keys(patch).length === 0).length).toBeGreaterThanOrEqual(3);
  });

  it("gives the route the box bearer's hash and the owner's agent page for client wakes, when it has them", async () => {
    const { createHash } = await import("node:crypto");
    const boxCredential = "ab".repeat(32);
    const w = world({ agent: { api_token: boxCredential } });
    const env = { ...SECRET_ENV, NEXT_PUBLIC_APP_URL: "https://dashboard.example.test" };
    await expect(enableHostIngress(AGENT, { ...w.deps, env })).resolves.toMatchObject({ ok: true });
    const route = (JSON.parse(w.stdins[0]) as { route: Record<string, unknown> }).route;
    expect(route.bearer_sha256).toBe(createHash("sha256").update(boxCredential).digest("hex"));
    expect(route.wake_url).toBe(`https://dashboard.example.test/dashboard/agent/${AGENT}`);
    expect(w.stdins[0]).not.toContain(boxCredential);
    // Without either, the route is exactly what it was: tickets only.
    const plain = world();
    await enableHostIngress(AGENT, plain.deps);
    const plainRoute = (JSON.parse(plain.stdins[0]) as { route: Record<string, unknown> }).route;
    expect(Object.keys(plainRoute).sort()).toEqual(["binding_tag", "generation", "guest_ip", "guest_port", "hostname", "ticket_key", "version", "vmid"]);
  });

  it("lets go of its lease and changes nothing when a sleep claimed the agent in the meantime", async () => {
    const w = world();
    let reads = 0;
    const readAgent = async (id: string) => {
      reads += 1;
      const agent = await w.deps.readAgent!(id);
      return reads > 1 ? { ...agent, operation_id: "sleep-op" } : agent;
    };
    const result = await enableHostIngress(AGENT, { ...w.deps, readAgent });
    expect(result).toMatchObject({ ok: false, reason: "agent_busy", httpStatus: 409 });
    expect(w.row().lease_id).toBeNull();
    expect(w.state.guest.on).toBe(true);
    expect(w.state.secret).toBe(1);
  });

  it("answers already for an agent in host mode", async () => {
    const w = world({ mode: "host" });
    await expect(enableHostIngress(AGENT, w.deps)).resolves.toMatchObject({ ok: true, already: true, mode: "host" });
  });

  it("is refused with any switch off or no secret, and changes nothing", async () => {
    for (const env of [{ ...SECRET_ENV, HIVRA_HOST_INGRESS: "off" }, { HIVRA_HOST_INGRESS: "on" }]) {
      const w = world();
      const result = await enableHostIngress(AGENT, { ...w.deps, env });
      expect(result.ok).toBe(false);
      expect(w.state.guest.on).toBe(true);
      expect(w.state.secret).toBe(1);
    }
    const w = world();
    const off = await enableHostIngress(AGENT, { ...w.deps, readHostRow: async () => ({ ingress_mode: "off" }) });
    expect(off).toMatchObject({ ok: false, reason: "ingress_off" });
  });

  it("refuses an agent that is asleep, busy or has no named tunnel", async () => {
    expect(ingressAgentRefusal({ status: "running", sleep_state: "napping", cf_tunnel_id: TUNNEL, cf_hostname: HOSTNAME, ip: "10.250.20.57" })).toBe("agent_asleep");
    expect(ingressAgentRefusal({ status: "running", operation_id: "x", cf_tunnel_id: TUNNEL, cf_hostname: HOSTNAME, ip: "10.250.20.57" })).toBe("agent_busy");
    expect(ingressAgentRefusal({ status: "running", cf_tunnel_id: null, cf_hostname: null, ip: "10.250.20.57" })).toBe("no_named_tunnel");
    const w = world({ agent: { sleep_state: "napping" } });
    await expect(enableHostIngress(AGENT, w.deps)).resolves.toMatchObject({ ok: false, reason: "agent_asleep", httpStatus: 409 });
  });

  it.each<Step[]>([
    ["preflight"], ["forwarder"], ["origin"], ["rotate"], ["attach"], ["list_host"], ["guest_disable"], ["edge"],
    ["attach", "guest_enable"], ["guest_disable", "guest_enable"], ["edge", "guest_enable"], ["edge", "detach"],
  ])("a failure at %s leaves the agent reachable", async (...failures) => {
    const w = world({ fail: failures });
    const result = await enableHostIngress(AGENT, w.deps);
    expect(result.ok).toBe(false);
    expect(w.reachable()).toBe(true);
    expect(w.row().lease_id).toBeNull();
    // The row says which side serves: host only when the guest could not be brought back.
    if (w.row().last_error === "recovery_failed") {
      // The guest could not take the new token: whatever still serves stays.
      expect(w.row().mode === "host" ? w.state.host.on : w.state.guest.on).toBe(true);
    } else if (w.row().mode === "guest") {
      expect(w.state.guest.on).toBe(true);
      expect(w.state.guest.secret).toBe(w.state.secret === 1 ? 1 : w.state.secret);
    } else {
      expect(w.state.host.on).toBe(true);
      expect(w.row()).toMatchObject({ phase: "failed", last_error: "recovery_failed" });
    }
    if (failures.includes("detach")) expect(w.row()).toMatchObject({ mode: "guest", last_error: "detach_failed" });
    expect(w.leaks()).toEqual({ scripts: false, patches: false, logs: false });
  });

  it("does not run while another enable or rollback holds the lease", async () => {
    const w = world();
    await w.deps.store!.claim({ agentId: AGENT, leaseId: ids(999) });
    await expect(enableHostIngress(AGENT, w.deps)).resolves.toMatchObject({ ok: false, reason: "lease_held" });
    expect(w.state.secret).toBe(1);
  });
});

describe("rollbackHostIngress", () => {
  it("puts the connector back into the guest with a fresh token and removes the host side", async () => {
    const w = world();
    await enableHostIngress(AGENT, w.deps);
    const result = await rollbackHostIngress(AGENT, w.deps);
    expect(result).toMatchObject({ ok: true, mode: "guest", phase: "rolled_back" });
    expect(w.state.guest.on).toBe(true);
    expect(w.state.guestTokenFile).toBe(true);
    expect(w.state.guest.secret).toBe(w.state.secret);
    expect(w.state.host.on).toBe(false);
    expect(w.state.hostFiles).toBe(false);
    expect(w.state.origin).toBe("http://localhost:8080");
    expect(w.row()).toMatchObject({ mode: "guest", phase: "rolled_back", generation: 5 });
    expect(w.leaks()).toEqual({ scripts: false, patches: false, logs: false });
  });

  it("is idempotent", async () => {
    const w = world({ mode: "host" });
    await rollbackHostIngress(AGENT, w.deps);
    const again = await rollbackHostIngress(AGENT, w.deps);
    expect(again).toMatchObject({ ok: true, mode: "guest", already: true });
    expect(w.state.guest.on).toBe(true);
    const none = world();
    await expect(rollbackHostIngress(AGENT, none.deps)).resolves.toMatchObject({ ok: true, already: true, phase: "none" });
  });

  it("works with every switch off", async () => {
    const w = world({ mode: "host" });
    const result = await rollbackHostIngress(AGENT, { ...w.deps, env: {}, readHostRow: async () => ({ ingress_mode: "off" }) });
    expect(result.ok).toBe(true);
  });

  it.each<Step[]>([["guest_enable"], ["detach"]])("a failure at %s leaves the agent reachable, on a secret that still works", async (...failures) => {
    const w = world({ mode: "host", fail: failures });
    const result = await rollbackHostIngress(AGENT, w.deps);
    expect(result.ok).toBe(false);
    expect(w.reachable()).toBe(true);
    // Nothing rotated while the host may still be serving: every running connector survives a reconnect.
    expect(w.state.secret).toBe(1);
    expect(w.reachableAfterReconnect()).toBe(true);
    if (failures.includes("guest_enable")) {
      expect(w.state.host.on).toBe(true);
      expect(w.row().mode).toBe("host");
    }
  });

  it("rotates only once the host side is gone, and hands the guest the new token", async () => {
    const w = world({ mode: "host" });
    const result = await rollbackHostIngress(AGENT, w.deps);
    expect(result.ok).toBe(true);
    expect(w.state.secret).toBe(2);
    expect(w.state.guest.secret).toBe(2);
    expect(w.reachableAfterReconnect()).toBe(true);
    const order = result.steps.map((step) => step.step);
    expect(order.indexOf("rotate")).toBeGreaterThan(order.indexOf("detach"));
  });

  it("a failed rotation still finishes the rollback on the old token, and says so", async () => {
    const w = world({ mode: "host", fail: ["rotate"] });
    const result = await rollbackHostIngress(AGENT, w.deps);
    expect(result).toMatchObject({ ok: true, mode: "guest", phase: "rolled_back" });
    expect(w.row().last_error).toBe("rollback_rotate_failed");
    expect(w.reachableAfterReconnect()).toBe(true);
  });

  it("a guest that cannot take the rotated token is recorded stale, and the next rollback hands it over", async () => {
    const w = world({ mode: "host" });
    let enables = 0;
    const flaky: Partial<IngressDeps> = {
      ...w.deps,
      runHostScriptWithStdin: async (script, stdin, env, options) => {
        if (script.includes("SCRIPT='guest_enable'")) {
          enables += 1;
          if (enables > 1 && enables <= 3) return { ok: true, stderr: "", stdout: 'HIVRA_INGRESS_STEP {"step":"guest_enable","ok":false,"ms":1,"reason":"restart_failed"}\n' };
        }
        return w.deps.runHostScriptWithStdin!(script, stdin, env, options);
      },
    };
    const result = await rollbackHostIngress(AGENT, flaky);
    expect(result).toMatchObject({ ok: false, mode: "guest", phase: "failed", reason: "guest_token_stale" });
    expect(w.row()).toMatchObject({ mode: "guest", phase: "failed", last_error: "guest_token_stale" });
    expect(w.reachableAfterReconnect()).toBe(false);
    const again = await rollbackHostIngress(AGENT, flaky);
    expect(again).toMatchObject({ ok: true, mode: "guest", phase: "rolled_back" });
    expect(w.reachableAfterReconnect()).toBe(true);
  });

  it("finishes an enable that was cut short after the guest connector went off: the guest gets the token back before the host side goes", async () => {
    const w = world({ mode: "guest", phase: "host_connector" });
    w.state.secret = 2;
    w.state.guest = { id: w.state.guest.id, secret: 1, on: false };
    w.state.guestTokenFile = false;
    w.state.host = { id: ids(77), secret: 2, on: true };
    w.state.hostFiles = true;
    const result = await rollbackHostIngress(AGENT, w.deps);
    expect(result).toMatchObject({ ok: true, mode: "guest", phase: "rolled_back" });
    expect(w.state.guest).toMatchObject({ on: true, secret: 2 });
    expect(w.state.host.on).toBe(false);
    expect(w.reachableAfterReconnect()).toBe(true);
  });

  it("keeps the host side when the cut-short enable's guest cannot take the token", async () => {
    const w = world({ mode: "guest", phase: "host_connector", fail: ["guest_enable"] });
    w.state.guest.on = false;
    w.state.guestTokenFile = false;
    w.state.host = { id: ids(77), secret: 1, on: true };
    w.state.hostFiles = true;
    const result = await rollbackHostIngress(AGENT, w.deps);
    expect(result).toMatchObject({ ok: false, mode: "guest", phase: "failed" });
    expect(w.state.host.on).toBe(true);
    expect(w.row().last_error).toBe("guest_token_stale");
  });

  it("does nothing to the host when the agent cannot be woken", async () => {
    const w = world({ mode: "host" });
    const result = await rollbackHostIngress(AGENT, { ...w.deps, ensureAwake: async () => false });
    expect(result).toMatchObject({ ok: false, reason: "wake_failed", mode: "host" });
    expect(w.state.host.on).toBe(true);
    expect(w.state.secret).toBe(1);
  });
});

describe("releaseHostIngressOnDelete", () => {
  it("does one read and nothing else for an agent that never used host ingress", async () => {
    const runDetach = jest.fn();
    await releaseHostIngressOnDelete({ agentId: AGENT, hostname: HOSTNAME }, { read: async () => null, runDetach, env: SECRET_ENV });
    expect(runDetach).not.toHaveBeenCalled();
  });

  it("reads nothing at all when host ingress was never configured here", async () => {
    const read = jest.fn();
    await releaseHostIngressOnDelete({ agentId: AGENT, hostname: HOSTNAME }, { read, env: {} });
    expect(read).not.toHaveBeenCalled();
  });

  it("detaches on the row's host and drops the row", async () => {
    const runDetach = jest.fn(async () => true);
    const remove = jest.fn(async () => true);
    const row = { agent_id: AGENT, vmid: 4321, host_id: "hosta" } as AgentIngressRow;
    await releaseHostIngressOnDelete({ agentId: AGENT, hostname: "BOX-4321.example.test" }, { read: async () => row, runDetach, remove, env: SECRET_ENV });
    expect(runDetach).toHaveBeenCalledWith("hosta", 4321, HOSTNAME);
    expect(remove).toHaveBeenCalledWith(AGENT);
  });

  it("never throws and keeps the row when the host cleanup fails", async () => {
    const remove = jest.fn();
    const row = { agent_id: AGENT, vmid: 4321, host_id: "hosta" } as AgentIngressRow;
    await expect(releaseHostIngressOnDelete({ agentId: AGENT, hostname: HOSTNAME }, {
      read: async () => row, runDetach: async () => { throw new Error("ssh"); }, remove, env: SECRET_ENV,
    })).resolves.toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
  });
});
