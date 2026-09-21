/**
 * Phase 5 (Hivra V1 rebuild): per-VM scheduling priority via Proxmox `--cpuunits`
 * (cgroup CPU weight). Under host CPU contention, a higher weight gets a
 * proportionally larger share while still bursting into idle headroom — this is
 * the real enforcement behind the marketed "priority resources / burst CPU".
 *
 * Pool priority (0=low, 1=normal, 2=high) comes from the plan tier
 * (subscription/agent-slots: free 0, Pro 1, Power/Command 2).
 *
 * VALUE NOTE: cgroup v2 hosts (Proxmox 8) treat cpuunits as CPUWeight
 * (default 100, range 1-10000); cgroup v1 hosts default to 1024. The values
 * below are RELATIVE between tenant VMs (which is what determines inter-tenant
 * priority) and stay within both ranges, so they weight proportionally on either.
 *
 * ⚠️ Needs a live contention test on a saturated host before being relied upon.
 */

const CPU_UNITS_BY_PRIORITY: Record<number, number> = {
  0: 50, // free — lowest
  1: 100, // Pro — normal (cgroup v2 default)
  2: 200, // Power / Command — priority
};

export function priorityToCpuUnits(priority: number | null | undefined): number {
  const p = Math.max(0, Math.min(2, Math.floor(Number(priority) || 0)));
  return CPU_UNITS_BY_PRIORITY[p] ?? 100;
}
