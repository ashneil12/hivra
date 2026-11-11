import { existsSync } from "node:fs";

// One place that decides which Chromium the sidecar runs and how it is
// launched. Both launch paths use it: the Playwright persistent contexts
// (src/playwright/session-manager.ts) and the agent's CDP Chrome
// (docker/cdp-proxy.mjs imports the compiled copy from /app/dist).
//
// The sidecar browses real, untrusted sites, so Chromium's own sandbox must be
// ON. There is deliberately no --no-sandbox anywhere and no switch to add it:
// if the container cannot give Chromium a sandbox (root user, Docker's default
// seccomp profile, an AppArmor profile without `userns`), Chromium refuses to
// start and the failure is loud instead of silently unsandboxed. The container
// settings that make the sandbox work are in docker/seccomp-chromium.json and
// the compose block in dashboard/src/lib/services/webui-instance-builder.ts.

// The image installs Debian's security-tracked Chromium (see Dockerfile). This
// is the real binary, not the /usr/bin/chromium wrapper script, which sources
// /etc/chromium.d and adds desktop flags (remote extensions, bundled
// extensions) a headless automation browser should not carry.
export const IMAGE_CHROMIUM_PATH = "/usr/lib/chromium/chromium";

// Oldest Chromium the image may ship: 156.0.8078.73 fixes CVE-2026-118306
// (FileSystem memory corruption, sandbox escape from a crafted page). The
// Dockerfile refuses to build below this and the tests pin it. Raise it when a
// newer Chromium security fix matters; never lower it.
export const MIN_CHROMIUM_VERSION = "156.0.8078.73";

// Flags shared by both launch paths. Never add --no-sandbox here.
export const CHROMIUM_COMMON_ARGS: readonly string[] = [
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
];

export function diskCacheArg(megabytes: number): string {
  return `--disk-cache-size=${megabytes * 1024 * 1024}`;
}

/**
 * The Chromium binary to launch. CHROMIUM_PATH overrides (local development);
 * inside the image it is Debian's Chromium binary. Returns undefined outside
 * the image so Playwright falls back to its own browser for local dev.
 */
export function resolveChromiumExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.CHROMIUM_PATH?.trim();
  if (override) return override;
  return existsSync(IMAGE_CHROMIUM_PATH) ? IMAGE_CHROMIUM_PATH : undefined;
}

/**
 * Refuse to launch as root: Chromium cannot sandbox itself as root, and the
 * only way to make it start would be --no-sandbox. The entrypoint drops to the
 * unprivileged `browser` user before anything starts Chromium.
 */
export function assertCanSandbox(getuid: (() => number) | undefined = process.getuid): void {
  if (getuid && getuid() === 0) {
    throw new Error(
      "refusing to launch Chromium as root: its sandbox cannot run as root and the sidecar never " +
        "passes --no-sandbox. Start the container through docker/entrypoint.sh (it drops to the " +
        "`browser` user) or run it with a non-root user.",
    );
  }
}

/** Compare dotted Chromium versions ("156.0.8078.73"). */
export function chromiumVersionAtLeast(version: string, minimum: string = MIN_CHROMIUM_VERSION): boolean {
  const actual = version.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  if (actual.length !== 4 || floor.length !== 4 || [...actual, ...floor].some((n) => !Number.isInteger(n))) {
    throw new Error(`not a Chromium version: ${version} (floor ${minimum})`);
  }
  for (let index = 0; index < 4; index++) {
    if (actual[index] !== floor[index]) return actual[index] > floor[index];
  }
  return true;
}
