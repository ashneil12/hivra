/**
 * Output parsers for Proxmox host scripts.
 *
 * Every function here reads the stdout of a script built in script-builders.ts
 * and turns it into typed data (or throws / returns null) exactly as before.
 * Extracted verbatim from proxmox-instance-service.ts.
 */
export function parseProxmoxProvisionOutput(output: string): {
  vmid: number;
  privateIpv4: string;
  gatewayHost: string;
} {
  const match = output.match(/^HERMES_PROXMOX_RESULT\s+(\{.*\})$/m);
  if (!match?.[1]) {
    throw new Error("Proxmox provisioning did not return VM metadata.");
  }

  const parsed = JSON.parse(match[1]) as {
    vmid?: unknown;
    privateIpv4?: unknown;
    gatewayHost?: unknown;
  };
  if (
    typeof parsed.vmid !== "number" ||
    !Number.isFinite(parsed.vmid) ||
    typeof parsed.privateIpv4 !== "string" ||
    !parsed.privateIpv4.trim() ||
    typeof parsed.gatewayHost !== "string" ||
    !parsed.gatewayHost.trim()
  ) {
    throw new Error("Proxmox provisioning returned invalid VM metadata.");
  }

  return {
    vmid: parsed.vmid,
    privateIpv4: parsed.privateIpv4,
    gatewayHost: parsed.gatewayHost,
  };
}
export function parseProxmoxInfrastructureDiscoveryOutput(output: string): {
  vmid: number;
  privateIpv4: string;
} | null {
  const match = output.match(/^HERMES_PROXMOX_DISCOVERY\s+(\{.*\})$/m);
  if (!match?.[1]) return null;

  const parsed = JSON.parse(match[1]) as {
    vmid?: unknown;
    privateIpv4?: unknown;
  };
  if (
    typeof parsed.vmid !== "number" ||
    !Number.isFinite(parsed.vmid) ||
    typeof parsed.privateIpv4 !== "string" ||
    !parsed.privateIpv4.trim()
  ) {
    return null;
  }

  return {
    vmid: parsed.vmid,
    privateIpv4: parsed.privateIpv4,
  };
}
export function parseProxmoxVmidAvailabilityOutput(stdout: string): {
  occupiedVmids: number[];
  freeVmids: number[];
} {
  const occupiedVmids: number[] = [];
  const freeVmids: number[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const occupied = line.match(/^HERMES_PROXMOX_VMID_OCCUPIED\s+(\d+)$/);
    if (occupied?.[1]) {
      occupiedVmids.push(Number.parseInt(occupied[1], 10));
      continue;
    }

    const free = line.match(/^HERMES_PROXMOX_VMID_FREE\s+(\d+)$/);
    if (free?.[1]) {
      freeVmids.push(Number.parseInt(free[1], 10));
    }
  }

  return { occupiedVmids, freeVmids };
}
export function parseProxmoxTemplateAvailabilityOutput(stdout: string): {
  ready: boolean;
  missing: boolean;
  notTemplate: boolean;
  details: string;
} {
  const details: string[] = [];
  let ready = false;
  let missing = false;
  let notTemplate = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (/^HERMES_PROXMOX_TEMPLATE_READY\s+\d+$/.test(line)) {
      ready = true;
      continue;
    }
    if (/^HERMES_PROXMOX_TEMPLATE_MISSING\s+\d+$/.test(line)) {
      missing = true;
      continue;
    }
    if (/^HERMES_PROXMOX_TEMPLATE_NOT_TEMPLATE\s+\d+$/.test(line)) {
      notTemplate = true;
      continue;
    }
    const error = line.match(/^HERMES_PROXMOX_TEMPLATE_ERROR\s+(.+)$/);
    if (error?.[1]) details.push(error[1]);
  }

  return { ready, missing, notTemplate, details: details.join("\n") };
}
// ─── per-VM metering ──────────────────────────────────────────────────────
// Sprint 0 W3: pull host-side resource counters for billing reconciliation.
// `qm status <vmid> --verbose` returns shell-style key=value lines that
// cover everything we need: cpu (frac of 1 core, instantaneous), maxmem,
// uptime, netout (cumulative bytes since VM boot), disk used (via
// `disk` for some templates) plus runtime metrics. We marshal the verbose
// output as METRIC <key>=<value> lines so parsing is robust to qm output
// changes.
//
// Why qm status --verbose vs `pvesh /nodes/<n>/qemu/<v>/rrddata`: the rrd
// path returns averaged buckets which lose the cumulative cpu-seconds /
// netout monotonic counters we need for delta-based billing. The verbose
// form gives us the live process counters we can subtract across samples.

