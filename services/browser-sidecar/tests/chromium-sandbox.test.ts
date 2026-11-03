import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the 2026-11-03 finding: the sidecar ran Playwright's
// Chromium 147 as root with --no-sandbox while browsing untrusted sites, so a
// renderer bug (CVE-2026-118306 and friends) owned the container outright.

const launchPersistentContext = vi.fn(async () => ({ close: vi.fn(), newPage: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launchPersistentContext, connectOverCDP: vi.fn() } }));

const { SessionManager } = await import("../src/playwright/session-manager.js");
const chromiumModule = await import("../src/browser/chromium.js");
const { parseSandboxPage } = await import("../src/browser/sandbox-status.js");
const { registerHealthRoutes, CDP_BROWSER_GRACE_S } = await import("../src/routes/health.js");
const { fakeConfig, fakeSessionManager, silentLogger } = await import("./_fakes.js");

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("Chromium launch settings", () => {
  it("never pass --no-sandbox, in any launch path", () => {
    expect(chromiumModule.CHROMIUM_COMMON_ARGS).not.toContain("--no-sandbox");
    const sources = [...filesUnder(join(packageRoot, "src")), ...filesUnder(join(packageRoot, "docker"))];
    for (const file of sources) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|#)/.test(line))
        .join("\n");
      expect({ file, flag: /["'`]--no-sandbox["'`]/.test(code) }).toEqual({ file, flag: false });
      expect({ file, opt: /chromiumSandbox:\s*false/.test(code) }).toEqual({ file, opt: false });
    }
  });

  it("refuse to start Chromium as root rather than unsandboxed", () => {
    expect(() => chromiumModule.assertCanSandbox(() => 0)).toThrow(/refusing to launch Chromium as root/);
    expect(() => chromiumModule.assertCanSandbox(() => 10001)).not.toThrow();
  });

  it("hold the CVE floor: Playwright's bundled builds are below it, Debian's fix is above", () => {
    const atLeast = chromiumModule.chromiumVersionAtLeast;
    expect(atLeast("147.0.7727.15")).toBe(false); // what the fleet ran (Playwright 1.59)
    expect(atLeast("156.0.8078.4")).toBe(false); // Playwright 1.64's bundled build
    expect(atLeast("156.0.8078.73")).toBe(true);
    expect(atLeast("156.0.8078.79")).toBe(true); // Debian trixie-security, 2026-11-03
    expect(atLeast("158.0.8127.2")).toBe(true);
    expect(() => atLeast("Chromium 156")).toThrow(/not a Chromium version/);
  });

  it("prefer an explicit CHROMIUM_PATH", () => {
    expect(chromiumModule.resolveChromiumExecutable({ CHROMIUM_PATH: "/opt/x/chrome" })).toBe("/opt/x/chrome");
  });
});

describe("SessionManager launch", () => {
  beforeEach(() => launchPersistentContext.mockClear());

  it("launches the persistent context with the sandbox on and the shared flags", async () => {
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(10001);
    try {
      const config = fakeConfig({ PROFILES_DIR: join(tmpdir(), "sidecar-sandbox-test-profiles") });
      const manager = new SessionManager(config as never, silentLogger() as never);
      await manager.start("qa").catch(() => {});
      expect(launchPersistentContext).toHaveBeenCalledTimes(1);
      const options = (launchPersistentContext.mock.calls[0] as unknown[])[1] as {
        chromiumSandbox: boolean;
        executablePath?: string;
        args: string[];
      };
      expect(options.chromiumSandbox).toBe(true);
      expect(options.args).not.toContain("--no-sandbox");
      expect(options.args).toEqual(expect.arrayContaining([...chromiumModule.CHROMIUM_COMMON_ARGS]));
    } finally {
      getuid.mockRestore();
    }
  });

  it("does not launch Chromium at all when running as root", async () => {
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    try {
      const config = fakeConfig({ PROFILES_DIR: join(tmpdir(), "sidecar-sandbox-test-profiles") });
      const manager = new SessionManager(config as never, silentLogger() as never);
      await expect(manager.start("qa")).rejects.toThrow(/refusing to launch Chromium as root/);
      expect(launchPersistentContext).not.toHaveBeenCalled();
    } finally {
      getuid.mockRestore();
    }
  });
});

describe("chrome://sandbox parsing", () => {
  const adequate = [
    "Sandbox Status",
    "Layer 1 Sandbox\tNamespace",
    "PID namespaces\tYes",
    "Network namespaces\tYes",
    "Seccomp-BPF sandbox\tYes",
    "Seccomp-BPF sandbox supports TSYNC\tYes",
    "You are adequately sandboxed.",
  ].join("\n");

  it("reads an adequate sandbox (tab- or line-separated rows)", () => {
    expect(parseSandboxPage(adequate)).toEqual({
      verdict: "adequate",
      layers: {
        "Layer 1 Sandbox": "Namespace",
        "PID namespaces": "Yes",
        "Network namespaces": "Yes",
        "Seccomp-BPF sandbox": "Yes",
        "Seccomp-BPF sandbox supports TSYNC": "Yes",
      },
    });
    expect(parseSandboxPage(adequate.replaceAll("\t", "\n")).verdict).toBe("adequate");
  });

  it("reports not adequate when Chromium says so, or when a required layer is off", () => {
    expect(parseSandboxPage("Seccomp-BPF sandbox\tNo\nYou are not adequately sandboxed!").verdict).toBe("not_adequate");
    expect(parseSandboxPage(adequate.replace("Seccomp-BPF sandbox\tYes", "Seccomp-BPF sandbox\tNo")).verdict).toBe(
      "not_adequate",
    );
    expect(parseSandboxPage("about:blank").verdict).toBe("unknown");
  });
});

describe("/health reflects the agent's CDP browser", () => {
  async function healthWith(cdpUp: boolean | undefined, uptimeS: number) {
    const app = Fastify();
    registerHealthRoutes(app, {
      sessions: fakeSessionManager(),
      startedAt: Date.now() - uptimeS * 1000,
      tierOk: true,
      cdpProbe: cdpUp === undefined ? undefined : async () => cdpUp,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();
    return { status: res.statusCode, body: res.json() };
  }

  it("is healthy with the browser up", async () => {
    expect(await healthWith(true, 600)).toMatchObject({ status: 200, body: { ok: true, browser: "up" } });
  });

  it("turns 503 when the sandboxed browser cannot run, after the start grace", async () => {
    expect(await healthWith(false, CDP_BROWSER_GRACE_S - 5)).toMatchObject({ status: 200, body: { browser: "down" } });
    expect(await healthWith(false, CDP_BROWSER_GRACE_S + 5)).toMatchObject({
      status: 503,
      body: { ok: false, browser: "down" },
    });
  });

  it("does not probe outside CDP mode (browser launched on demand)", async () => {
    expect(await healthWith(undefined, 600)).toMatchObject({ status: 200, body: { ok: true, browser: "on_demand" } });
  });
});

describe("seccomp-chromium.json", () => {
  type Rule = { names: string[]; action: string; args?: unknown[]; includes?: unknown; excludes?: unknown; errnoRet?: number };
  const profile = JSON.parse(readFileSync(join(packageRoot, "docker", "seccomp-chromium.json"), "utf8")) as {
    defaultAction: string;
    syscalls: Rule[];
  };

  it("is Docker's default profile (deny by default) plus one rule for Chromium's namespace sandbox", () => {
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const userns = profile.syscalls.at(-1)!;
    expect(userns).toMatchObject({ names: ["clone", "setns", "unshare"], action: "SCMP_ACT_ALLOW" });
    expect(userns.args ?? []).toEqual([]);
    expect(userns.includes ?? {}).toEqual({});
    // Only that rule widens Docker's default for namespace syscalls.
    const unconditional = profile.syscalls.filter(
      (rule) =>
        rule.action === "SCMP_ACT_ALLOW" &&
        !rule.includes &&
        (rule.args ?? []).length === 0 &&
        rule.names.some((name) => ["clone", "setns", "unshare", "mount", "bpf", "ptrace"].includes(name)),
    );
    expect(unconditional).toEqual([userns]);
  });

  it("keeps Docker's clone3 -> ENOSYS rule so glibc falls back to clone", () => {
    expect(profile.syscalls).toContainEqual(
      expect.objectContaining({ names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 }),
    );
  });
});
