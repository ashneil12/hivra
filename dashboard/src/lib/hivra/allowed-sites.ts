// Allowed sites: an owner's list of the internet sites one agent's computer
// may reach, enforced on its Proxmox host (scripts/proxmox-host-vm-egress-allowlist.sh).
//
// The dashboard stores the list (hivra_agent_allowed_sites) and writes it to
// the host as /etc/hivra/egress/<vmid>.json, together with the sites Hivra
// itself needs for the computer to keep working. The host renders one
// nftables table from those files every five minutes.
//
// Unreleased: off unless NEXT_PUBLIC_HIVRA_ALLOWED_SITES is "true".

import { shellQuote } from "./proxmox-target";

type EnvLike = Record<string, string | undefined>;

export const MAX_ALLOWED_SITES = 100;
export const EGRESS_RESULT_PREFIX = "HIVRA_EGRESS_RESULT ";
export const EGRESS_POLICY_DIR = "/etc/hivra/egress";
export const EGRESS_ENFORCER_PATH = "/usr/local/sbin/hivra-vm-egress";

/**
 * Cloudflare Tunnel's edge ranges (region1/region2.v2.argotunnel.com), which a
 * computer's own connector dials to keep its web address up.
 */
export const CLOUDFLARE_TUNNEL_RANGES = ["198.41.192.0/24", "198.41.200.0/24"] as const;

export function allowedSitesEnabled(env: EnvLike = process.env): boolean {
  return env.NEXT_PUBLIC_HIVRA_ALLOWED_SITES === "true";
}

const HOST_NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export type SiteParse = { ok: true; site: string } | { ok: false; input: string; reason: string };

/**
 * One entry as the owner typed it: a URL, a host name, or a public IPv4
 * address or range. Returns the form the host understands (lower-case host
 * name, address or CIDR), or why it can't be used.
 */
export function parseSite(raw: string): SiteParse {
  const input = String(raw ?? "").trim();
  if (!input) return { ok: false, input, reason: "empty" };
  let value = input.toLowerCase();
  // Accept a pasted URL: keep only its host.
  const url = /^[a-z][a-z0-9+.-]*:\/\//.test(value) ? value : null;
  if (url) {
    try {
      value = new URL(url).hostname;
    } catch {
      return { ok: false, input, reason: "not a web address" };
    }
  }
  value = value.replace(/\.$/, "");
  if (value.startsWith("*.")) return { ok: false, input, reason: "wildcards aren't supported; list each address" };
  const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(value);
  if (cidr) {
    const bits = Number(cidr[2]);
    if (!IPV4.test(cidr[1]) || bits < 8 || bits > 32) return { ok: false, input, reason: "not a valid address range" };
    if (isPrivateIpv4(cidr[1])) return { ok: false, input, reason: "private addresses can't be listed" };
    return { ok: true, site: value };
  }
  if (IPV4.test(value)) {
    if (isPrivateIpv4(value)) return { ok: false, input, reason: "private addresses can't be listed" };
    return { ok: true, site: value };
  }
  // A bare host with a path ("github.com/foo") keeps only the host.
  value = value.split("/")[0].split(":")[0];
  if (!HOST_NAME.test(value)) return { ok: false, input, reason: "not a site address" };
  return { ok: true, site: value };
}

export function normalizeSites(raw: readonly string[]): { sites: string[]; rejected: Array<{ input: string; reason: string }> } {
  const sites: string[] = [];
  const rejected: Array<{ input: string; reason: string }> = [];
  for (const entry of raw) {
    const parsed = parseSite(entry);
    if (!parsed.ok) {
      if (parsed.reason !== "empty") rejected.push({ input: parsed.input, reason: parsed.reason });
      continue;
    }
    if (!sites.includes(parsed.site)) sites.push(parsed.site);
  }
  return { sites, rejected };
}

/**
 * What every limited computer may still reach so it keeps working: this Hivra
 * deployment (its connection service, activity reports and managed AI all go
 * there), Cloudflare Tunnel, and anything listed in HIVRA_EGRESS_REQUIRED_EXTRA
 * (comma separated host names, addresses or ranges).
 */
export function requiredSites(env: EnvLike = process.env): string[] {
  const out: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    const parsed = parseSite(value);
    if (parsed.ok && !out.includes(parsed.site)) out.push(parsed.site);
  };
  add(env.NEXT_PUBLIC_APP_URL);
  for (const range of CLOUDFLARE_TUNNEL_RANGES) add(range);
  for (const item of (env.HIVRA_EGRESS_REQUIRED_EXTRA ?? "").split(",")) add(item.trim());
  return out;
}

