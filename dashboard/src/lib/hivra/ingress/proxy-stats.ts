// What the host wake proxy says about its computers, and the one host script
// the sleep sweep runs per host to read it. Pure: nothing here talks to the
// network or the database, and nothing here imports server-only code.
//
// The proxy's root helper answers `ctl stats [vmid]` with one JSON line (see
// provisioner/hivra-wake-proxy.py, Helper.stats):
//   {"ok":true,"forwarder":true,"vms":{"<vmid>":{"route":true,"inflight":0,
//    "streams":0,"draining":false,"last_any_at":<epoch s|null>,
//    "last_authed_at":<epoch s|null>,"wakes":[{"at":<epoch s>,"from":"ticket",
//    "woke":"nap","ms":12}]}}}
// with the vmid's own fields copied to the top level when one vmid is asked.
//
// Nothing host-specific lives here: the CLI and marker paths are the same on
// every host. A reader that cannot parse a line treats the proxy as unknown,
// and unknown never lets an agent sleep.

import { INGRESS_PROXY_PROGRAM, assertVmid } from "@/lib/hivra/ingress/route-file";

export const INGRESS_STATS_PREFIX = "HIVRA_INGRESS_STATS ";
export const INGRESS_MARKER_PREFIX = "HIVRA_INGRESS_MARKER ";
/** Where the proxy keeps its nap markers (napped-<vmid>, holding the QEMU pid). */
export const INGRESS_STATE_DIR = "/run/hivra-ingress-state";
/** The proxy's control CLI, run as root on the host. */
export const INGRESS_PROXY_CLI = INGRESS_PROXY_PROGRAM;

const MAX_STATS_BYTES = 262_144;
const MAX_WAKES = 64;
const MAX_VMS = 4096;
const EPOCH_MAX = 4_102_444_800; // 2100-01-01

export interface IngressProxyWake {
  /** Host wall clock, epoch ms. */
  atMs: number;
  from: string;
  woke: "nap" | "already";
  ms: number;
}

export interface IngressProxyVmStats {
  route: boolean;
  inflight: number;
  streams: number;
  draining: boolean;
  /** Host wall clock, epoch ms, or null. */
  lastAnyAtMs: number | null;
  lastAuthedAtMs: number | null;
  wakes: IngressProxyWake[];
}

export interface IngressProxyStats {
  forwarder: boolean;
  vms: Map<number, IngressProxyVmStats>;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000 ? (value as number) : null;
}

function epochMs(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > EPOCH_MAX) return undefined;
  return Math.round(value * 1000);
}

function readWakes(value: unknown): IngressProxyWake[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WAKES) return null;
  const out: IngressProxyWake[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const w = item as Record<string, unknown>;
    const atMs = epochMs(w.at);
    if (typeof atMs !== "number") return null;
    if (w.woke !== "nap" && w.woke !== "already") return null;
    const from = typeof w.from === "string" && /^[a-z_]{1,16}$/.test(w.from) ? w.from : "unknown";
    out.push({ atMs, from, woke: w.woke, ms: count(w.ms) ?? 0 });
  }
  return out;
}

function readVm(value: unknown): IngressProxyVmStats | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const inflight = count(v.inflight ?? 0);
  const streams = count(v.streams ?? 0);
  const lastAnyAtMs = epochMs(v.last_any_at);
  const lastAuthedAtMs = epochMs(v.last_authed_at);
  const wakes = readWakes(v.wakes);
  if (inflight === null || streams === null || lastAnyAtMs === undefined || lastAuthedAtMs === undefined || !wakes) return null;
  return {
    route: v.route === true,
    inflight,
    streams,
    draining: v.draining === true,
    lastAnyAtMs,
    lastAuthedAtMs,
    wakes,
  };
}

