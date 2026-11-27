/** @jest-environment node */

/**
 * Wake-admission guard (gateway auto-wake Phase 1).
 *
 * Contract under test:
 *   - one host round-trip that claims a slot (concurrency cap) + checks RAM;
 *   - deferrals are structured (reason, retryAfterSeconds) so the route can
 *     429-with-retry;
 *   - FAIL-OPEN everywhere: probe errors, garbled output, or missing markers
 *     must ADMIT — the guard may never block a legitimate start.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  resolveProxmoxHostEnv: jest.fn((_hostConfig: unknown, env: Record<string, string | undefined>) => ({
    ...env,
    HERMES_TEST_ENV_SOURCE: "hostConfig",
  })),
  resolveProxmoxOperationEnv: jest.fn((env: Record<string, string | undefined>) => ({
    ...env,
    HERMES_TEST_ENV_SOURCE: "operation",
  })),
}));

import {
  acquireHostWakeSlot,
  buildWakeAdmissionScript,
  checkHostWakeCapacity,
  DEFAULT_MAX_CONCURRENT_WAKES_PER_HOST,
  normalizeWakeRamMb,
  parseWakeAdmissionOutput,
  releaseHostWakeSlot,
  resolveMaxConcurrentWakesPerHost,
  WAKE_DEFER_RETRY_AFTER_SECONDS,
} from "../wake-admission";
import {
  runProxmoxHostScript,
  resolveProxmoxHostEnv,
  resolveProxmoxOperationEnv,
} from "@/lib/services/proxmox-instance-service";

const infra = { vmid: 201, node: "fixturenode3" };

describe("resolveMaxConcurrentWakesPerHost", () => {
  it("defaults when unset or invalid", () => {
    expect(resolveMaxConcurrentWakesPerHost({})).toBe(DEFAULT_MAX_CONCURRENT_WAKES_PER_HOST);
    expect(resolveMaxConcurrentWakesPerHost({ HERMES_WAKE_MAX_CONCURRENT_PER_HOST: "zero" })).toBe(
      DEFAULT_MAX_CONCURRENT_WAKES_PER_HOST,
    );
    expect(resolveMaxConcurrentWakesPerHost({ HERMES_WAKE_MAX_CONCURRENT_PER_HOST: "0" })).toBe(
      DEFAULT_MAX_CONCURRENT_WAKES_PER_HOST,
    );
  });

  it("honours the env override and clamps the ceiling", () => {
    expect(resolveMaxConcurrentWakesPerHost({ HERMES_WAKE_MAX_CONCURRENT_PER_HOST: "5" })).toBe(5);
    expect(resolveMaxConcurrentWakesPerHost({ HERMES_WAKE_MAX_CONCURRENT_PER_HOST: "999" })).toBe(20);
  });
});

describe("normalizeWakeRamMb", () => {
  it("passes MB values through", () => {
    expect(normalizeWakeRamMb(1024)).toBe(1024);
    expect(normalizeWakeRamMb(4096)).toBe(4096);
  });

  it("treats small legacy values as GB", () => {
    expect(normalizeWakeRamMb(4)).toBe(4096);
    expect(normalizeWakeRamMb(1)).toBe(1024);
  });

  it("falls back to the free-tier 1024 MB on junk", () => {
    expect(normalizeWakeRamMb(null)).toBe(1024);
    expect(normalizeWakeRamMb(undefined)).toBe(1024);
    expect(normalizeWakeRamMb(0)).toBe(1024);
    expect(normalizeWakeRamMb("banana")).toBe(1024);
  });
});

describe("buildWakeAdmissionScript", () => {
  it("embeds the need/cap numbers and the sanitized slot key", () => {
    const script = buildWakeAdmissionScript({
      instanceId: "00000000-0000-4000-8000-000000001012",
      neededRamMb: 2048,
      cap: 3,
    });
    expect(script).toContain("NEED_MB=2048");
    expect(script).toContain("CAP=3");
    expect(script).toContain("SLOT_KEY='00000000-0000-4000-8000-000000001012'");
    expect(script).toContain("/run/hermes-wake-slots");
  });

  it("strips shell-hostile characters from the instance id", () => {
    const script = buildWakeAdmissionScript({
      instanceId: "abc'; rm -rf /; echo '",
      neededRamMb: 1024,
      cap: 2,
    });
    expect(script).not.toContain("rm -rf /");
    expect(script).toContain("SLOT_KEY='abcrm-rfecho'");
  });
});

describe("host-side bounded wake admission", () => {
  let root: string;
  let slots: string;
  let bin: string;
  let ram: string;
  let slept: string;
  let active: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wake-admission-"));
    slots = join(root, "slots");
    bin = join(root, "bin");
    ram = join(root, "ram");
    slept = join(root, "slept");
    active = join(slots, "active.slot");
    mkdirSync(slots);
    mkdirSync(bin);
    writeFileSync(ram, "9000");
    writeFileSync(join(bin, "free"), '#!/bin/bash\necho "Mem: 0 0 0 0 0 $(cat "$RAM_FILE")"\n', { mode: 0o755 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function check(wait: number, onWait = "") {
    writeFileSync(join(bin, "sleep"), `#!/bin/bash\ntouch "$SLEPT"\n${onWait}\nexec /bin/sleep "$@"\n`, { mode: 0o755 });
    const script = buildWakeAdmissionScript({ instanceId: "hibernated", neededRamMb: 1024, cap: 1, waitForConcurrencySeconds: wait })
      .replace("/run/hermes-wake-slots", slots);
    const result = spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAM_FILE: ram, SLEPT: slept, ACTIVE_SLOT: active },
      timeout: 6_000,
    });
    expect(result.status).toBe(0);
    return result.stdout;
  }

  it("admits without sleeping when a slot is available", () => {
    expect(parseWakeAdmissionOutput(check(5))).toMatchObject({ verdict: "admit" });
    expect(existsSync(slept)).toBe(false);
  });

  it("waits without holding the mutex, then counts and claims the freed slot", () => {
    writeFileSync(active, "");
    const stdout = check(5, 'test ! -d "${ACTIVE_SLOT%/*}/.lock.d" || exit 42\nrm "$ACTIVE_SLOT"');
    expect(stdout).toContain("DEFER reason=concurrency");
    expect(parseWakeAdmissionOutput(stdout)).toMatchObject({ verdict: "admit", activeWakes: 0 });
    expect(existsSync(join(slots, "hibernated.slot"))).toBe(true);
  });

  it("rechecks hard RAM admission after a slot frees, without claiming", () => {
    writeFileSync(active, "");
    const stdout = check(5, 'rm "$ACTIVE_SLOT"\necho 1535 > "$RAM_FILE"');
    expect(stdout).toContain("DEFER reason=concurrency");
    expect(parseWakeAdmissionOutput(stdout)).toMatchObject({ verdict: "defer", reason: "host_ram", freeMb: 1535 });
    expect(existsSync(join(slots, "hibernated.slot"))).toBe(false);
  });

  it("does not queue a measured RAM refusal, including on a busy host", () => {
    writeFileSync(active, "");
    writeFileSync(ram, "1535");
    expect(parseWakeAdmissionOutput(check(5))).toMatchObject({ verdict: "defer", reason: "host_ram" });
    expect(existsSync(slept)).toBe(false);
    expect(parseWakeAdmissionOutput(check(0))).toMatchObject({ verdict: "defer", reason: "concurrency" });
  });

  it("ends a persistent concurrency deferral without claiming", () => {
    writeFileSync(active, "");
    expect(parseWakeAdmissionOutput(check(3))).toMatchObject({ verdict: "defer", reason: "concurrency" });
    expect(existsSync(slept)).toBe(true);
    expect(existsSync(join(slots, "hibernated.slot"))).toBe(false);
  });

  it("does not claim without the slot mutex, leaving immediate legacy admission unchanged", () => {
    mkdirSync(join(slots, ".lock.d"));
    const skipMutexSleep = '[ "$1" != 0.1 ] || exit 0';
    expect(parseWakeAdmissionOutput(check(5, skipMutexSleep))).toMatchObject({ verdict: "defer", reason: "unavailable" });
    expect(existsSync(join(slots, "hibernated.slot"))).toBe(false);
    expect(parseWakeAdmissionOutput(check(0, skipMutexSleep))).toMatchObject({ verdict: "admit" });
  });

  it.each(["free", "find", "touch"])("fails closed when the %s capacity probe or slot write fails", (command) => {
    writeFileSync(join(bin, command), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
    expect(parseWakeAdmissionOutput(check(5))).toMatchObject({ verdict: "defer", reason: "unavailable" });
    expect(existsSync(join(slots, "hibernated.slot"))).toBe(false);
  });
});

describe("parseWakeAdmissionOutput", () => {
  it("parses ADMIT lines (with surrounding noise)", () => {
    const parsed = parseWakeAdmissionOutput(
      "some banner\nHERMES_WAKE_ADMISSION ADMIT active=1 cap=2 free_mb=9001\ntrailer",
    );
    expect(parsed).toEqual({ verdict: "admit", activeWakes: 1, cap: 2, freeMb: 9001 });
  });

  it("parses concurrency deferrals", () => {
    const parsed = parseWakeAdmissionOutput(
      "HERMES_WAKE_ADMISSION DEFER reason=concurrency active=2 cap=2 free_mb=na",
    );
    expect(parsed).toEqual({
      verdict: "defer",
      reason: "concurrency",
      activeWakes: 2,
      cap: 2,
      freeMb: null,
    });
  });

  it("parses host_ram deferrals", () => {
    const parsed = parseWakeAdmissionOutput(
      "HERMES_WAKE_ADMISSION DEFER reason=host_ram active=0 cap=2 free_mb=700 need_mb=1024",
    );
    expect(parsed).toMatchObject({ verdict: "defer", reason: "host_ram", freeMb: 700 });
  });

  it("keeps the last valid decision when a following receipt is truncated", () => {
    expect(parseWakeAdmissionOutput(
      "HERMES_WAKE_ADMISSION DEFER reason=concurrency active=2 cap=2 free_mb=9000\nHERMES_WAKE_ADMISSION DE",
    )).toMatchObject({ verdict: "defer", reason: "concurrency" });
  });

  it("returns null on garbage / missing marker / unknown reason", () => {
    expect(parseWakeAdmissionOutput("")).toBeNull();
    expect(parseWakeAdmissionOutput("qm start OK")).toBeNull();
    expect(parseWakeAdmissionOutput("HERMES_WAKE_ADMISSION KABOOM")).toBeNull();
    expect(parseWakeAdmissionOutput("HERMES_WAKE_ADMISSION DEFER reason=solar_flare")).toBeNull();
  });
});

describe("acquireHostWakeSlot", () => {
  const baseParams = { instanceId: "inst-123", neededRamMb: 1024 };

  it("admits when the host script reports ADMIT", async () => {
    const runHostScript = jest.fn(async (_script: string) => ({
      ok: true,
      stdout: "HERMES_WAKE_ADMISSION ADMIT active=0 cap=2 free_mb=12000",
      stderr: "",
    }));
    const decision = await acquireHostWakeSlot(infra, { ...baseParams, runHostScript });
    expect(decision).toEqual({ admitted: true, freeMb: 12000, activeWakes: 0 });
    expect(runHostScript).toHaveBeenCalledTimes(1);
    expect(runHostScript.mock.calls[0][0]).toContain("NEED_MB=1024");
  });

  it("defers with a retry hint when the cap is hit", async () => {
    const runHostScript = jest.fn(async () => ({
      ok: true,
      stdout: "HERMES_WAKE_ADMISSION DEFER reason=concurrency active=2 cap=2 free_mb=8000",
      stderr: "",
    }));
    const decision = await acquireHostWakeSlot(infra, { ...baseParams, runHostScript });
    expect(decision).toEqual({
      admitted: false,
      reason: "concurrency",
      freeMb: 8000,
      activeWakes: 2,
      cap: 2,
      retryAfterSeconds: WAKE_DEFER_RETRY_AFTER_SECONDS,
    });
  });

  it("defers on measured RAM shortage", async () => {
    const runHostScript = jest.fn(async () => ({
      ok: true,
      stdout: "HERMES_WAKE_ADMISSION DEFER reason=host_ram active=0 cap=2 free_mb=600 need_mb=1024",
      stderr: "",
    }));
    const decision = await acquireHostWakeSlot(infra, { ...baseParams, runHostScript });
    expect(decision).toMatchObject({ admitted: false, reason: "host_ram", freeMb: 600 });
  });

  it("preserves a reported concurrency deferral if the waiting connection drops", async () => {
    const runHostScript = jest.fn(async () => ({
      ok: false,
      stdout: "HERMES_WAKE_ADMISSION DEFER reason=concurrency active=4 cap=4 free_mb=8000\n",
      stderr: "",
      error: "SSH connection failed",
    }));
    const decision = await acquireHostWakeSlot(infra, { ...baseParams, waitForConcurrencySeconds: 75, runHostScript });
    expect(decision).toMatchObject({ admitted: false, reason: "concurrency" });
  });

  it.each(["", "HERMES_WAKE_ADMISSION ADMIT active=0 cap=4 free_mb=na"])(
    "fails closed on an incomplete admission receipt from a queued host",
    async (stdout) => {
      const runHostScript = async () => ({ ok: false, stdout, stderr: "" });
      const decision = await acquireHostWakeSlot(infra, { ...baseParams, waitForConcurrencySeconds: 75, runHostScript });
      expect(decision).toMatchObject({ admitted: false, reason: "unavailable" });
    },
  );

  it("fails open when the host script throws", async () => {
    const runHostScript = jest.fn(async () => {
      throw new Error("ssh exploded");
    });
    const decision = await acquireHostWakeSlot(infra, { ...baseParams, runHostScript });
    expect(decision).toEqual({ admitted: true, freeMb: null, activeWakes: null });
  });

  it("fails open on unparsable output", async () => {
    const runHostScript = jest.fn(async () => ({ ok: false, stdout: "??", stderr: "boom" }));
    const decision = await acquireHostWakeSlot(infra, { ...baseParams, runHostScript });
    expect(decision).toEqual({ admitted: true, freeMb: null, activeWakes: null });
  });

  it("resolves env via hostConfig when provided, operation env otherwise", async () => {
    const runHostScript = jest.fn(async (_script: string) => ({
      ok: true,
      stdout: "HERMES_WAKE_ADMISSION ADMIT active=0 cap=2 free_mb=9000",
      stderr: "",
    }));
    await acquireHostWakeSlot(infra, {
      ...baseParams,
      hostConfig: { hostSlug: "fixturenode3", failClosed: true },
      runHostScript,
    });
    expect(resolveProxmoxHostEnv).toHaveBeenCalled();

    await acquireHostWakeSlot(infra, { ...baseParams, runHostScript });
    expect(resolveProxmoxOperationEnv).toHaveBeenCalled();
  });

  it("threads the env-configured cap into the script", async () => {
    const runHostScript = jest.fn(async (_script: string) => ({
      ok: true,
      stdout: "HERMES_WAKE_ADMISSION ADMIT active=0 cap=4 free_mb=9000",
      stderr: "",
    }));
    await acquireHostWakeSlot(infra, {
      ...baseParams,
      env: { HERMES_WAKE_MAX_CONCURRENT_PER_HOST: "4" },
      runHostScript,
    });
    expect(runHostScript.mock.calls[0][0]).toContain("CAP=4");
  });
});

describe("releaseHostWakeSlot", () => {
  it("removes this instance's slot marker", async () => {
    const runHostScript = jest.fn(async (_script: string) => ({ ok: true, stdout: "released", stderr: "" }));
    await releaseHostWakeSlot(infra, { instanceId: "inst-123", runHostScript });
    expect(runHostScript.mock.calls[0][0]).toContain("/run/hermes-wake-slots/inst-123.slot");
  });

  it("swallows errors (best-effort; TTL prune is the backstop)", async () => {
    const runHostScript = jest.fn(async () => {
      throw new Error("host gone");
    });
    await expect(
      releaseHostWakeSlot(infra, { instanceId: "inst-123", runHostScript }),
    ).resolves.toBeUndefined();
  });
});

describe("checkHostWakeCapacity (legacy Hivra-lane gate)", () => {
  it("allows when free RAM covers need + margin", async () => {
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({ ok: true, stdout: "4096\n", stderr: "" });
    await expect(checkHostWakeCapacity(1024, {})).resolves.toEqual({ ok: true, freeMb: 4096 });
  });

  it("blocks when the margin is positively violated", async () => {
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({ ok: true, stdout: "1200\n", stderr: "" });
    await expect(checkHostWakeCapacity(1024, {})).resolves.toEqual({ ok: false, freeMb: 1200 });
  });

  it("fails open on unparsable probe output", async () => {
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({ ok: true, stdout: "n/a", stderr: "" });
    await expect(checkHostWakeCapacity(1024, {})).resolves.toEqual({ ok: true, freeMb: null });
  });
});