export interface EgressPolicy {
  version: 1;
  vmid: number;
  binding_tag: string;
  sites: string[];
  required: string[];
}

export function buildEgressPolicy(input: { vmid: number; bindingTag: string; sites: string[]; env?: EnvLike }): EgressPolicy {
  return {
    version: 1,
    vmid: input.vmid,
    binding_tag: input.bindingTag,
    sites: input.sites.slice(0, MAX_ALLOWED_SITES),
    required: requiredSites(input.env),
  };
}

/**
 * Writes (mode "set") or removes (mode "remove") one computer's policy file on
 * its host, then applies the table when the host has the enforcer installed.
 * The policy JSON arrives on stdin. Changes nothing unless the VM carries the
 * agent's binding tag. Prints one HIVRA_EGRESS_RESULT line.
 */
export function buildAllowedSitesHostScript(input: {
  vmid: number;
  bindingTag: string;
  mode: "set" | "remove";
  /** Tests only. */
  paths?: { policyDir: string; enforcer: string };
}): string {
  if (!Number.isInteger(input.vmid) || input.vmid < 100 || input.vmid > 999_999_999) throw new Error("Invalid VMID.");
  if (!/^hivra-bind-[a-f0-9]{32}$/.test(input.bindingTag)) throw new Error("Invalid binding tag.");
  if (input.mode !== "set" && input.mode !== "remove") throw new Error("Invalid mode.");
  return `set -euo pipefail
VMID=${input.vmid}
EXPECTED_BINDING_TAG=${shellQuote(input.bindingTag)}
MODE=${input.mode}
POLICY_DIR=${shellQuote(input.paths?.policyDir ?? EGRESS_POLICY_DIR)}
ENFORCER=${shellQuote(input.paths?.enforcer ?? EGRESS_ENFORCER_PATH)}
finish() {
  printf '%s{"ok":%s,"vmid":%s,"reason":"%s"}\\n' ${shellQuote(EGRESS_RESULT_PREFIX)} "$1" "$VMID" "$2"
  exit 0
}
POLICY="$(head -c 65536)"
CONFIG="$(timeout -k 5 30 qm config "$VMID" </dev/null 2>/dev/null)" || finish false vm_missing
printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null \\
  || finish false binding_mismatch
install -d -m 0700 "$POLICY_DIR"
if [ "$MODE" = remove ]; then
  rm -f -- "$POLICY_DIR/$VMID.json"
else
  TMP="$(mktemp "$POLICY_DIR/.policy.XXXXXX")"
  printf '%s\\n' "$POLICY" > "$TMP"
  chmod 0600 "$TMP"
  mv -f -- "$TMP" "$POLICY_DIR/$VMID.json"
fi
[ -x "$ENFORCER" ] || finish true saved_not_enforced
"$ENFORCER" --apply --quiet </dev/null >/dev/null 2>&1 || finish false apply_failed
finish true applied
`;
}

export type EgressReceipt = { ok: boolean; vmid: number; reason: string };

export function parseEgressReceipt(stdout: string, expectedVmid: number): EgressReceipt | null {
  const lines = (stdout ?? "").split("\n").filter((line) => line.startsWith(EGRESS_RESULT_PREFIX));
  if (lines.length !== 1) return null;
  try {
    const row = JSON.parse(lines[0].slice(EGRESS_RESULT_PREFIX.length)) as Partial<EgressReceipt>;
    if (typeof row.ok !== "boolean" || row.vmid !== expectedVmid || typeof row.reason !== "string" || !/^[a-z_]{1,40}$/.test(row.reason)) return null;
    return row as EgressReceipt;
  } catch {
    return null;
  }
}

/** The stored state the host's answer leads to, and a plain-English line for the owner. */
export function applyOutcome(receipt: EgressReceipt | null): { state: "applied" | "saved" | "failed"; error: string | null } {
  if (!receipt) return { state: "failed", error: "Hivra couldn't reach this computer's server. Your list is saved; save again to retry." };
  if (receipt.ok && receipt.reason === "applied") return { state: "applied", error: null };
  if (receipt.ok && receipt.reason === "saved_not_enforced") {
    return { state: "saved", error: "Your list is saved on this computer's server and takes effect once that server supports allowed sites." };
  }
  if (receipt.reason === "binding_mismatch" || receipt.reason === "vm_missing") {
    return { state: "failed", error: "This computer couldn't be confirmed on its server, so nothing was changed there." };
  }
  return { state: "failed", error: "The server couldn't apply the list. Your list is saved; save again to retry." };
}
