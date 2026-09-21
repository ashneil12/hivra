import os from "node:os";

/**
 * Minimum VM total RAM (bytes) required to host the browser sidecar.
 *
 * The sidecar (Playwright + Chromium + Xvfb/x11vnc/websockify) needs ~1.3 GB
 * and must coexist on the same VM with the agent containers, Caddy, and the OS.
 * On a VM that physically can't provide this, launching Chromium thrashes the
 * kernel OOM-killer and can take down sibling containers. We refuse to start
 * (exit 0, like the tier gate) rather than risk that.
 *
 * This is the actual-RAM safety net behind the dashboard's `ram_limit` gate
 * (BROWSER_SIDECAR_MIN_RAM_MB): the DB-side budget can drift from the live VM
 * allocation (e.g. a stale or mis-set tier), so we re-check the VM's real
 * total memory here. Set slightly below the dashboard floor so a box the
 * dashboard deliberately admitted isn't bounced by rounding/overhead.
 */
export const MIN_VM_RAM_BYTES = 2048 * 1024 * 1024; // 2 GiB

/** True when the VM has enough total RAM to host the sidecar safely. */
export function hasSufficientMemory(totalBytes: number = os.totalmem()): boolean {
  return Number.isFinite(totalBytes) && totalBytes >= MIN_VM_RAM_BYTES;
}

/** Total VM RAM in whole MB, for logging. */
export function totalRamMb(totalBytes: number = os.totalmem()): number {
  return Math.round(totalBytes / 1024 / 1024);
}