export interface ProxmoxInstanceMetrics {
  /** Cumulative CPU seconds consumed by the VM since boot. */
  cpu_seconds_total: number;
  /** Peak / current RAM usage (bytes). */
  ram_peak_bytes: number;
  /** Disk usage (bytes) at sample time. */
  disk_used_bytes: number;
  /**
   * Guest filesystem total size (bytes) from `df /` at sample time — the real
   * disk the agent sees. 0 when the sample was NOT guest-sourced (SSH/guest
   * agent unavailable). Paired with disk_used_bytes from the same `df` line, so
   * when this is > 0, disk_used_bytes is the guest's real used value. The
   * storage banner divides by this, never by the thin-provisioned disk_size_gb.
   */
  disk_total_bytes: number;
  /**
   * True when `disk_used_bytes` is NOT a real usage reading — it fell back to
   * the provisioned `maxdisk` capacity because neither the guest df nor qm
   * `disk` value was available. Consumers should treat such a "used" value as
   * capacity, not real usage (otherwise the disk-usage banner reads ~100%).
   */
  disk_used_is_capacity_fallback: boolean;
  /** VM uptime (seconds) at sample time. */
  runtime_seconds: number;
  /** Cumulative outbound bytes since VM boot. */
  net_out_bytes: number;
  /** Raw scraped lines for the metering audit log. */
  raw: Record<string, string>;
}
function parseMetricNumber(value: string | undefined): number {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}
export function parseProxmoxMetricsOutput(output: string): ProxmoxInstanceMetrics | null {
  const raw: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^METRIC\s+([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key) raw[key] = value;
  }

  if (raw.status === "missing") {
    return null;
  }

  // Maxmem is the cap; mem is the live used value. We treat "live used"
  // as the peak observation for this sample; the metering table column
  // is named ram_peak_bytes because aggregation across rows yields a
  // running peak (max).
  const memUsed = parseMetricNumber(raw.mem);
  const maxmem = parseMetricNumber(raw.maxmem);
  // Disk: prefer the guest filesystem's `df` reading when SSH is available.
  // Some templates expose `disk` (used bytes), but Proxmox often reports 0
  // unless qemu-guest-agent is fully wired up. Maxdisk remains the last
  // fallback so metering never records an empty disk value.
  const guestDiskUsed = parseMetricNumber(raw.guest_disk_used_bytes);
  const guestDiskTotal = parseMetricNumber(raw.guest_disk_total_bytes);
  const diskUsed = parseMetricNumber(raw.disk);
  const maxdisk = parseMetricNumber(raw.maxdisk);
  // When neither a real guest df reading nor qm's `disk` value is available we
  // fall back to `maxdisk` (the provisioned size) just so the metering column
  // is never empty — but that value is capacity, NOT real usage. Flag it so the
  // disk-usage banner can suppress a bogus "almost full".
  const diskUsedIsCapacityFallback =
    guestDiskUsed <= 0 && diskUsed <= 0 && maxdisk > 0;
  // qm reports uptime in seconds (integer). On stopped VMs it returns 0.
  const uptime = parseMetricNumber(raw.uptime);
  // Cumulative IO counters since boot.
  const netout = parseMetricNumber(raw.netout);
  // CPU seconds: qm reports `cputime` as accumulated host CPU time
  // (seconds, fractional). Older Proxmox builds may only report `cpu`
  // (instantaneous fraction of one core) — we fall back to runtime *
  // cpu (an estimate) only when cputime is missing, so the column is
  // never empty.
  const cputime = parseMetricNumber(raw.cputime);
  const cpuFraction = parseMetricNumber(raw.cpu);
  const cpuSecondsTotal = cputime > 0 ? cputime : Math.max(0, uptime * cpuFraction);

  return {
    cpu_seconds_total: cpuSecondsTotal,
    ram_peak_bytes: Math.round(memUsed > 0 ? memUsed : maxmem),
    disk_used_bytes: Math.round(
      guestDiskUsed > 0 ? guestDiskUsed : (diskUsed > 0 ? diskUsed : maxdisk)
    ),
    // Only the guest `df` total is a trustworthy denominator for "how full".
    // We deliberately do NOT fall back to maxdisk here: maxdisk is the
    // provisioned capacity, and pairing it as a "total" with a maxdisk-derived
    // "used" (the fallback above) would read as 100% full. 0 => not
    // guest-sourced => the banner shows nothing rather than a false alarm.
    disk_total_bytes: Math.round(guestDiskTotal > 0 ? guestDiskTotal : 0),
    disk_used_is_capacity_fallback: diskUsedIsCapacityFallback,
    runtime_seconds: uptime,
    net_out_bytes: Math.round(netout),
    raw,
  };
}
export type ProxmoxTemplateAuditDecision =
  | "SAFE_TO_DELETE"
  | "KEEP_LINKED_PARENT"
  | "KEEP_CURRENT"
  | "KEEP_ROLLBACK";
