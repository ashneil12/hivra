// Live usage and uptime for a Proxmox computer (Hivra Cloud, My server and
// prepared computers), read from its host in one read-only script.
//
// Why these sources: a one-shot `qm status --verbose` or
// `pvesh .../status/current` reports no CPU (PVE derives CPU from two samples
// in one process), so CPU, memory, uptime and power state come from
// `pvesh get /cluster/resources`, which pvestatd keeps current. The disk size
// comes from `qm config`, and the filesystem's use from the guest agent
// (`qm guest cmd <vmid> get-fsinfo`) when it answers.
//
// The script takes no lock and no operation lease, changes nothing, and
// writes no file. It checks the computer's identity before it prints anything
// (the ownership binding tag; for an older Hivra Cloud computer without one,
// its exact VM name; for a prepared computer, its claim marker too), and a
// Perl filter on the host keeps one whitelisted line, so no other computer's
// data ever leaves the host. Perl is used because every Proxmox host has it
// (PVE itself is Perl, with JSON::PP in core); python3 is not guaranteed on
// My server hosts.

import "server-only";

import { z } from "zod";

import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  COMPUTER_USAGE_STALE_SECONDS,
  type ComputerPowerObserved,
  type ComputerUsageNote,
  type ComputerUsageView,
} from "@/lib/hivra/computer-usage-contract";

/** The host directory holding this node's VM configs. Tests point it elsewhere. */
export const PVE_QEMU_CONFIG_DIR = "/etc/pve/qemu-server";

export const USAGE_LINE_PREFIX = "HIVRA_USAGE_V1 ";
export const USAGE_VM_MISSING = "HIVRA_USAGE_VM_MISSING";
export const USAGE_BINDING_MISMATCH = "HIVRA_USAGE_BINDING_MISMATCH";
/** The one output line is small; anything bigger is not ours. */
export const USAGE_LINE_MAX_BYTES = 8 * 1024;

const BINDING_TAG = /^hivra-bind-[a-f0-9]{32}$/;
const LEGACY_NAME = /^hivra-cc-\d{3,9}$/;
const PREPARED_NAME = /^hivra-(?:omarchy|windows)-canary$/;
const PREPARED_MARKER = /^hivra-(?:omarchy|windows)-operation(?::|%3A)[0-9a-f-]{36}$/;

export interface HivraComputerUsageIdentity {
  vmid: number;
  /** The row's ownership binding tag, when the row is enforced. */
  bindingTag: string | null;
  /**
   * An older Hivra Cloud computer without a binding tag: its exact VM name
   * (hivra-cc-<vmid>), the same host+VMID authority Stop accepts, plus a name.
   */
  legacyName: string | null;
  /** A prepared computer: its claim marker (either encoding) and VM name. */
  prepared: { encodedMarker: string; plainMarker: string; name: string } | null;
}

/**
 * The read-only usage script for one computer. Throws unless at least one
 * identity check will run, so the host is never read for an unverified VM.
 */
