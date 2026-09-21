import {
  __resetProxmoxHostPreflightCacheForTests,
  buildProxmoxHostPreflightScript,
  guardProxmoxHostPlacementReadiness,
  reportCorrelatedProxmoxHostFailure,
  reportProxmoxHostRegistryUnavailable,
  reportProxmoxVmidRangeUtilization,
  runProxmoxHostPreflight,
} from "../proxmox-host-guards";
import { buildOpsEventFingerprint, reportOpsEvent } from "@/lib/ops-events";
import type { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  getProxmoxVmidAvailability: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

// Keep the real fingerprint implementation — the correlated-failure dedup test
// asserts on it directly — but spy on the writer.
jest.mock("@/lib/ops-events", () => {
  const actual = jest.requireActual("@/lib/ops-events");
  return {
    ...actual,
    reportOpsEvent: jest.fn().mockResolvedValue({ id: "evt_1", fingerprint: "fp" }),
  };
});

const reportOpsEventMock = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;

const DONE = "HERMES_HOST_PREFLIGHT_DONE";
const FAIL = "HERMES_HOST_PREFLIGHT_FAIL";

function hostScript(stdout: string, overrides: Partial<{ ok: boolean; stderr: string; error: string }> = {}) {
  return jest.fn().mockResolvedValue({
    ok: overrides.ok ?? true,
    stdout,
    stderr: overrides.stderr ?? "",
    ...(overrides.error ? { error: overrides.error } : {}),
  });
}

const freeVmids = {
  ok: true as const,
  targetId: "fixturenode9",
  vmidStart: 300,
  vmidEnd: 349,
  occupiedVmids: [300],
  freeVmids: [301, 302],
};

beforeEach(() => {
  __resetProxmoxHostPreflightCacheForTests();
  delete process.env.HERMES_PROXMOX_HOST_PREFLIGHT_ENABLED;
  delete process.env.HERMES_PROXMOX_VMID_UTILIZATION_WARN_RATIO;
});

describe("buildProxmoxHostPreflightScript", () => {
  it("probes exactly the gates the Phase-1 provisioner enforces", () => {
    const script = buildProxmoxHostPreflightScript();
    expect(script).toContain("/etc/caddy/wildcards/hermesos.cloud.crt");
    expect(script).toContain("/etc/caddy/wildcards/hermesos.cloud.key");
    expect(script).toContain("ip link show vmbr1");
    expect(script).toContain("caddy validate --config");
    expect(script).toContain(DONE);
    // Must never `set -e`: every check runs, and exit 0 is what separates
    // "host unhealthy" from "could not reach host". (Matched as a directive
    // line, so the explanatory comment in the script doesn't count.)
    const directives = script.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(directives.some((line) => /^\s*set\s+-\w*e/.test(line))).toBe(false);
  });

  it("only validates a Caddyfile that already exists (virgin hosts have none)", () => {
    expect(buildProxmoxHostPreflightScript()).toContain('elif [ -f "$CADDYFILE" ]');
  });

  it("validates with the running Caddy service environment when one exists", () => {
    const script = buildProxmoxHostPreflightScript();

    expect(script).toContain('systemctl show caddy --property=MainPID --value');
    expect(script).toContain(
      'nsenter --target "$CADDY_PID" --mount --env caddy validate --config "$CADDYFILE"'
    );
  });

  it("rejects expiring, mismatched, or non-Origin-CA certificate seeds", () => {
    const script = buildProxmoxHostPreflightScript();

    expect(script).not.toContain('find /var/lib/caddy/.local/share/caddy/certificates -name "*wildcard*.crt"');
    expect(script).toContain("host_cert_seed_expiring");
    expect(script).toContain("host_cert_seed_mismatch");
    expect(script).toContain("CloudFlare Origin SSL");
    expect(script).toContain('openssl x509 -in "$CERT" -noout -checkhost hermesos.cloud');
    expect(script).toContain('openssl x509 -in "$CERT" -noout -checkhost preflight.hermesos.cloud');
  });

  it("detects stale exact certificate paths and an unresponsive Caddy daemon", () => {
    const script = buildProxmoxHostPreflightScript();

    expect(script).toContain("host_caddy_cert_drift");
    expect(script).toContain("/var/lib/caddy/.local/share/caddy/certificates");
    expect(script).toContain("systemctl is-active --quiet caddy");
    expect(script).toContain("host_caddy_unresponsive");
    expect(script).toContain("--resolve");
    expect(script).toContain('grep -Il "/var/lib/caddy/.local/share/caddy/certificates" "$CADDYFILE"');
  });
});

describe("runProxmoxHostPreflight", () => {
  it("rejects an unseeded host (missing Cloudflare Origin CA cert/key)", async () => {
    const result = await runProxmoxHostPreflight({
      targetId: "fixturenode21",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript(
        `${FAIL} host_cert_seed_missing missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards\n${DONE}\n`
      ),
      getVmidAvailability: jest.fn().mockResolvedValue(freeVmids),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.conclusive).toBe(true);
    expect(result.failures.map((f) => f.failureClass)).toEqual(["host_cert_seed_missing"]);
    expect(result.detail).toContain("host_cert_seed_missing");
  });

  it("passes a fully seeded host", async () => {
    const result = await runProxmoxHostPreflight({
      targetId: "fixturenode9",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript(`${DONE}\n`),
      getVmidAvailability: jest.fn().mockResolvedValue(freeVmids),
    });
    expect(result).toEqual({ ok: true, targetId: "fixturenode9" });
  });

  it("collects every conclusive failure in one probe", async () => {
    const result = await runProxmoxHostPreflight({
      targetId: "fixturenode21",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript(
        `${FAIL} host_cert_seed_expiring expiring cert\n${FAIL} host_bridge_missing missing private bridge vmbr1\n${FAIL} host_caddy_cert_drift mutable cert path\n${FAIL} host_caddy_unresponsive local TLS timeout\n${DONE}\n`
      ),
      getVmidAvailability: jest.fn().mockResolvedValue(freeVmids),
    });
    if (result.ok) throw new Error("unreachable");
    expect(result.failures.map((f) => f.failureClass)).toEqual([
      "host_cert_seed_expiring",
      "host_bridge_missing",
      "host_caddy_cert_drift",
      "host_caddy_unresponsive",
    ]);
  });

  it("flags a host whose VMID range has no free capacity", async () => {
    const result = await runProxmoxHostPreflight({
      targetId: "fixturenode9",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript(`${DONE}\n`),
      getVmidAvailability: jest.fn().mockResolvedValue({ ...freeVmids, freeVmids: [] }),
    });
    if (result.ok) throw new Error("unreachable");
    expect(result.conclusive).toBe(true);
    expect(result.failures.map((f) => f.failureClass)).toEqual(["host_vmid_range_exhausted"]);
  });

  it("is inconclusive (never conclusive) when the probe never completes", async () => {
    const result = await runProxmoxHostPreflight({
      targetId: "fixturenode9",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript("", { ok: false, error: "ssh connection failed" }),
      getVmidAvailability: jest.fn().mockResolvedValue(freeVmids),
    });
    if (result.ok) throw new Error("unreachable");
    expect(result.conclusive).toBe(false);
    expect(result.detail).toContain("ssh connection failed");
  });

  it("never throws out of the guard when the host runner misbehaves", async () => {
    for (const runHostScript of [
      jest.fn().mockResolvedValue(undefined),
      jest.fn().mockRejectedValue(new Error("ssh connect threw")),
    ]) {
      const result = await runProxmoxHostPreflight({
        targetId: "fixturenode9",
        env: {} as NodeJS.ProcessEnv,
        runHostScript: runHostScript as never,
        getVmidAvailability: jest.fn().mockResolvedValue(freeVmids),
      });
      if (result.ok) throw new Error("unreachable");
      expect(result.conclusive).toBe(false);
    }
  });

  it("reuses a supplied vmid availability instead of paying for a second probe", async () => {
    const getVmidAvailability = jest.fn();
    await runProxmoxHostPreflight({
      targetId: "fixturenode9",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript(`${DONE}\n`),
      vmidAvailability: freeVmids,
      getVmidAvailability,
    });
    expect(getVmidAvailability).not.toHaveBeenCalled();
  });
});

describe("guardProxmoxHostPlacementReadiness", () => {
  it("skips a conclusively misconfigured host and reports an ops_event", async () => {
    const verdict = await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode21",
      env: {} as NodeJS.ProcessEnv,
      userId: "user_1",
      runHostScript: hostScript(`${FAIL} host_cert_seed_missing missing cert\n${DONE}\n`),
    });

    expect(verdict.skip).toBe(true);
    if (!verdict.skip) throw new Error("unreachable");
    expect(verdict.status).toBe(503);
    expect(verdict.error).toEqual(
      expect.objectContaining({
        code: "PROXMOX_HOST_PREFLIGHT_FAILED",
        targetId: "fixturenode21",
        failureClasses: ["host_cert_seed_missing"],
      })
    );
    expect(reportOpsEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "error",
        title: expect.stringContaining("failed registration preflight on fixturenode21"),
        metadata: expect.objectContaining({
          failureType: "proxmox_host_preflight_failed",
          targetId: "fixturenode21",
        }),
      })
    );
  });

  it("fails CLOSED on an inconclusive probe so an unverified host cannot receive a tenant", async () => {
    const verdict = await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode9",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript("", { ok: false, error: "proxmox ssh operation timed out" }),
    });

    expect(verdict).toEqual(
      expect.objectContaining({
        skip: true,
        status: 503,
        error: expect.objectContaining({ code: "PROXMOX_HOST_READINESS_UNVERIFIED" }),
      }),
    );
    expect(reportOpsEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        metadata: expect.objectContaining({ failureType: "proxmox_host_preflight_inconclusive" }),
      })
    );
  });

  it("fails CLOSED on an inconclusive probe when the caller has no registry vouch", async () => {
    // Legacy env-order candidates. HERMES_PROXMOX_TARGETS still names 12
    // decommissioned hosts whose IPs Hetzner recycled to other customers; for
    // those, "ssh did not answer" is the answer, not ambiguity.
    const verdict = await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode3",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript("", { ok: false, error: "ssh connection failed" }),
      requireConclusivePass: true,
    });

    expect(verdict).toEqual(
      expect.objectContaining({
        skip: true,
        status: 503,
        error: expect.objectContaining({
          code: "PROXMOX_HOST_READINESS_UNVERIFIED",
          targetId: "fixturenode3",
        }),
      })
    );
  });

  it("still lets a HEALTHY host through when a conclusive pass is required", async () => {
    // requireConclusivePass gates only on a verdict being REACHED; it must
    // never turn a passing probe into a rejection.
    const verdict = await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode3",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript(DONE),
      requireConclusivePass: true,
    });

    expect(verdict).toEqual({ skip: false });
  });

  it("honors the preflight kill switch even when a conclusive pass is required", async () => {
    const verdict = await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode3",
      env: { HERMES_PROXMOX_HOST_PREFLIGHT_ENABLED: "false" } as unknown as NodeJS.ProcessEnv,
      runHostScript: hostScript("", { ok: false, error: "ssh connection failed" }),
      requireConclusivePass: true,
    });

    expect(verdict).toEqual({ skip: false });
  });

  it("lets a healthy host through", async () => {
    const verdict = await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode9",
      env: {} as NodeJS.ProcessEnv,
      runHostScript: hostScript(`${DONE}\n`),
    });
    expect(verdict).toEqual({ skip: false });
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });

  it("caches a passing probe per host instead of re-running it per candidate", async () => {
    const runHostScript = hostScript(`${DONE}\n`);
    await guardProxmoxHostPlacementReadiness({ targetId: "fixturenode9", env: {} as NodeJS.ProcessEnv, runHostScript });
    await guardProxmoxHostPlacementReadiness({ targetId: "fixturenode9", env: {} as NodeJS.ProcessEnv, runHostScript });
    expect(runHostScript).toHaveBeenCalledTimes(1);
  });

  it("re-probes a different host and re-probes once the cache entry expires", async () => {
    const runHostScript = hostScript(`${DONE}\n`);
    await guardProxmoxHostPlacementReadiness({ targetId: "fixturenode9", env: {} as NodeJS.ProcessEnv, runHostScript, now: 0 });
    await guardProxmoxHostPlacementReadiness({ targetId: "fixturenode10", env: {} as NodeJS.ProcessEnv, runHostScript, now: 0 });
    expect(runHostScript).toHaveBeenCalledTimes(2);

    // Past the short pass TTL: Caddy liveness must not be trusted for minutes.
    await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode9",
      env: {} as NodeJS.ProcessEnv,
      runHostScript,
      now: 30 * 1000 + 1,
    });
    expect(runHostScript).toHaveBeenCalledTimes(3);
  });

  it("never caches an inconclusive probe", async () => {
    const runHostScript = hostScript("", { ok: false, error: "ssh exec failed" });
    await guardProxmoxHostPlacementReadiness({ targetId: "fixturenode9", env: {} as NodeJS.ProcessEnv, runHostScript, now: 0 });
    await guardProxmoxHostPlacementReadiness({ targetId: "fixturenode9", env: {} as NodeJS.ProcessEnv, runHostScript, now: 0 });
    expect(runHostScript).toHaveBeenCalledTimes(2);
  });

  it("honours the kill switch", async () => {
    const runHostScript = hostScript(`${FAIL} host_cert_seed_missing missing cert\n${DONE}\n`);
    const verdict = await guardProxmoxHostPlacementReadiness({
      targetId: "fixturenode21",
      env: { HERMES_PROXMOX_HOST_PREFLIGHT_ENABLED: "false" } as unknown as NodeJS.ProcessEnv,
      runHostScript,
    });
    expect(verdict).toEqual({ skip: false });
    expect(runHostScript).not.toHaveBeenCalled();
  });
});

