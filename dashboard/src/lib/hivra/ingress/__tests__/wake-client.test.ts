/** @jest-environment node */

import { spawnSync } from "node:child_process";
import path from "node:path";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: jest.fn() }));

import {
  agentIngressStateFrom,
  hostIngressConfigured,
  loadAgentIngressState,
  mintIngressTicket,
  parseIngressWakeReceipt,
  wakeViaIngress,
} from "../wake-client";
import {
  buildIngressSweepHostScript,
  parseIngressMarkers,
  parseIngressStatsJson,
  parseIngressStatsLine,
  proxyWakeAfter,
} from "../proxy-stats";
import { deriveIngressTicketKey } from "../route-file";
import type { AgentIngressRow } from "../store";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TUNNEL_ID = "22222222-2222-4222-8222-222222222222";
// Neutral names: these are test values, not credentials.
const SHARED_VALUE = "x".repeat(40);
const KEY_HEX = "ab".repeat(32);
const HOSTNAME = "agent-one.example.test";
const VMID = 1234;

const ingressRow = (over: Partial<AgentIngressRow> = {}): AgentIngressRow => ({
  agent_id: AGENT_ID, vmid: VMID, host_id: "host_a", mode: "host", phase: "cutover", metrics_port: 21000,
  generation: 3, last_error: null, lease_id: null, lease_expires_at: null, updated_at: null, ...over,
});

describe("hostIngressConfigured", () => {
  it("is off with nothing set, and on once the switch (off included) or the shared value is set", () => {
    expect(hostIngressConfigured({})).toBe(false);
    expect(hostIngressConfigured({ HIVRA_HOST_INGRESS: "" })).toBe(false);
    expect(hostIngressConfigured({ HIVRA_HOST_INGRESS: "off" })).toBe(true);
    expect(hostIngressConfigured({ HIVRA_INGRESS_SECRET: SHARED_VALUE })).toBe(true);
    expect(hostIngressConfigured({ HIVRA_INGRESS_SECRET: "short" })).toBe(false);
  });
});