export function buildHivraComputerUsageScript(identity: HivraComputerUsageIdentity): string {
  const { vmid, bindingTag, legacyName, prepared } = identity;
  if (!Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new Error("usage_identity_invalid");
  if (bindingTag !== null && !BINDING_TAG.test(bindingTag)) throw new Error("usage_identity_invalid");
  if (legacyName !== null && (!LEGACY_NAME.test(legacyName) || legacyName !== `hivra-cc-${vmid}`)) throw new Error("usage_identity_invalid");
  if (prepared !== null && (!PREPARED_NAME.test(prepared.name)
    || !PREPARED_MARKER.test(prepared.encodedMarker) || !PREPARED_MARKER.test(prepared.plainMarker))) {
    throw new Error("usage_identity_invalid");
  }
  if (!bindingTag && !legacyName && !prepared) throw new Error("usage_identity_missing");

  return `set -uo pipefail
export LC_ALL=C
VMID=${vmid}
EXPECTED_BINDING_TAG=${shellQuote(bindingTag ?? "")}
EXPECTED_NAME=${shellQuote(legacyName ?? prepared?.name ?? "")}
EXPECTED_MARKER_ENCODED=${shellQuote(prepared?.encodedMarker ?? "")}
EXPECTED_MARKER_PLAIN=${shellQuote(prepared?.plainMarker ?? "")}
if [ ! -e ${shellQuote(PVE_QEMU_CONFIG_DIR)}/"$VMID.conf" ]; then
  echo ${USAGE_VM_MISSING}
  exit 0
fi
# Both reads start now and run while the identity is checked; nothing they
# return is printed unless it passes.
exec 4< <(exec 2>/dev/null </dev/null; timeout 10 pvesh get /cluster/resources --type vm --output-format json)
exec 5< <(exec 2>/dev/null </dev/null; timeout 6 qm guest cmd "$VMID" get-fsinfo; printf '\\nHIVRA_QGA_RC %s\\n' "$?")
if ! CONFIG="$(qm config "$VMID" </dev/null)"; then
  echo "the computer's configuration could not be read" >&2
  exit 1
fi
if [ -n "$EXPECTED_BINDING_TAG" ]; then
  TAGS="$(printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq -- "$EXPECTED_BINDING_TAG" \\
    || { echo ${USAGE_BINDING_MISMATCH}; exit 3; }
fi
if [ -n "$EXPECTED_NAME" ]; then
  printf '%s\\n' "$CONFIG" | grep -Fxq -- "name: $EXPECTED_NAME" || { echo ${USAGE_BINDING_MISMATCH}; exit 3; }
fi
if [ -n "$EXPECTED_MARKER_PLAIN" ]; then
  case "$CONFIG" in *"$EXPECTED_MARKER_ENCODED"*|*"$EXPECTED_MARKER_PLAIN"*) ;; *) echo ${USAGE_BINDING_MISMATCH}; exit 3 ;; esac
fi
exec 6< <(printf '%s\\n' "$CONFIG")
HIVRA_VMID="$VMID" HIVRA_NODE="$(hostname)" /usr/bin/perl -MJSON::PP - <<'HIVRA_USAGE_FILTER'
${USAGE_FILTER}
HIVRA_USAGE_FILTER`;
}

// Reads the config (fd 6), /cluster/resources (fd 4) and the guest agent's
// fsinfo (fd 5), and prints the one line. Only this VMID on this node, and
// only the fields below, are kept.
const USAGE_FILTER = String.raw`use strict;
use warnings;
sub slurp {
  my ($fd) = @_;
  open(my $fh, '<&=', $fd) or return '';
  local $/;
  my $data = <$fh>;
  close($fh);
  return defined($data) ? $data : '';
}
sub num {
  my ($value) = @_;
  return undef unless defined($value) && !ref($value) && $value =~ /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
  return 0 + $value;
}
my $vmid = $ENV{HIVRA_VMID};
my $node = defined($ENV{HIVRA_NODE}) ? $ENV{HIVRA_NODE} : '';
$node =~ s/\s+$//;
$node =~ s/\..*$//s;
my $config = slurp(6);
my $resources = slurp(4);
my $guest = slurp(5);

my %cfg;
for my $line (split /\n/, $config) {
  next unless $line =~ /^([a-z0-9_]+):\s*(.*)$/;
  $cfg{$1} = $2 unless exists $cfg{$1};
}
sub size_bytes {
  my ($spec) = @_;
  return undef unless defined($spec) && $spec !~ /(?:^|,)media=cdrom(?:,|$)/;
  return undef unless $spec =~ /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)(?:,|$)/;
  my %factor = ('' => 1, K => 1024, M => 1024 ** 2, G => 1024 ** 3, T => 1024 ** 4);
  return int($1 * $factor{$2});
}
my @order;
if (defined($cfg{boot}) && $cfg{boot} =~ /(?:^|,)order=([^,]+)/) { @order = split /;/, $1; }
elsif (defined($cfg{bootdisk})) { @order = ($cfg{bootdisk}); }
push @order, qw(scsi0 virtio0 sata0 ide0);
my $disk_bytes;
for my $key (@order) {
  next unless $key =~ /^(?:scsi|virtio|sata|ide)\d+$/;
  my $bytes = size_bytes($cfg{$key});
  if (defined($bytes)) { $disk_bytes = $bytes; last; }
}
my $ostype = defined($cfg{ostype}) && $cfg{ostype} =~ /^[a-z0-9]{1,16}$/ ? $cfg{ostype} : undef;
my $agent = defined($cfg{agent}) && $cfg{agent} =~ /^(?:enabled=)?1(?:,|$)/ ? JSON::PP::true : JSON::PP::false;

my $vm;
my $list = eval { JSON::PP::decode_json($resources) };
my $resources_read = ref($list) eq 'ARRAY' ? JSON::PP::true : JSON::PP::false;
if (ref($list) eq 'ARRAY') {
  for my $entry (@$list) {
    next unless ref($entry) eq 'HASH';
    next unless defined($entry->{type}) && $entry->{type} eq 'qemu';
    next unless defined($entry->{vmid}) && "$entry->{vmid}" eq "$vmid";
    next unless defined($entry->{node}) && $entry->{node} eq $node;
    my $status = defined($entry->{status}) && $entry->{status} =~ /^[a-z]{1,16}$/ ? $entry->{status} : 'unknown';
    $vm = {
      status => $status,
      uptime => num($entry->{uptime}),
      cpu => num($entry->{cpu}),
      maxcpu => num($entry->{maxcpu}),
      mem => num($entry->{mem}),
      maxmem => num($entry->{maxmem}),
      maxdisk => num($entry->{maxdisk}),
    };
    last;
  }
}

my $rc = $guest =~ /HIVRA_QGA_RC (\d+)\s*$/ ? 0 + $1 : 255;
$rc = 255 if $rc > 255;
my $readable = JSON::PP::false;
my $root;
if ($rc == 0) {
  (my $body = $guest) =~ s/\n?HIVRA_QGA_RC \d+\s*$//;
  my $fs = eval { JSON::PP::decode_json($body) };
  if (ref($fs) eq 'ARRAY') {
    $readable = JSON::PP::true;
    for my $entry (@$fs) {
      next unless ref($entry) eq 'HASH';
      my $mount = defined($entry->{mountpoint}) ? $entry->{mountpoint} : '';
      next unless $mount eq '/' || $mount eq "C:\\";
      my $total = num($entry->{'total-bytes'});
      my $used = num($entry->{'used-bytes'});
      next unless defined($total) && defined($used);
      my $type = defined($entry->{type}) && $entry->{type} =~ /^[A-Za-z0-9._-]{1,16}$/ ? $entry->{type} : 'other';
      $root = { mount => $mount, fs => $type, total => $total, used => $used };
      last;
    }
  }
}

my $out = {
  v => 1,
  vm => $vm,
  resources => $resources_read,
  config => {
    cores => num($cfg{cores}),
    memory => num($cfg{memory}),
    balloon => num($cfg{balloon}),
    cpulimit => num($cfg{cpulimit}),
    diskBytes => $disk_bytes,
    ostype => $ostype,
    agent => $agent,
  },
  guest => { rc => $rc, readable => $readable, root => $root },
};
print "HIVRA_USAGE_V1 ", JSON::PP->new->canonical(1)->encode($out), "\n";`;

const count = z.number().finite().nonnegative();

const ProbeSampleSchema = z.object({
  v: z.literal(1),
  vm: z.object({
    status: z.string().regex(/^[a-z]{1,16}$/),
    uptime: count.nullable(),
    // A fraction of maxcpu. A value above 1 is a sampling artefact; clamp it.
    cpu: count.transform((value) => Math.min(1, value)).nullable(),
    maxcpu: count.nullable(),
    mem: count.nullable(),
    maxmem: count.nullable(),
    maxdisk: count.nullable(),
  }).strict().nullable(),
  resources: z.boolean(),
  config: z.object({
    cores: count.nullable(),
    memory: count.nullable(),
    balloon: count.nullable(),
    cpulimit: count.nullable(),
    diskBytes: count.nullable(),
    ostype: z.string().regex(/^[a-z0-9]{1,16}$/).nullable(),
    agent: z.boolean(),
  }).strict(),
  guest: z.object({
    rc: z.number().int().min(0).max(255),
    readable: z.boolean(),
    root: z.object({
      mount: z.enum(["/", "C:\\"]),
      fs: z.string().regex(/^[A-Za-z0-9._-]{1,16}$/),
      total: count,
      used: count,
    }).strict().nullable(),
  }).strict(),
}).strict();

export type HivraUsageProbeSample = z.infer<typeof ProbeSampleSchema>;

export type HivraUsageProbeOutcome =
  | { kind: "sample"; sample: HivraUsageProbeSample }
  | { kind: "missing" }
  | { kind: "binding_mismatch" };

export class HivraUsageParseError extends Error {
  constructor(readonly code: "empty" | "oversized" | "unknown_output" | "invalid_sample") {
    super(`usage output ${code}`);
    this.name = "HivraUsageParseError";
  }
}

/**
 * The host script's stdout, strictly: exactly one known marker or one
 * HIVRA_USAGE_V1 line whose JSON matches the schema. Anything else throws.
 */
export function parseHivraComputerUsageOutput(stdout: string): HivraUsageProbeOutcome {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length === 0) throw new HivraUsageParseError("empty");
  if (lines.length !== 1) throw new HivraUsageParseError("unknown_output");
  const [line] = lines;
  if (line === USAGE_VM_MISSING) return { kind: "missing" };
  if (line === USAGE_BINDING_MISMATCH) return { kind: "binding_mismatch" };
  if (!line.startsWith(USAGE_LINE_PREFIX)) throw new HivraUsageParseError("unknown_output");
  if (Buffer.byteLength(line, "utf8") > USAGE_LINE_MAX_BYTES) throw new HivraUsageParseError("oversized");
  let json: unknown;
  try {
    json = JSON.parse(line.slice(USAGE_LINE_PREFIX.length));
  } catch {
    throw new HivraUsageParseError("invalid_sample");
  }
  const parsed = ProbeSampleSchema.safeParse(json);
  if (!parsed.success) throw new HivraUsageParseError("invalid_sample");
  return { kind: "sample", sample: parsed.data };
}

