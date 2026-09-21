export const BROWSER_SIDECAR_DEPLOY_ENABLED_ENV = "HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED";

type EnvLike = Record<string, string | undefined>;

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

export function isBrowserSidecarDeploymentGateEnabled(env: EnvLike = process.env): boolean {
  return TRUTHY_VALUES.has(
    (env[BROWSER_SIDECAR_DEPLOY_ENABLED_ENV] ?? "").trim().toLowerCase()
  );
}

/**
 * Minimum instance RAM (MB) required to host the browser sidecar safely.
 *
 * The sidecar (Playwright + Chromium + Xvfb/x11vnc/websockify) is capped at
 * ~1320 MB and idles ~550 MB. On top of the agent containers (~0.5 GB), Caddy,
 * the dashboard sidecar, and OS overhead, a box needs ~2.5 GB to host it
 * without the kernel OOM-killer thrashing the VM. Every Pro tier clears this
 * comfortably (operator 4096 / fleet 8192 / command 16384); this floor is a
 * defense-in-depth guard so we never schedule a 1.3 GB container onto a box
 * whose RAM budget cannot fit it (e.g. a stale or mis-set tier). The sidecar's
 * own entrypoint also re-checks *actual* free RAM and exits cleanly, since this
 * DB-side budget can drift from the live VM allocation.
 */
// NB: paired with the sidecar entrypoint's actual-RAM floor in
// services/browser-sidecar/src/preflight/memory.ts (MIN_VM_RAM_BYTES).
export const BROWSER_SIDECAR_MIN_RAM_MB = 2560;

/**
 * True when an instance's RAM budget (MB) can host the browser sidecar.
 *
 * Unknown budget (null/undefined — e.g. an older row missing `ram_limit`) is
 * allowed: we don't actually know the box is small, and the sidecar's own
 * entrypoint re-checks the live VM's *actual* RAM and bails if undersized. We
 * only exclude a box whose budget is KNOWN to be below the floor, so a Pro
 * instance is never silently denied the sidecar over a missing DB field.
 */
export function instanceCanFitBrowserSidecar(
  ramLimitMb: number | null | undefined
): boolean {
  if (ramLimitMb == null) return true;
  return ramLimitMb >= BROWSER_SIDECAR_MIN_RAM_MB;
}