describe("reportProxmoxVmidRangeUtilization", () => {
  const range = { targetId: "fixturenode9", vmidStart: 1300, vmidEnd: 1349 }; // 50 slots

  it("warns above 80% consumed", async () => {
    const verdict = await reportProxmoxVmidRangeUtilization({
      ...range,
      occupiedCount: 41, // 82%
      freeCount: 9,
    });

    expect(verdict).toBe("warn");
    expect(reportOpsEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        title: expect.stringContaining("over 80% consumed on fixturenode9"),
        metadata: expect.objectContaining({
          failureType: "proxmox_vmid_range_utilization_high",
          occupiedCount: 41,
          total: 50,
        }),
      })
    );
  });

  it("stays quiet at or below the warn ratio", async () => {
    const verdict = await reportProxmoxVmidRangeUtilization({ ...range, occupiedCount: 40, freeCount: 10 });
    expect(verdict).toBe("ok");
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });

  it("escalates to FATAL on exhaustion (the 2026-06-08 shape)", async () => {
    const verdict = await reportProxmoxVmidRangeUtilization({ ...range, occupiedCount: 50, freeCount: 0 });

    expect(verdict).toBe("exhausted");
    expect(reportOpsEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "fatal",
        title: "Proxmox VMID range exhausted on fixturenode9",
        metadata: expect.objectContaining({
          failureType: "proxmox_vmid_range_exhausted",
          vmidStart: 1300,
          vmidEnd: 1349,
        }),
      })
    );
  });

  it("keeps a stable fingerprint as the occupied count climbs", async () => {
    await reportProxmoxVmidRangeUtilization({ ...range, occupiedCount: 41, freeCount: 9 });
    await reportProxmoxVmidRangeUtilization({ ...range, occupiedCount: 45, freeCount: 5 });

    const [first, second] = reportOpsEventMock.mock.calls.map(([payload]) => buildOpsEventFingerprint(payload));
    expect(first).toBe(second);
  });

  it("respects a configured warn ratio", async () => {
    process.env.HERMES_PROXMOX_VMID_UTILIZATION_WARN_RATIO = "0.5";
    const verdict = await reportProxmoxVmidRangeUtilization({
      ...range,
      occupiedCount: 30, // 60%
      freeCount: 20,
      env: process.env,
    });
    expect(verdict).toBe("warn");
  });
});

