/**
 * Fleet sweep: flip every tenant VM's scsi0 from aio=io_uring (the broken
 * Proxmox default — silently swallows guest UNMAP, so fstrim inside the
 * guest reclaims nothing on the host thin-pool) to aio=threads (UNMAP
 * passes through, fstrim actually frees blocks).
 *
 * Generic operator repair for existing Proxmox VMs. Run a dry-run first
 * and review the target list before applying changes during maintenance.
 *
 * Per VM:
 *   1. qm config <vmid> → parse scsi0.
 *   2. Skip if already aio=threads (idempotent).
 *   3. Skip templates (vmid >= 9000) and the cloudinit ide2 drive.
 *   4. Build the corrected scsi0 line preserving every other option
 *      (discard=on, size, ssd=1, cache=…, etc.).
 *   5. qm set <vmid> --scsi0 <new>.
 *   6. If VM is running, qm reboot <vmid> (graceful + atomic). Wait up
 *      to 120s for `qm guest cmd <vmid> ping` to succeed. Log loudly
 *      and continue on stuck VMs — don't abort the fleet sweep.
 *   7. Capture before/after `lvs vg0/data` Data% across the host's
 *      reboots, and (unless --no-trim) run an immediate
 *      `fstrim -v /` via guest-agent to reclaim the io_uring backlog.
 *
 * Usage:
 *   pnpm tsx dashboard/scripts/fleet-fix-aio-threads.ts                                 # dry-run (default)
 *   pnpm tsx dashboard/scripts/fleet-fix-aio-threads.ts --apply                         # do it
 *   pnpm tsx dashboard/scripts/fleet-fix-aio-threads.ts --dry-run --host your-host           # scope to one host
 *   pnpm tsx dashboard/scripts/fleet-fix-aio-threads.ts --apply --instance <uuid>       # cherry-pick one VM
 *   pnpm tsx dashboard/scripts/fleet-fix-aio-threads.ts --apply --no-trim               # skip post-reboot fstrim
 *   pnpm tsx dashboard/scripts/fleet-fix-aio-threads.ts --apply --max-parallel 3        # up to 3 VMs per host in parallel (NEVER cross-host)
 *
 * Safety:
 *   - Default mode is dry-run.
 *   - Idempotent: VMs already on aio=threads are skipped.
 *   - The original scsi0 line is captured per VM and emitted in the
 *     summary so a rollback script could be assembled from the log.
 *   - VMIDs >= 9000 are templates → never touched.
 *   - Only scsi0 is rewritten; ide2 (cloudinit) is left alone.
 *   - Hosts are processed serially; within a host the operator may
 *     opt in to bounded parallelism via --max-parallel.
 */

import path from "path";
import * as dotenv from "dotenv";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

import {
  getProxmoxInfrastructure,
  resolveProxmoxHostEnv,
  resolveProxmoxTargetCandidateIds,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";


interface Args {
  apply: boolean;
  dryRun: boolean;
  hostFilter: string | null;
  instanceFilter: string | null;
  noTrim: boolean;
  maxParallel: number;
}

interface InstanceRow {
  id: string;
  name: string | null;
  status: string | null;
  proxmox_node: string | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
}

interface PlannedVm {
  instanceId: string;
  name: string;
  status: string;
  hostSlug: string;
  vmid: number;
}

type VmOutcome =
  | "already-threads"
  | "would-update"
  | "updated"
  | "updated-no-reboot"
  | "no-scsi0"
  | "is-template"
  | "vm-missing"
  | "guest-agent-timeout"
  | "qm-set-failed"
  | "qm-reboot-failed"
  | "trim-failed"
  | "trim-skipped";

interface VmResult {
  instanceId: string;
  name: string;
  hostSlug: string;
  vmid: number;
  outcome: VmOutcome;
  originalScsi0: string | null;
  plannedScsi0: string | null;
  poolBefore: number | null;
  poolAfter: number | null;
  vmBefore: number | null;
  vmAfter: number | null;
  detail?: string;
}

const TEMPLATE_VMID_MIN = 9000;

export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply;
  const get = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] ?? null : null;
  };
  const maxParallelRaw = get("--max-parallel");
  const maxParallel = Math.max(
    1,
    Math.min(3, Number.parseInt(maxParallelRaw || "1", 10) || 1),
  );
  return {
    apply,
    dryRun,
    hostFilter: get("--host"),
    instanceFilter: get("--instance"),
    noTrim: argv.includes("--no-trim"),
    maxParallel,
  };
}