export interface ProxmoxTemplateAuditVm {
  vmid: number;
  name: string;
  status: string;
  isTemplate: boolean;
  linkedTemplateVmids: number[];
}
export interface ProxmoxTemplateAuditTemplate {
  vmid: number;
  name: string;
  status: string;
  decision: ProxmoxTemplateAuditDecision;
  reasons: string[];
  dependentVmids: number[];
}
export interface ProxmoxTemplateAuditReport {
  generatedAt: string;
  currentTemplateVmid: number | null;
  dbTemplateVmids: number[];
  templates: ProxmoxTemplateAuditTemplate[];
  vms: ProxmoxTemplateAuditVm[];
  rawDependencyRefs: Array<{
    childVmid: number;
    templateVmid: number;
    source: "config" | "lvm" | "zfs";
    detail: string;
  }>;
}
function parseConfigName(config: string, fallback: string): string {
  const match = config.match(/^name:\s*(.+)$/m);
  return match?.[1]?.trim() || fallback;
}
function parseConfigStatus(config: string, fallback: string): string {
  const match = config.match(/^status:\s*(.+)$/m);
  return match?.[1]?.trim() || fallback;
}
function parseConfigIsTemplate(config: string): boolean {
  return /^template:\s*1\s*$/m.test(config);
}
function collectTemplateRefs(value: string): number[] {
  const refs = new Set<number>();
  for (const match of value.matchAll(/base-(\d+)-disk-/g)) {
    const vmid = Number(match[1]);
    if (Number.isFinite(vmid) && vmid > 0) refs.add(vmid);
  }
  return Array.from(refs).sort((a, b) => a - b);
}
function collectChildVmid(value: string): number | null {
  const match = value.match(/\bvm-(\d+)-disk-/);
  if (!match?.[1]) return null;
  const vmid = Number(match[1]);
  return Number.isFinite(vmid) && vmid > 0 ? vmid : null;
}
export function parseProxmoxTemplateAuditOutput(
  output: string,
  opts: {
    currentTemplateVmid?: number | null;
    dbTemplateVmids?: number[];
    generatedAt?: string;
  } = {}
): ProxmoxTemplateAuditReport {
  const qmList = new Map<number, { name: string; status: string }>();
  const configs = new Map<number, string>();
  const rawDependencyRefs: ProxmoxTemplateAuditReport["rawDependencyRefs"] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("QMLIST|")) {
      const [, rawVmid, name = "", status = "unknown"] = line.split("|");
      const vmid = Number(rawVmid);
      if (Number.isFinite(vmid)) {
        qmList.set(vmid, { name, status });
      }
      continue;
    }

    if (line.startsWith("QMCONFIG|")) {
      const [, rawVmid, encoded = ""] = line.split("|");
      const vmid = Number(rawVmid);
      if (Number.isFinite(vmid)) {
        configs.set(vmid, Buffer.from(encoded, "base64").toString("utf8"));
      }
      continue;
    }

    if (line.startsWith("LVM|")) {
      const parts = line.split("|");
      const lvName = parts[2] || "";
      const origin = parts[3] || "";
      const childVmid = collectChildVmid(lvName);
      if (childVmid == null || !origin) continue;
      for (const templateVmid of collectTemplateRefs(origin)) {
        rawDependencyRefs.push({
          childVmid,
          templateVmid,
          source: "lvm",
          detail: `${lvName} origin=${origin}`,
        });
      }
      continue;
    }

    if (line.startsWith("ZFS|")) {
      const [, dataset = "", origin = ""] = line.split("|");
      const childVmid = collectChildVmid(dataset);
      if (childVmid == null || !origin || origin === "-") continue;
      for (const templateVmid of collectTemplateRefs(origin)) {
        rawDependencyRefs.push({
          childVmid,
          templateVmid,
          source: "zfs",
          detail: `${dataset} origin=${origin}`,
        });
      }
    }
  }

  for (const [vmid, config] of configs) {
    const isTemplate = parseConfigIsTemplate(config);
    if (isTemplate) continue;
    for (const templateVmid of collectTemplateRefs(config)) {
      rawDependencyRefs.push({
        childVmid: vmid,
        templateVmid,
        source: "config",
        detail: "qm config disk reference",
      });
    }
  }

  const refsByChild = new Map<number, Set<number>>();
  const depsByTemplate = new Map<number, Set<number>>();
  for (const ref of rawDependencyRefs) {
    if (!refsByChild.has(ref.childVmid)) refsByChild.set(ref.childVmid, new Set());
    refsByChild.get(ref.childVmid)!.add(ref.templateVmid);
    if (!depsByTemplate.has(ref.templateVmid)) depsByTemplate.set(ref.templateVmid, new Set());
    depsByTemplate.get(ref.templateVmid)!.add(ref.childVmid);
  }

  const vms: ProxmoxTemplateAuditVm[] = Array.from(configs.entries())
    .map(([vmid, config]) => {
      const listed = qmList.get(vmid);
      return {
        vmid,
        name: parseConfigName(config, listed?.name || `vm-${vmid}`),
        status: parseConfigStatus(config, listed?.status || "unknown"),
        isTemplate: parseConfigIsTemplate(config),
        linkedTemplateVmids: Array.from(refsByChild.get(vmid) ?? []).sort((a, b) => a - b),
      };
    })
    .sort((a, b) => a.vmid - b.vmid);

  const currentTemplateVmid =
    typeof opts.currentTemplateVmid === "number" && Number.isFinite(opts.currentTemplateVmid)
      ? opts.currentTemplateVmid
      : null;
  const dbTemplateVmids = Array.from(
    new Set((opts.dbTemplateVmids ?? []).filter((vmid) => Number.isFinite(vmid)))
  ).sort((a, b) => a - b);
  const dbTemplateSet = new Set(dbTemplateVmids);

  const templates: ProxmoxTemplateAuditTemplate[] = vms
    .filter((vm) => vm.isTemplate)
    .map((template) => {
      const dependentVmids = Array.from(depsByTemplate.get(template.vmid) ?? []).sort((a, b) => a - b);
      const reasons: string[] = [];
      let decision: ProxmoxTemplateAuditDecision;

      if (dependentVmids.length > 0) {
        decision = "KEEP_LINKED_PARENT";
        reasons.push(`linked clone parent for ${dependentVmids.length} VM(s)`);
      } else if (currentTemplateVmid === template.vmid) {
        decision = "KEEP_CURRENT";
        reasons.push("current PROXMOX_TEMPLATE_ID");
      } else if (dbTemplateSet.has(template.vmid)) {
        decision = "KEEP_ROLLBACK";
        reasons.push("referenced by active instance provenance");
      } else {
        decision = "SAFE_TO_DELETE";
        reasons.push("no linked-clone dependency detected");
      }

      return {
        vmid: template.vmid,
        name: template.name,
        status: template.status,
        decision,
        reasons,
        dependentVmids,
      };
    })
    .sort((a, b) => a.vmid - b.vmid);

  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    currentTemplateVmid,
    dbTemplateVmids,
    templates,
    vms,
    rawDependencyRefs,
  };
}