describe("agentIngressStateFrom", () => {
  const on = { HIVRA_HOST_INGRESS: "canary" };
  const hostOn = { ingress_mode: "canary" };
  const input = { vmid: VMID, hostId: "host_a", env: on };

  it("acts on a cut-over host agent with every switch on", () => {
    expect(agentIngressStateFrom(ingressRow(), hostOn, input)).toMatchObject({ hostIngress: true, acts: true, needsAwake: false });
  });

  it("keeps a host agent awake when a switch is off, the row is not cut over, or names another computer", () => {
    for (const [row, host, env] of [
      [ingressRow(), hostOn, { HIVRA_HOST_INGRESS: "off" }],
      [ingressRow(), { ingress_mode: "off" }, on],
      [ingressRow({ phase: "failed" }), hostOn, on],
      [ingressRow({ vmid: 4321 }), hostOn, on],
      [ingressRow({ host_id: "host_b" }), hostOn, on],
      [ingressRow({ mode: "bogus" }), hostOn, on],
    ] as const) {
      expect(agentIngressStateFrom(row, host, { ...input, env })).toMatchObject({ hostIngress: true, acts: false, needsAwake: true });
    }
  });

  it("leaves a guest agent alone, and never acts while an enable or rollback holds the row", () => {
    expect(agentIngressStateFrom(ingressRow({ mode: "guest" }), hostOn, input))
      .toMatchObject({ hostIngress: false, acts: false, needsAwake: false });
    const held = ingressRow({ lease_id: "lease", lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(agentIngressStateFrom(held, hostOn, input)).toMatchObject({ acts: false, leaseHeld: true, needsAwake: false });
  });

  it("keeps a guest-mode agent awake when an enable or rollback left its cutover half done", () => {
    for (const over of [
      { phase: "forwarder" },
      { phase: "host_connector" },
      { phase: "failed", last_error: "recovery_failed" },
      { phase: "failed", last_error: "detach_failed" },
      { phase: "failed", last_error: "guest_token_stale" },
    ]) {
      // With every switch off too: this is the way back, not ingress acting.
      for (const env of [on, {}]) {
        expect(agentIngressStateFrom(ingressRow({ mode: "guest", ...over }), null, { ...input, env }))
          .toMatchObject({ hostIngress: false, acts: false, needsAwake: true, interrupted: true });
      }
      // Still running (lease held): the run itself owns it.
      const running = ingressRow({ mode: "guest", ...over, lease_id: "lease", lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
      expect(agentIngressStateFrom(running, hostOn, input)).toMatchObject({ needsAwake: false, interrupted: false, leaseHeld: true });
    }
    for (const over of [{ phase: "failed", last_error: "forwarder_failed" }, { phase: "rolled_back" }, { phase: "none" }]) {
      expect(agentIngressStateFrom(ingressRow({ mode: "guest", ...over }), hostOn, input))
        .toMatchObject({ needsAwake: false, interrupted: false });
    }
  });
});

describe("loadAgentIngressState", () => {
  it("never reads when ingress was never configured", async () => {
    const readRow = jest.fn();
    await expect(loadAgentIngressState(AGENT_ID, { vmid: VMID, hostId: "host_a", env: {} }, { readRow }))
      .resolves.toEqual({ kind: "none" });
    expect(readRow).not.toHaveBeenCalled();
  });

  it("reports none for no row, error for a failed read", async () => {
    const env = { HIVRA_HOST_INGRESS: "off" };
    await expect(loadAgentIngressState(AGENT_ID, { vmid: VMID, hostId: "host_a", env }, { readRow: async () => null }))
      .resolves.toEqual({ kind: "none" });
    await expect(loadAgentIngressState(AGENT_ID, { vmid: VMID, hostId: "host_a", env }, {
      readRow: async () => { throw new Error("x"); },
    })).resolves.toEqual({ kind: "error" });
    const loaded = await loadAgentIngressState(AGENT_ID, { vmid: VMID, hostId: "host_a", env }, {
      readRow: async () => ingressRow(), readHost: async () => ({ ingress_mode: "on" }),
    });
    expect(loaded).toMatchObject({ kind: "row", state: { needsAwake: true, acts: false } });
  });
});

describe("tickets", () => {
  it("minting matches what the proxy checks", () => {
    const python = spawnSync("python3", ["--version"], { stdio: "ignore" });
    if (python.status !== 0) return;
    const nowS = Math.floor(Date.now() / 1000);
    const ticket = mintIngressTicket({ key: KEY_HEX, vmid: VMID, expS: nowS + 60 });
    expect(ticket).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{16,64}\.[0-9a-f]{64}$/);
    const proxyDir = path.resolve(__dirname, "../../../../../provisioner");
    const check = (t: string, vmid: number) => spawnSync("python3", ["-I", "-c", [
      "import importlib.util, sys, time",
      `spec = importlib.util.spec_from_file_location("p", ${JSON.stringify(path.join(proxyDir, "hivra-wake-proxy.py"))})`,
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "print(m.check_ticket(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(time.time()))[1])",
    ].join("\n"), t, KEY_HEX, String(vmid)], { encoding: "utf8" }).stdout.trim();
    expect(check(ticket, VMID)).toBe("ok");
    expect(check(ticket, VMID + 1)).toBe("bad_mac");
    expect(check(mintIngressTicket({ key: KEY_HEX, vmid: VMID, expS: nowS - 5 }), VMID)).toBe("expired");
  });

  it("refuses bad inputs", () => {
    expect(() => mintIngressTicket({ key: "zz", vmid: VMID, expS: 10 })).toThrow();
    expect(() => mintIngressTicket({ key: KEY_HEX, vmid: VMID, expS: 10, nonce: "short" })).toThrow();
  });
});

describe("parseIngressWakeReceipt", () => {
  it("takes only a receipt for this VM that says it runs", () => {
    expect(parseIngressWakeReceipt({ vmid: VMID, woke: "nap", ms: 12, cont_ms: 3, guest_ms: 8 }, VMID))
      .toEqual({ vmid: VMID, woke: "nap", ms: 12, contMs: 3, guestMs: 8 });
    expect(parseIngressWakeReceipt({ vmid: VMID + 1, woke: "nap", ms: 1 }, VMID)).toBeNull();
    expect(parseIngressWakeReceipt({ vmid: VMID, woke: null, ms: 1 }, VMID)).toBeNull();
    expect(parseIngressWakeReceipt({ vmid: VMID, woke: "nap", ms: 1, error: "guest_unhealthy" }, VMID)).toBeNull();
    expect(parseIngressWakeReceipt("nope", VMID)).toBeNull();
  });
});

describe("wakeViaIngress", () => {
  const env = { HIVRA_INGRESS_SECRET: SHARED_VALUE };
  const base = { agentId: AGENT_ID, vmid: VMID, hostname: HOSTNAME, tunnelId: TUNNEL_ID, generation: 3, env };
  const response = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("posts a ticket for this agent's key to the proxy and reads the receipt", async () => {
    const fetchImpl = jest.fn(async () => response(200, { vmid: VMID, woke: "nap", ms: 14, cont_ms: 3, guest_ms: 9 }));
    const result = await wakeViaIngress(base, { fetchImpl });
    expect(result).toMatchObject({ ok: true, receipt: { woke: "nap" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${HOSTNAME}/__hivra/wake`);
    expect(init.method).toBe("POST");
    const ticket = (init.headers as Record<string, string>)["X-Hivra-Wake"];
    const key = deriveIngressTicketKey({ secret: SHARED_VALUE, agentId: AGENT_ID, tunnelId: TUNNEL_ID, generation: 3 });
    const [, exp, nonce] = ticket.split(".");
    expect(ticket).toBe(mintIngressTicket({ key, vmid: VMID, expS: Number(exp), nonce }));
  });

  it("falls back on anything but a good receipt", async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => response(403, { error: "forbidden" }), "refused"],
      [async () => response(503, { error: "not_napped" }), "status"],
      [async () => response(504, { vmid: VMID, woke: "nap", error: "guest_unhealthy" }), "status"],
      [async () => response(200, "not json"), "bad_receipt"],
      [async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, "timeout"],
      [async () => { throw new Error("refused"); }, "unreachable"],
    ];
    for (const [fetchImpl, reason] of cases) {
      await expect(wakeViaIngress(base, { fetchImpl })).resolves.toMatchObject({ ok: false, reason });
    }
    const fetchImpl = jest.fn();
    await expect(wakeViaIngress({ ...base, env: {} }, { fetchImpl })).resolves.toMatchObject({ ok: false, reason: "no_secret" });
    await expect(wakeViaIngress({ ...base, hostname: "x" }, { fetchImpl })).resolves.toMatchObject({ ok: false, reason: "no_hostname" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("proxy stats", () => {
  const stats = {
    ok: true, forwarder: true,
    vms: { "1234": { route: true, inflight: 1, streams: 0, draining: false, last_any_at: 1_700_000_000.5, last_authed_at: null,
      wakes: [{ at: 1_700_000_100.25, from: "ticket", woke: "nap", ms: 12 }, { at: 1_700_000_050, from: "ctl", woke: "already", ms: 2 }] } },
  };

  it("reads a stats answer strictly", () => {
    const parsed = parseIngressStatsJson(JSON.stringify(stats));
    expect(parsed?.vms.get(1234)).toMatchObject({ inflight: 1, lastAnyAtMs: 1_700_000_000_500, lastAuthedAtMs: null });
    expect(parseIngressStatsJson(JSON.stringify({ ...stats, ok: false }))).toBeNull();
    expect(parseIngressStatsJson(JSON.stringify({ ok: true, vms: { "1234": { inflight: -1 } } }))).toBeNull();
    expect(parseIngressStatsJson(JSON.stringify({ ok: true, vms: { abc: {} } }))).toBeNull();
    expect(parseIngressStatsLine(`x\nHIVRA_INGRESS_STATS ${JSON.stringify(stats)}\n`)).not.toBeNull();
    expect(parseIngressStatsLine(`HIVRA_INGRESS_STATS ${JSON.stringify(stats)}\nHIVRA_INGRESS_STATS {}\n`)).toBeNull();
  });

  it("finds a wake strictly after the nap", () => {
    const vm = parseIngressStatsJson(JSON.stringify(stats))!.vms.get(1234)!;
    expect(proxyWakeAfter(vm, 1_700_000_000_000)).toMatchObject({ woke: "nap", atMs: 1_700_000_100_250 });
    expect(proxyWakeAfter(vm, 1_700_000_100_250)).toBeNull();
    expect(proxyWakeAfter(null, 0)).toBeNull();
  });

  it("reads markers and drops a VM listed twice", () => {
    const markers = parseIngressMarkers("HIVRA_INGRESS_MARKER 1234 0\nHIVRA_INGRESS_MARKER 1235 1\nHIVRA_INGRESS_MARKER 1236 0\nHIVRA_INGRESS_MARKER 1236 1\nHIVRA_INGRESS_MARKER x 1\n");
    expect([...markers.entries()]).toEqual([[1234, false], [1235, true]]);
  });

  it("builds a read-only per-host script", () => {
    const script = buildIngressSweepHostScript([1234, 1235, 1234]);
    expect(script).toContain("for VMID in 1234 1235; do");
    expect(script).toContain("ctl stats 2>/dev/null");
    expect(script).not.toMatch(/ctl (drain|undrain|napped|wake)\b|\brm |qm |systemctl /);
    expect(() => buildIngressSweepHostScript([])).toThrow();
    expect(() => buildIngressSweepHostScript([5])).toThrow();
  });
});