describe("reportCorrelatedProxmoxHostFailure", () => {
  const NOW = Date.parse("2026-06-25T20:00:00.000Z");

  type Row = { source: string; metadata: Record<string, unknown>; last_seen_at: string };

  /**
   * A fake PostgREST builder that ACTUALLY applies the eq/gte filters, so these
   * tests verify the correlation query's semantics (class match + 1h window),
   * not just that some query was issued.
   */
  function fakeSupabase(rows: Row[]) {
    const filters: Array<{ op: "eq" | "gte"; col: string; val: string }> = [];
    const matches = (row: Row) =>
      filters.every(({ op, col, val }) => {
        const actual =
          col === "source"
            ? row.source
            : col === "last_seen_at"
              ? row.last_seen_at
              : col.startsWith("metadata->>")
                ? (row.metadata[col.slice("metadata->>".length)] as string | undefined)
                : undefined;
        if (actual === undefined) return false;
        return op === "eq" ? actual === val : actual >= val;
      });

    const builder: Record<string, unknown> = {};
    builder.select = jest.fn(() => builder);
    builder.eq = jest.fn((col: string, val: string) => {
      filters.push({ op: "eq", col, val });
      return builder;
    });
    builder.gte = jest.fn((col: string, val: string) => {
      filters.push({ op: "gte", col, val });
      return builder;
    });
    builder.limit = jest.fn(() => Promise.resolve({ data: rows.filter(matches), error: null }));

    return {
      from: jest.fn((table: string) => {
        if (table !== "ops_events") throw new Error(`unexpected table ${table}`);
        return builder;
      }),
    } as unknown as typeof supabaseAdmin;
  }

  const row = (targetId: string, failureClass: string, minutesAgo: number): Row => ({
    source: "instance-service",
    metadata: { failureClass, targetId },
    last_seen_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  });

  it("escalates to FATAL when a second distinct host reports the same class within 1h", async () => {
    const result = await reportCorrelatedProxmoxHostFailure({
      supabase: fakeSupabase([row("fixturenode14", "host_caddy_invalid", 20)]),
      failureClass: "host_caddy_invalid",
      targetId: "fixturenode12",
      now: NOW,
    });

    expect(result).toEqual({ correlated: true, hosts: ["fixturenode12", "fixturenode14"] });
    expect(reportOpsEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "fatal",
        title: "Correlated Proxmox host failure: host_caddy_invalid",
        metadata: expect.objectContaining({
          failureType: "proxmox_correlated_host_failure",
          hosts: ["fixturenode12", "fixturenode14"],
          hostCount: 2,
        }),
      })
    );
  });

  it("does not alert on a single host failing alone", async () => {
    const result = await reportCorrelatedProxmoxHostFailure({
      supabase: fakeSupabase([row("fixturenode12", "host_caddy_invalid", 5)]),
      failureClass: "host_caddy_invalid",
      targetId: "fixturenode12",
      now: NOW,
    });

    expect(result).toEqual({ correlated: false, hosts: ["fixturenode12"] });
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });

  it("does not correlate two hosts failing with DIFFERENT classes", async () => {
    const result = await reportCorrelatedProxmoxHostFailure({
      supabase: fakeSupabase([row("fixturenode14", "host_template_clone_failed", 10)]),
      failureClass: "host_caddy_invalid",
      targetId: "fixturenode12",
      now: NOW,
    });

    expect(result).toEqual({ correlated: false, hosts: ["fixturenode12"] });
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });

  it("does not correlate two hosts failing MORE than 1h apart", async () => {
    const result = await reportCorrelatedProxmoxHostFailure({
      supabase: fakeSupabase([row("fixturenode14", "host_caddy_invalid", 61)]),
      failureClass: "host_caddy_invalid",
      targetId: "fixturenode12",
      now: NOW,
    });

    expect(result).toEqual({ correlated: false, hosts: ["fixturenode12"] });
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });

  it("pages once per fingerprint as the incident widens across hosts", async () => {
    // 2026-06-25: fixturenodea, fixturenodea, fixturenodea and fixturenodea all went host_caddy_invalid.
    const seen = [row("fixturenode14", "host_caddy_invalid", 20)];
    await reportCorrelatedProxmoxHostFailure({
      supabase: fakeSupabase(seen),
      failureClass: "host_caddy_invalid",
      targetId: "fixturenode12",
      now: NOW,
    });

    seen.push(row("fixturenode12", "host_caddy_invalid", 1), row("fixturenode15", "host_caddy_invalid", 1));
    await reportCorrelatedProxmoxHostFailure({
      supabase: fakeSupabase(seen),
      failureClass: "host_caddy_invalid",
      targetId: "fixturenode18",
      now: NOW,
    });

    const payloads = reportOpsEventMock.mock.calls.map(([payload]) => payload);
    expect(payloads).toHaveLength(2);
    expect(payloads.every((p) => p.severity === "fatal")).toBe(true);

    // Host list grew (fixturenodea joined) but the fingerprint is unchanged, so
    // reportOpsEvent takes its UPDATE branch and pages exactly once.
    expect(payloads[1].metadata?.hosts).toEqual(["fixturenode12", "fixturenode14", "fixturenode15", "fixturenode18"]);
    expect(buildOpsEventFingerprint(payloads[0])).toBe(buildOpsEventFingerprint(payloads[1]));
  });

  it("never throws when the ops_events lookup fails", async () => {
    const broken = {
      from: jest.fn(() => {
        throw new Error("connection reset");
      }),
    } as unknown as typeof supabaseAdmin;

    const result = await reportCorrelatedProxmoxHostFailure({
      supabase: broken,
      failureClass: "host_caddy_invalid",
      targetId: "fixturenode12",
      now: NOW,
    });
    expect(result).toEqual({ correlated: false, hosts: ["fixturenode12"] });
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });
});