// ── The stored observation (public.hivra_computer_usage.sample) ─────────────

/** The recorded status when the host was read; a change makes it out of date. */
const RecordedStatusSchema = z.string().regex(/^[a-z_]{1,24}$/);

export const StoredUsageSchema = z.discriminatedUnion("result", [
  z.object({ v: z.literal(1), result: z.literal("sample"), recordedStatus: RecordedStatusSchema, sample: ProbeSampleSchema }).strict(),
  z.object({ v: z.literal(1), result: z.literal("missing"), recordedStatus: RecordedStatusSchema }).strict(),
]);
export type StoredUsage = z.infer<typeof StoredUsageSchema>;

export function storedUsageFor(outcome: HivraUsageProbeOutcome, recordedStatus: string): StoredUsage | null {
  const status = RecordedStatusSchema.safeParse(recordedStatus).success ? recordedStatus : "unknown";
  if (outcome.kind === "sample") return { v: 1, result: "sample", recordedStatus: status, sample: outcome.sample };
  if (outcome.kind === "missing") return { v: 1, result: "missing", recordedStatus: status };
  return null;
}

/** A stored value read back from the database, re-validated; null if it isn't ours. */
export function readStoredUsage(value: unknown): StoredUsage | null {
  const parsed = StoredUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── The owner's view ───────────────────────────────────────────────────────

function observedPower(stored: StoredUsage): ComputerPowerObserved {
  if (stored.result === "missing") return "missing";
  const status = stored.sample.vm?.status;
  return status === "running" || status === "stopped" || status === "paused" ? status : "unknown";
}

function powerMatches(observed: ComputerPowerObserved, recorded: string): boolean | null {
  // Only settled states are compared: a computer that is starting, stopping
  // or being set up is expected to differ from its record for a while.
  if (observed === "unknown") return null;
  if (recorded === "running") return observed === "running";
  if (recorded === "stopped") return observed === "stopped" || observed === "missing";
  return null;
}

export interface HivraUsageViewInput {
  stored: StoredUsage | null;
  observedAt: string | null;
  /** The row's current status. */
  recordedStatus: string;
  now: Date;
  refreshing: boolean;
  /** This read failed, so the stored observation (if any) is all there is. */
  hostUnreachable: boolean;
}

/** The public shape for a Proxmox computer. No host, address or binding value. */
export function proxmoxUsageView(input: HivraUsageViewInput): ComputerUsageView {
  const { stored, recordedStatus } = input;
  const observedMs = input.observedAt ? Date.parse(input.observedAt) : Number.NaN;
  const ageSeconds = stored && Number.isFinite(observedMs)
    ? Math.max(0, Math.round((input.now.getTime() - observedMs) / 1000))
    : null;
  const notes: ComputerUsageNote[] = [];
  // An observation made before the computer's last state change says nothing
  // about whether the host and the record agree now.
  const outOfDate = stored !== null && stored.recordedStatus !== recordedStatus;
  if (outOfDate) notes.push("status_changed");
  if (input.hostUnreachable) notes.push("host_unreachable");
  const base = {
    supported: true,
    source: "proxmox" as const,
    observedAt: stored ? input.observedAt : null,
    ageSeconds,
    stale: stored === null || outOfDate || (ageSeconds !== null && ageSeconds > COMPUTER_USAGE_STALE_SECONDS),
    refreshing: input.refreshing,
  };
  if (!stored) {
    return {
      ...base,
      power: { observed: "unknown", recorded: recordedStatus, matches: null },
      uptimeSeconds: null, cpu: null, memory: null, disk: null, notes,
    };
  }
  const observed = observedPower(stored);
  const matches = outOfDate ? null : powerMatches(observed, recordedStatus);
  if (stored.result === "missing") {
    notes.push("vm_missing");
    return {
      ...base,
      power: { observed, recorded: recordedStatus, matches },
      uptimeSeconds: null, cpu: null, memory: null, disk: null, notes,
    };
  }
  const { vm, config, guest } = stored.sample;
  if (!vm) notes.push("resources_unavailable");
  const running = observed === "running";
  const root = guest.root;
  if (running && !root) notes.push("guest_agent_unavailable");
  const allocatedBytes = config.diskBytes ?? vm?.maxdisk ?? null;
  return {
    ...base,
    power: { observed, recorded: recordedStatus, matches },
    uptimeSeconds: running && vm?.uptime != null ? vm.uptime : null,
    cpu: running && vm?.cpu != null && vm.maxcpu != null && vm.maxcpu > 0
      ? { percent: Math.round(vm.cpu * 1000) / 10, vcpus: vm.maxcpu }
      : null,
    // PVE counts memory as total minus free from the balloon driver, which
    // includes the guest's file cache; the page says so.
    memory: running && vm?.mem != null && vm.maxmem != null && vm.maxmem > 0
      ? { usedBytes: Math.min(vm.mem, vm.maxmem), maximumBytes: vm.maxmem, includesCache: true }
      : null,
    disk: root || allocatedBytes !== null
      ? {
          usedBytes: root ? root.used : null,
          sizeBytes: root ? root.total : null,
          allocatedBytes,
          filesystem: root ? root.fs : null,
          guestReported: Boolean(root),
        }
      : null,
    notes,
  };
}

/** A computer Hivra can't read live usage for: its record, and why. */
export function statusOnlyUsageView(input: {
  source: "hetzner" | "gvisor" | "digitalocean";
  reason: string;
  recordedStatus: string;
  size: { cpu: number; ramGb: number } | null;
}): ComputerUsageView {
  return {
    supported: false,
    source: input.source,
    reason: input.reason,
    observedAt: null,
    ageSeconds: null,
    stale: false,
    refreshing: false,
    power: { observed: "unknown", recorded: input.recordedStatus, matches: null },
    uptimeSeconds: null,
    cpu: null,
    memory: null,
    disk: null,
    ...(input.size ? { size: input.size } : {}),
    notes: [],
  };
}