function createSupabase() {
  const url = resolveSupabaseUrl();
  const key = resolveSupabaseServiceRoleKey();
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (check dashboard/.env.local).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function readSupabaseProjectRef(): string | null {
  try {
    return (
      readFileSync(path.join(__dirname, "../supabase/.temp/project-ref"), "utf8").trim() ||
      null
    );
  } catch {
    return null;
  }
}

function resolveSupabaseUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (configured) return configured;
  const ref = readSupabaseProjectRef();
  return ref ? `https://${ref}.supabase.co` : null;
}

function resolveSupabaseServiceRoleKey(): string | null {
  const configured = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (configured) return configured;

  const projectRef = readSupabaseProjectRef();
  if (!projectRef) return null;

  try {
    const raw = execFileSync(
      "supabase",
      ["projects", "api-keys", "--project-ref", projectRef, "--output", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const keys = JSON.parse(raw) as Array<{ name?: string; type?: string; api_key?: string }>;
    return (
      keys.find((entry) => entry.type === "secret")?.api_key ||
      keys.find((entry) => entry.name === "service_role")?.api_key ||
      null
    );
  } catch {
    return null;
  }
}

async function loadActiveInstances(supabase: ReturnType<typeof createSupabase>): Promise<InstanceRow[]> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .select("id, name, status, proxmox_node, host_id, config")
    .eq("infrastructure_provider", "proxmox")
    .not("status", "in", '("deleted","terminated","failed","scheduled_for_deletion")');
  if (error) {
    throw new Error(`Supabase list failed: ${error.message}`);
  }
  return (data || []) as InstanceRow[];
}

function planVm(row: InstanceRow): PlannedVm | null {
  const infra = getProxmoxInfrastructure(row.config);
  if (!infra) return null;
  const hostSlug = (infra.hostSlug || infra.node || row.proxmox_node || "").toString();
  if (!hostSlug) return null;
  return {
    instanceId: row.id,
    name: row.name || "",
    status: row.status || "",
    hostSlug,
    vmid: infra.vmid,
  };
}

/**
 * Parse a Proxmox `scsi0:` line (everything after `scsi0: `) and return
 * the corrected spec with `aio=threads`. Preserves storage prefix,
 * volume id, and every other option.
 *
 *   in:  local-lvm:vm-202-disk-0,size=30G,discard=on,ssd=1,aio=io_uring
 *   out: local-lvm:vm-202-disk-0,size=30G,discard=on,ssd=1,aio=threads
 *
 *   in:  local-lvm:vm-202-disk-0,size=30G,discard=on
 *   out: local-lvm:vm-202-disk-0,size=30G,discard=on,aio=threads
 */
export function rewriteScsi0(spec: string): { rewritten: string; changed: boolean } {
  const parts = spec.split(",");
  if (parts.length === 0) return { rewritten: spec, changed: false };

  let aioFound = false;
  const next = parts.map((part) => {
    const m = /^aio=(\S+)$/.exec(part.trim());
    if (!m) return part;
    aioFound = true;
    if (m[1] === "threads") return part;
    return part.replace(/aio=\S+/, "aio=threads");
  });

  if (!aioFound) {
    next.push("aio=threads");
  }

  const rewritten = next.join(",");
  return { rewritten, changed: rewritten !== spec };
}

function buildHostInspectScript(vmids: number[]): string {
  const list = vmids.map((v) => String(v)).join(" ");
  // Emit one block per VMID delimited by sentinels, plus a single
  // host-level POOL line. Stdout is the only channel back from the SSH
  // helper, so we keep the format strict and parseable.
  return `#!/usr/bin/env bash
set -uo pipefail
pool_pct="$(lvs --noheadings --units g -o data_percent vg0/data 2>/dev/null | awk '{print $1}')"
echo "POOL_BEFORE=${"${pool_pct:-}"}"
for vmid in ${list}; do
  echo "=== BEGIN ${"${vmid}"} ==="
  if ! qm status "${"${vmid}"}" >/dev/null 2>&1; then
    echo "STATUS=missing"
    echo "=== END ${"${vmid}"} ==="
    continue
  fi
  status_line="$(qm status "${"${vmid}"}" 2>/dev/null || true)"
  echo "STATUS_LINE=${"${status_line}"}"
  cfg="$(qm config "${"${vmid}"}" 2>/dev/null || true)"
  scsi0="$(echo "${"$cfg"}" | awk -F': ' '/^scsi0: /{sub(/^scsi0: /, ""); print; exit}')"
  echo "SCSI0=${"${scsi0}"}"
  vm_pct="$(lvs --noheadings --units g -o data_percent "vg0/vm-${"${vmid}"}-disk-0" 2>/dev/null | awk '{print $1}')"
  echo "VM_DATA_PCT=${"${vm_pct:-}"}"
  echo "=== END ${"${vmid}"} ==="
done
`;
}

export function buildApplyScript(args: {
  vmid: number;
  newScsi0: string;
  shouldReboot: boolean;
  runTrim: boolean;
}): string {
  const { vmid, newScsi0, shouldReboot, runTrim } = args;
  // Bash single-quote the new spec: escape any single quote inside.
  const quoted = `'${newScsi0.replace(/'/g, `'\\''`)}'`;
  const trimBlock = runTrim
    ? `
echo "RUN_TRIM=1"
trim_out="$(qm guest exec ${vmid} -- fstrim -v / 2>&1 || true)"
echo "TRIM_OUT_BEGIN"
echo "${"${trim_out}"}"
echo "TRIM_OUT_END"
`
    : `echo "RUN_TRIM=0"\n`;
  const rebootBlock = shouldReboot
    ? `
echo "REBOOT_BEGIN"
if ! qm reboot ${vmid} 2>&1; then
  echo "QM_REBOOT_FAILED"
  exit 0
fi
echo "REBOOT_ISSUED"
# Wait up to 120s for guest-agent to ping back.
deadline=$((SECONDS+120))
agent_ok=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if qm guest cmd ${vmid} ping >/dev/null 2>&1; then
    agent_ok=1
    break
  fi
  sleep 3
done
if [ "$agent_ok" = "1" ]; then
  echo "AGENT_OK"
else
  echo "AGENT_TIMEOUT"
fi
`
    : `echo "NO_REBOOT"\n`;
  // qm set output goes to stderr in some Proxmox versions; merge so we
  // see it in stdout for the report.
  return `#!/usr/bin/env bash
set -uo pipefail
echo "QM_SET_BEGIN"
if ! qm set ${vmid} --scsi0 ${quoted} 2>&1; then
  echo "QM_SET_FAILED"
  exit 0
fi
echo "QM_SET_OK"
${rebootBlock}${shouldReboot ? trimBlock : ""}pool_pct="$(lvs --noheadings --units g -o data_percent vg0/data 2>/dev/null | awk '{print $1}')"
echo "POOL_AFTER=${"${pool_pct:-}"}"
vm_pct="$(lvs --noheadings --units g -o data_percent "vg0/vm-${vmid}-disk-0" 2>/dev/null | awk '{print $1}')"
echo "VM_AFTER=${"${vm_pct:-}"}"
`;
}

interface InspectedVm {
  vmid: number;
  status: "running" | "stopped" | "missing" | "unknown";
  scsi0: string | null;
  vmDataPct: number | null;
}

interface HostInspectResult {
  poolBefore: number | null;
  vms: Map<number, InspectedVm>;
}

function parseFloatOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHostInspect(stdout: string, vmids: number[]): HostInspectResult {
  const poolMatch = stdout.match(/^POOL_BEFORE=(.*)$/m);
  const poolBefore = parseFloatOrNull(poolMatch?.[1]);
  const vms = new Map<number, InspectedVm>();
  for (const vmid of vmids) {
    const re = new RegExp(`=== BEGIN ${vmid} ===\\s*([\\s\\S]*?)=== END ${vmid} ===`);
    const m = stdout.match(re);
    const block = m?.[1] ?? "";
    if (/STATUS=missing/.test(block)) {
      vms.set(vmid, { vmid, status: "missing", scsi0: null, vmDataPct: null });
      continue;
    }
    const statusLine = block.match(/^STATUS_LINE=(.*)$/m)?.[1] ?? "";
    let status: InspectedVm["status"] = "unknown";
    if (/status:\s*running/i.test(statusLine)) status = "running";
    else if (/status:\s*stopped/i.test(statusLine)) status = "stopped";
    const scsi0Match = block.match(/^SCSI0=(.*)$/m);
    const scsi0 = scsi0Match?.[1]?.trim() ? scsi0Match[1].trim() : null;
    const vmPct = parseFloatOrNull(block.match(/^VM_DATA_PCT=(.*)$/m)?.[1]);
    vms.set(vmid, { vmid, status, scsi0, vmDataPct: vmPct });
  }
  return { poolBefore, vms };
}

interface ApplyParsed {
  qmSetOk: boolean;
  qmSetFailed: boolean;
  rebootIssued: boolean;
  qmRebootFailed: boolean;
  agentOk: boolean;
  agentTimeout: boolean;
  noReboot: boolean;
  trimOut: string | null;
  poolAfter: number | null;
  vmAfter: number | null;
}

function parseApplyOutput(stdout: string): ApplyParsed {
  return {
    qmSetOk: /\bQM_SET_OK\b/.test(stdout),
    qmSetFailed: /\bQM_SET_FAILED\b/.test(stdout),
    rebootIssued: /\bREBOOT_ISSUED\b/.test(stdout),
    qmRebootFailed: /\bQM_REBOOT_FAILED\b/.test(stdout),
    agentOk: /\bAGENT_OK\b/.test(stdout),
    agentTimeout: /\bAGENT_TIMEOUT\b/.test(stdout),
    noReboot: /\bNO_REBOOT\b/.test(stdout),
    trimOut:
      stdout.match(/TRIM_OUT_BEGIN\s*\n([\s\S]*?)\nTRIM_OUT_END/)?.[1]?.trim() || null,
    poolAfter: parseFloatOrNull(stdout.match(/^POOL_AFTER=(.*)$/m)?.[1]),
    vmAfter: parseFloatOrNull(stdout.match(/^VM_AFTER=(.*)$/m)?.[1]),
  };
}

async function runVmsOnHost(
  hostSlug: string,
  planned: PlannedVm[],
  args: Args,
): Promise<{ results: VmResult[]; hostError: string | null; poolBefore: number | null }> {
  const hostEnv = resolveProxmoxHostEnv({ hostSlug, failClosed: true }, process.env);
  const vmids = planned.map((p) => p.vmid);

  const inspect = await runProxmoxHostScript(buildHostInspectScript(vmids), hostEnv, {
    timeoutMs: 60_000,
  });
  if (!inspect.ok) {
    return {
      results: planned.map((p) => ({
        instanceId: p.instanceId,
        name: p.name,
        hostSlug: p.hostSlug,
        vmid: p.vmid,
        outcome: "vm-missing" as VmOutcome,
        originalScsi0: null,
        plannedScsi0: null,
        poolBefore: null,
        poolAfter: null,
        vmBefore: null,
        vmAfter: null,
        detail: `host inspect failed: ${inspect.error || inspect.stderr}`,
      })),
      hostError: inspect.error || inspect.stderr || "host inspect failed",
      poolBefore: null,
    };
  }
  const inspectResult = parseHostInspect(inspect.stdout, vmids);

  const processOne = async (p: PlannedVm): Promise<VmResult> => {
    const inspected = inspectResult.vms.get(p.vmid);
    const base: VmResult = {
      instanceId: p.instanceId,
      name: p.name,
      hostSlug: p.hostSlug,
      vmid: p.vmid,
      outcome: "no-scsi0",
      originalScsi0: null,
      plannedScsi0: null,
      poolBefore: inspectResult.poolBefore,
      poolAfter: null,
      vmBefore: inspected?.vmDataPct ?? null,
      vmAfter: null,
    };
    if (!inspected || inspected.status === "missing") {
      return { ...base, outcome: "vm-missing", detail: "VMID not present on host" };
    }
    if (p.vmid >= TEMPLATE_VMID_MIN) {
      return { ...base, outcome: "is-template", detail: "vmid >= 9000 — template range, skipped" };
    }
    if (!inspected.scsi0) {
      return { ...base, outcome: "no-scsi0", detail: "no scsi0 in qm config" };
    }
    const rewrite = rewriteScsi0(inspected.scsi0);
    const baseWithSpec: VmResult = {
      ...base,
      originalScsi0: inspected.scsi0,
      plannedScsi0: rewrite.rewritten,
    };
    if (!rewrite.changed) {
      return { ...baseWithSpec, outcome: "already-threads" };
    }
    if (args.dryRun) {
      return { ...baseWithSpec, outcome: "would-update" };
    }

    const shouldReboot = inspected.status === "running";
    const runTrim = shouldReboot && !args.noTrim;
    const apply = await runProxmoxHostScript(
      buildApplyScript({
        vmid: p.vmid,
        newScsi0: rewrite.rewritten,
        shouldReboot,
        runTrim,
      }),
      hostEnv,
      // qm set + reboot + 120s agent wait + trim: 240s ceiling.
      { timeoutMs: 240_000 },
    );
    if (!apply.ok) {
      return {
        ...baseWithSpec,
        outcome: "qm-set-failed",
        detail: `apply script transport failed: ${apply.error || apply.stderr}`,
      };
    }
    const parsed = parseApplyOutput(apply.stdout);
    if (parsed.qmSetFailed || !parsed.qmSetOk) {
      return { ...baseWithSpec, outcome: "qm-set-failed", detail: apply.stdout.slice(-400) };
    }
    if (parsed.noReboot) {
      return {
        ...baseWithSpec,
        outcome: "updated-no-reboot",
        poolAfter: parsed.poolAfter,
        vmAfter: parsed.vmAfter,
        detail: "VM was stopped — qm set applied, takes effect on next start",
      };
    }
    if (parsed.qmRebootFailed) {
      return { ...baseWithSpec, outcome: "qm-reboot-failed", detail: apply.stdout.slice(-400) };
    }
    if (parsed.agentTimeout) {
      return {
        ...baseWithSpec,
        outcome: "guest-agent-timeout",
        poolAfter: parsed.poolAfter,
        vmAfter: parsed.vmAfter,
        detail: "guest agent did not ping within 120s — re-run targeted at this VM",
      };
    }
    if (runTrim && parsed.trimOut && /not supported|failed|error/i.test(parsed.trimOut)) {
      return {
        ...baseWithSpec,
        outcome: "trim-failed",
        poolAfter: parsed.poolAfter,
        vmAfter: parsed.vmAfter,
        detail: parsed.trimOut.slice(0, 240),
      };
    }
    return {
      ...baseWithSpec,
      outcome: runTrim ? "updated" : "trim-skipped",
      poolAfter: parsed.poolAfter,
      vmAfter: parsed.vmAfter,
      detail: parsed.trimOut ? parsed.trimOut.split("\n").pop() || undefined : undefined,
    };
  };

  const results: VmResult[] = [];
  const concurrency = Math.min(args.maxParallel, planned.length || 1);
  for (let i = 0; i < planned.length; i += concurrency) {
    const slice = planned.slice(i, i + concurrency);
    const sliceResults = await Promise.all(slice.map(processOne));
    results.push(...sliceResults);
  }
  return { results, hostError: null, poolBefore: inspectResult.poolBefore };
}

function outcomeTag(outcome: VmOutcome): string {
  switch (outcome) {
    case "already-threads":
      return "= already-threads";
    case "would-update":
      return "~ would-update";
    case "updated":
      return "+ UPDATED";
    case "updated-no-reboot":
      return "+ UPDATED (stopped)";
    case "trim-skipped":
      return "+ UPDATED (trim-skipped)";
    case "no-scsi0":
      return "? no-scsi0";
    case "is-template":
      return "· template";
    case "vm-missing":
      return "? vm-missing";
    case "guest-agent-timeout":
      return "! AGENT-TIMEOUT";
    case "qm-set-failed":
      return "x qm-set-failed";
    case "qm-reboot-failed":
      return "x qm-reboot-failed";
    case "trim-failed":
      return "x trim-failed";
  }
}

function printSummary(results: VmResult[], args: Args): void {
  console.log("");
  console.log("=== Summary ===");
  console.log(`mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1;
    return acc;
  }, {});
  for (const [outcome, count] of Object.entries(counts).sort()) {
    console.log(`  ${outcome}: ${count}`);
  }

  console.log("");
  console.log("=== Per-VM detail ===");
  console.log(
    [
      "host",
      "vmid",
      "instance",
      "outcome",
      "pool%before→after",
      "vm%before→after",
      "name",
    ].join("\t"),
  );
  for (const r of results) {
    const pool =
      r.poolBefore != null
        ? `${r.poolBefore}${r.poolAfter != null ? `→${r.poolAfter}` : ""}`
        : "-";
    const vm =
      r.vmBefore != null
        ? `${r.vmBefore}${r.vmAfter != null ? `→${r.vmAfter}` : ""}`
        : "-";
    console.log(
      [
        r.hostSlug,
        r.vmid,
        r.instanceId.slice(0, 8),
        outcomeTag(r.outcome),
        pool,
        vm,
        (r.name || "").slice(0, 32),
      ].join("\t"),
    );
    if (r.detail) console.log(`    detail: ${r.detail}`);
  }

  const changed = results.filter(
    (r) => r.outcome === "would-update" || r.outcome === "updated" || r.outcome === "updated-no-reboot" || r.outcome === "trim-skipped",
  );
  if (changed.length > 0) {
    console.log("");
    console.log("=== Rollback hints (original scsi0 per VM) ===");
    for (const r of changed) {
      if (!r.originalScsi0) continue;
      console.log(`  ${r.hostSlug} vmid=${r.vmid}: qm set ${r.vmid} --scsi0 '${r.originalScsi0}'`);
    }
  }
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });
  const args = parseArgs();
  const supabase = createSupabase();

  if (args.apply) {
    console.log(
      "[fleet-fix-aio-threads] APPLY MODE: rewriting scsi0 → aio=threads.",
    );
    console.log(
      "[fleet-fix-aio-threads] Each running VM will be rebooted (~30s downtime).",
    );
  } else {
    console.log("[fleet-fix-aio-threads] dry-run mode (default). Pass --apply to execute.");
  }

  const rows = await loadActiveInstances(supabase);
  const plannedAll: PlannedVm[] = [];
  let skippedNoInfra = 0;
  let skippedTemplateRange = 0;
  for (const row of rows) {
    if (args.instanceFilter && row.id !== args.instanceFilter) continue;
    const planned = planVm(row);
    if (!planned) {
      skippedNoInfra += 1;
      continue;
    }
    if (planned.vmid >= TEMPLATE_VMID_MIN) {
      skippedTemplateRange += 1;
      continue;
    }
    if (args.hostFilter && planned.hostSlug !== args.hostFilter) continue;
    plannedAll.push(planned);
  }

  console.log(
    `Discovered ${plannedAll.length} candidate VM(s) across ${
      new Set(plannedAll.map((p) => p.hostSlug)).size
    } host(s). Skipped: no-infra=${skippedNoInfra} template-range=${skippedTemplateRange}.`,
  );

  if (plannedAll.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const allHosts = resolveProxmoxTargetCandidateIds();
  const targetHosts = (args.hostFilter ? [args.hostFilter] : allHosts).filter((h) =>
    plannedAll.some((p) => p.hostSlug === h),
  );
  if (args.hostFilter && !allHosts.includes(args.hostFilter)) {
    console.warn(
      `[fleet-fix-aio-threads] Warning: --host ${args.hostFilter} is not in HERMES_PROXMOX_TARGETS (${allHosts.join(",")}). Proceeding anyway.`,
    );
  }

  const allResults: VmResult[] = [];
  // Hosts are processed strictly serially — never cross-host parallel,
  // even when --max-parallel > 1 is set.
  for (const host of targetHosts) {
    const hostPlanned = plannedAll.filter((p) => p.hostSlug === host);
    console.log("");
    console.log(`=== ${host} (${hostPlanned.length} VMs, max-parallel=${args.maxParallel}) ===`);
    const { results, hostError, poolBefore } = await runVmsOnHost(host, hostPlanned, args);
    if (hostError) {
      console.error(`[${host}] host inspect failed: ${hostError}`);
    } else {
      console.log(`[${host}] pool data%: ${poolBefore ?? "?"}`);
    }
    for (const r of results) {
      console.log(
        `  ${outcomeTag(r.outcome).padEnd(28)} vmid=${r.vmid}  ${r.instanceId.slice(0, 8)}  ${(r.name || "").slice(0, 28)}`,
      );
    }
    allResults.push(...results);
  }

  printSummary(allResults, args);

  const fatal = allResults.filter((r) =>
    ["qm-set-failed", "qm-reboot-failed", "guest-agent-timeout", "trim-failed"].includes(r.outcome),
  );
  if (fatal.length > 0 && args.apply) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[fleet-fix-aio-threads] fatal:", err);
    process.exitCode = 1;
  });
}