describe("reportProxmoxHostRegistryUnavailable", () => {
  it("pages FATAL: an unreadable registry means no host is known to be vetted", async () => {
    await reportProxmoxHostRegistryUnavailable({
      detail: "column proxmox_hosts.thinpool_size_gb does not exist",
      attempts: 2,
    });

    expect(reportOpsEventMock).toHaveBeenCalledTimes(1);
    expect(reportOpsEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "fatal",
        metadata: expect.objectContaining({
          failureType: "proxmox_hosts_registry_unavailable",
          detail: "column proxmox_hosts.thinpool_size_gb does not exist",
          attempts: 2,
          recoveryAction: "restore_proxmox_hosts_registry_query",
        }),
      })
    );
  });

  it("folds every sighting of an incident into ONE fingerprint, so it pages exactly once", async () => {
    // Asserted against the REAL buildOpsEventFingerprint. Title/message are
    // constants; the volatile bits (driver error text, attempt count) ride in
    // metadata, which the fingerprint ignores. The driver's error text is the
    // one that actually varied in prod — a schema skew and a statement timeout
    // must collapse onto the same ops_events row (occurrence_count++) rather
    // than paging per failing signup.
    await reportProxmoxHostRegistryUnavailable({
      detail: "column proxmox_hosts.thinpool_size_gb does not exist",
      attempts: 2,
    });
    await reportProxmoxHostRegistryUnavailable({
      detail: "statement timeout",
      attempts: 1,
    });

    expect(reportOpsEventMock).toHaveBeenCalledTimes(2);
    const [first] = reportOpsEventMock.mock.calls[0];
    const [second] = reportOpsEventMock.mock.calls[1];

    expect(buildOpsEventFingerprint(first)).toBe(buildOpsEventFingerprint(second));

    // The 2026-05 incident produced TWO rows across 71 occurrences precisely
    // because the log.error mirror hashes the driver's error text and the user
    // id. Neither may appear in anything the fingerprint reads.
    for (const input of [first, second]) {
      expect(input.userId).toBeUndefined();
      expect(input.instanceId).toBeUndefined();
      expect(input.title).not.toContain("thinpool");
      expect(input.message).not.toContain("thinpool");
      expect(input.title).not.toContain("timeout");
      expect(input.message).not.toContain("timeout");
    }
  });
});