/** Strict read of one `ctl stats` answer. null when it is not an ok answer of the expected shape. */
export function parseIngressStatsJson(text: string): IngressProxyStats | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_STATS_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || !v.vms || typeof v.vms !== "object" || Array.isArray(v.vms)) return null;
  const entries = Object.entries(v.vms as Record<string, unknown>);
  if (entries.length > MAX_VMS) return null;
  const vms = new Map<number, IngressProxyVmStats>();
  for (const [key, raw] of entries) {
    if (!/^[0-9]{3,9}$/.test(key)) return null;
    const vm = readVm(raw);
    if (!vm) return null;
    vms.set(Number(key), vm);
  }
  return { forwarder: v.forwarder === true, vms };
}

function prefixedLines(stdout: string, prefix: string): string[] {
  if (typeof stdout !== "string") return [];
  return stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.startsWith(prefix));
}

/** The one stats line in a host script's output. null when there is not exactly one that parses. */
export function parseIngressStatsLine(stdout: string): IngressProxyStats | null {
  const lines = prefixedLines(stdout, INGRESS_STATS_PREFIX);
  if (lines.length !== 1) return null;
  return parseIngressStatsJson(lines[0].slice(INGRESS_STATS_PREFIX.length));
}

/** One VM's stats from the stats line, or null when the line is missing, bad, or does not name it. */
export function parseIngressVmStats(stdout: string, vmid: number): IngressProxyVmStats | null {
  return parseIngressStatsLine(stdout)?.vms.get(vmid) ?? null;
}

/** Which of the asked VMs still have a nap marker on the host. Missing or odd lines are left out. */
export function parseIngressMarkers(stdout: string): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const line of prefixedLines(stdout, INGRESS_MARKER_PREFIX)) {
    const match = /^([0-9]{3,9}) ([01])$/.exec(line.slice(INGRESS_MARKER_PREFIX.length));
    if (!match) continue;
    const vmid = Number(match[1]);
    if (out.has(vmid)) {
      out.delete(vmid);
      continue;
    }
    out.set(vmid, match[2] === "1");
  }
  return out;
}

/**
 * The shell that asks the proxy for stats and prints one HIVRA_INGRESS_STATS
 * line (empty when the proxy did not answer). `vmidExpr` is what goes after
 * `ctl stats`: a quoted vmid, or nothing for every computer.
 */
export function ingressStatsShell(vmidExpr: string): string {
  return `INGRESS_STATS="$(command timeout -k 2 8 python3 -I -B ${INGRESS_PROXY_CLI} ctl stats${vmidExpr ? ` ${vmidExpr}` : ""} 2>/dev/null </dev/null)" || true
printf '\\n${INGRESS_STATS_PREFIX}%s\\n' "$(printf '%s' "$INGRESS_STATS" | head -n 1 | head -c ${MAX_STATS_BYTES})"`;
}

/**
 * The per-minute read for one host: the proxy's stats for every computer it
 * serves (with its recent wakes), and whether each asked VM still carries a
 * nap marker. Read-only: it never touches a VM, a route or a marker.
 */
export function buildIngressSweepHostScript(vmids: readonly number[]): string {
  if (!Array.isArray(vmids) || vmids.length === 0 || vmids.length > 200) throw new Error("Invalid ingress sweep VMIDs.");
  const list = [...new Set(vmids.map((vmid) => assertVmid(vmid)))];
  return `set -euo pipefail
export LC_ALL=C
${ingressStatsShell("")}
for VMID in ${list.join(" ")}; do
  if [ -e "${INGRESS_STATE_DIR}/napped-$VMID" ]; then M=1; else M=0; fi
  printf '${INGRESS_MARKER_PREFIX}%s %s\\n' "$VMID" "$M"
done
`;
}

/**
 * The latest wake the proxy made after `sinceMs` (the server's record of when
 * the nap was recorded), or null. Strictly after: a wake that might be from
 * before the nap is never counted, so a clock skew only delays the catch-up to
 * the slower drift check.
 */
export function proxyWakeAfter(vm: IngressProxyVmStats | null | undefined, sinceMs: number): IngressProxyWake | null {
  if (!vm || !Number.isFinite(sinceMs)) return null;
  let latest: IngressProxyWake | null = null;
  for (const wake of vm.wakes) {
    if (wake.atMs > sinceMs && (!latest || wake.atMs > latest.atMs)) latest = wake;
  }
  return latest;
}
