// Host-side scripts and parsers for agent sleep and wake. Pure (no server
// imports) so the tests can run the scripts themselves against stub binaries.
//
// Every script is inline and goes through runProxmoxHostScript, so nothing here
// needs a provisioner release. They follow the lifecycle scripts: the exact
// binding tag is checked (a missing tag refuses), `set -euo pipefail`, every
// interpolated value is validated and shell quoted, and every `qm` call is
// wrapped in `timeout`.
//
// Fail toward awake. A VM in any state these scripts do not expect (a
// qmpstatus other than running or paused, a lock other than suspended) is
// refused and never resumed or suspended. Every script prints exactly one
// receipt line, and a reader that cannot parse it counts the run as failed.
//
// The fast path does not go through the qm CLI (about 0.6 s of start-up per
// call). A nap is QMP `stop` and its wake is QMP `cont`, and the guest fixups
// after any wake go straight to the guest agent socket, all through one small
// python3 helper (sleep/host-vm-control-program.ts). `qm` stays for the state
// read, hibernate, restore and the fallbacks.
//
// Receipts always exit 0 when they carry an answer, so the caller reads the
// receipt rather than the exit code. An unexpected shell failure still prints a
// receipt (reason script_error, state unknown) and keeps its non-zero exit.

import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  HOST_VM_CONTROL_PREFIX,
  HOST_VM_CONTROL_PROGRAM,
  HOST_VM_CONTROL_SOCKETS_PROGRAM,
} from "@/lib/hivra/sleep/host-vm-control-program";
import {
  IDLE_PROBE_PREFIX,
  IDLE_PROBE_PROGRAM,
  IDLE_PROBE_TELEGRAM_PROGRAM,
  IDLE_PROBE_VERSION,
  TELEGRAM_ENV_VALUE_PY,
} from "@/lib/hivra/sleep/idle-probe-program";
import { type TelegramProbeFacts } from "@/lib/hivra/telegram-wake/coverage";
import { parseChannelProbeFacts, type ChannelProbeFacts } from "@/lib/hivra/sleep/idle-probe-program";
import { CHANNEL_WAKE_CHANNEL_NAMES, type ChannelWakeChannel } from "@/lib/hivra/channel-wake/config";
import {
  GENERIC_CHANNEL_SPECS,
  TELEGRAM_CHANNEL_SPEC,
  allowedCoveredChannels,
  channelFpsEnv,
  channelFpsPython,
  channelGatePerl,
  coverableProbeTags,
  genericChannelSpec,
} from "@/lib/hivra/channel-wake/registry";
import type { ChannelWakeSpec } from "@/lib/hivra/channel-wake/types";

export const SLEEP_RESULT_PREFIX = "HIVRA_SLEEP_RESULT ";
export const WAKE_RESULT_PREFIX = "HIVRA_WAKE_RESULT ";
export const IDLE_REFUSED_PREFIX = "HIVRA_IDLE_REFUSED ";

export type SleepScriptTier = "nap" | "hibernate";
/** What the script saw the computer as: awake, paused, saved to disk, off, or none of those. */
export type ObservedSleepState = "awake" | "napping" | "hibernated" | "cold" | "unknown";

/** The thin pool gate for a hibernate: refuse above this fill, and below this much free space per VM memory. */
export const HIBERNATE_POOL_MAX_PERCENT = 85;
export const HIBERNATE_POOL_HEADROOM_FACTOR = 1.25;
/** `qm suspend --todisk` is cut off after this long. */
export const HIBERNATE_TIMEOUT_SECONDS = 240;
/** How long the guest agent gets to answer after a wake. A restore from disk needs longer than a resume. */
export const WAKE_AGENT_WAIT_SECONDS = 8;
export const RESTORE_AGENT_WAIT_SECONDS = 30;
/** What the wake script waits for a sleep script that holds the computer. */
export const WAKE_LOCK_WAIT_SECONDS = 15;
/** The guest agent socket lock, shared by every script that talks to one guest agent. */
const QGA_LOCK_WAIT_SECONDS = 30;

const MIN_VMID = 100;
const MAX_VMID = 999_999_999;

function assertTarget(vmid: number, bindingTag: string | null): string {
  if (!Number.isSafeInteger(vmid) || vmid < MIN_VMID || vmid > MAX_VMID) {
    throw new Error("Invalid sleep script VMID.");
  }
  // Sleep never acts on a legacy row without an enforced binding tag.
  if (typeof bindingTag !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(bindingTag)) {
    throw new Error("Sleep scripts need the computer's exact binding tag.");
  }
  return bindingTag;
}

// ---------------------------------------------------------------------------
// Shell building blocks
// ---------------------------------------------------------------------------

function receiptShell(kind: "sleep" | "wake"): string {
  const prefix = kind === "sleep" ? SLEEP_RESULT_PREFIX.trim() : WAKE_RESULT_PREFIX.trim();
  const format = kind === "sleep"
    ? `'%s {"ok":%s,"vmid":%s,"tier":"%s","from":"%s","to":"%s","reason":"%s","ms":%s,"steps":{%s},"probe":%s}\\n' "$RECEIPT_PREFIX" "$OK" "$VMID" "$TIER" "$FROM" "$TO" "$REASON" "$(since_ms "$T0")" "$STEPS" "$PROBE_JSON"`
    : `'%s {"ok":%s,"vmid":%s,"from":"%s","to":"%s","reason":"%s","ms":%s,"steps":{%s},"via":"%s","tries":%s}\\n' "$RECEIPT_PREFIX" "$OK" "$VMID" "$FROM" "$TO" "$REASON" "$(since_ms "$T0")" "$STEPS" "$VIA" "$TRIES"`;
  return `RECEIPT_PREFIX=${prefix}
# Durations come from the monotonic uptime clock (10 ms steps), never the wall clock, which can step
# backwards under NTP. A reading that still goes backwards is reported as 0.
now_ms() { local up; read -r up _ </proc/uptime || { echo 0; return; }; echo $(( 10#\${up/./} * 10 )); }
since_ms() { local d=$(( $(now_ms) - $1 )); [ "$d" -ge 0 ] || d=0; echo "$d"; }
# A hibernate that turned autostart off leaves this mark, so the wake turns it back on and nothing else.
ONBOOT_MARK_DIR=/var/lib/hivra-sleep
ONBOOT_MARK="$ONBOOT_MARK_DIR/onboot-$VMID"
START_ERR="/run/lock/hivra-start-$VMID.err"
T0="$(now_ms)"
STEPS=""
OK=false
FROM=unknown
TO=unknown
REASON=script_error
PROBE_JSON=null
EMITTED=0
VIA=none
TRIES=0
ST=""
QMP=""
LOCK=none
CONFIG=""
CONFIG_FRESH=0
OBS=unknown
mark() { STEPS="\${STEPS:+$STEPS,}\\"$1\\":$(since_ms "$2")"; }
emit() {
  [ "$EMITTED" = 0 ] || return 0
  EMITTED=1
  printf ${format}
}
finish() {
  OK="$1"
  REASON="$2"
  if [ -n "\${3:-}" ]; then TO="$3"; fi
  emit
  exit 0
}
on_exit() {
  local code=$?
  if declare -F cleanup_hivra_qga_result >/dev/null; then cleanup_hivra_qga_result >/dev/null 2>&1 || true; fi
  # A hibernate cut off before it settled must not leave autostart off on a computer that is still up.
  if [ "\${ONBOOT_PENDING:-0}" = 1 ]; then
    observe >/dev/null 2>&1 || true
    case "$OBS" in
      awake|napping) if [ "\${ONBOOT_WAS:-}" = 1 ]; then qm set "$VMID" --onboot 1 >/dev/null 2>&1 && rm -f "$ONBOOT_MARK" || true; fi ;;
    esac
  fi
  if [ "$EMITTED" = 0 ]; then OK=false; emit; fi
  # No lock descriptor outlives the script, whichever way it ends.
  exec 7>&- 8>&- 9>&-
  exit "$code"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM`;
}

/**
 * Runs the host helper (QMP and guest agent sockets) and reads its one receipt
 * line into CTL_* variables with perl, never trusting its shape: anything that
 * is not exactly one valid line reads as a failed helper. With killStaleSockets
 * the helper's fixup also drops stale outbound :443 connections in the guest;
 * without it this is the plain helper every script carried before.
 */
function ctlShell(killStaleSockets = false): string {
  return `HOST_CTL_PROGRAM=${shellQuote(killStaleSockets ? HOST_VM_CONTROL_SOCKETS_PROGRAM : HOST_VM_CONTROL_PROGRAM)}
CTL_OK=false
CTL_REASON=helper_failed
CTL_STATUS=""
CTL_VIA=none
CTL_TRIES=0
CTL_STEPS=""
# ctl <time limit s> <op> <vmid> [args]: the limit also kills a helper that hangs.
ctl() {
  local limit="$1" out parsed
  shift
  CTL_OK=false; CTL_REASON=helper_failed; CTL_STATUS=""; CTL_VIA=none; CTL_TRIES=0; CTL_STEPS=""
  out="$(command timeout -k 2 "$limit" python3 -I -B -c "$HOST_CTL_PROGRAM" "$@" 2>/dev/null </dev/null)" || true
  parsed="$(HIVRA_CTL_OUT="$out" /usr/bin/perl -MJSON::PP - <<'HIVRA_CTL_PARSE'
${String.raw`use strict;
use warnings;
use JSON::PP;
my $bad = "false\nhelper_failed\n\nnone\n0\n\n";
my @lines = grep { index($_, "${HOST_VM_CONTROL_PREFIX}") == 0 } split /\n/, ($ENV{HIVRA_CTL_OUT} // "");
unless (@lines == 1) { print $bad; exit 0; }
my $d = eval { JSON::PP::decode_json(substr($lines[0], ${HOST_VM_CONTROL_PREFIX.length})) };
unless (ref($d) eq "HASH" && JSON::PP::is_bool($d->{ok}) && defined($d->{reason}) && !ref($d->{reason}) && $d->{reason} =~ /\A[a-z_]{1,40}\z/) { print $bad; exit 0; }
my $status = $d->{status};
$status = "" unless defined($status) && !ref($status) && $status =~ /\A[a-z_-]{1,24}\z/;
my $via = $d->{via};
$via = "none" unless defined($via) && !ref($via) && $via =~ /\A(?:socket|qm|none)\z/;
my $tries = $d->{tries};
$tries = 0 unless defined($tries) && !ref($tries) && $tries =~ /\A[0-9]{1,6}\z/;
my @steps;
if (ref($d->{steps}) eq "HASH") {
    for my $k (sort keys %{$d->{steps}}) {
        my $v = $d->{steps}{$k};
        next unless $k =~ /\A[a-z_]{1,24}\z/ && defined($v) && !ref($v) && $v =~ /\A[0-9]{1,8}\z/;
        push @steps, "\"$k\":$v";
    }
}
print(($d->{ok} ? "true" : "false"), "\n", $d->{reason}, "\n", $status, "\n", $via, "\n", $tries, "\n", join(",", @steps), "\n");`}
HIVRA_CTL_PARSE
)" || return 1
  { read -r CTL_OK; read -r CTL_REASON; read -r CTL_STATUS; read -r CTL_VIA; read -r CTL_TRIES; read -r CTL_STEPS; } <<<"$parsed" || true
}
# The fast read of a running computer: QMP answers in milliseconds. No answer (stopped, or anything odd) leaves the CLI to say.
qmp_fast() {
  ctl 8 qmp "$VMID" status 3
  [ "$CTL_OK" = true ] && [ -n "$CTL_STATUS" ] || return 1
  ST=running
  QMP="$CTL_STATUS"
}
# Every script that talks to one computer's guest agent takes this lock first, so two of them never share the socket.
qga_lock() {
  exec 7>"/run/lock/hivra-qga-$VMID.lock" || return 1
  flock -x -w ${QGA_LOCK_WAIT_SECONDS} 7 || { exec 7>&-; return 1; }
}
qga_unlock() {
  flock -u 7 >/dev/null 2>&1 || true
  exec 7>&-
}`;
}

/**
 * Fast answers to `qm config <vmid>` and `qm status <vmid>` from the files the
 * CLI itself reads, for the binding check (when switched on) and the admission
 * helper. Anything they cannot answer exactly goes to the real CLI.
 */
const FAST_QM_FUNCTIONS = `PVE_QEMU_CONF_DIR=/etc/pve/qemu-server
QEMU_RUN_DIR=/var/run/qemu-server
hivra_fast_qm() {
  local f pid
  if [ "$#" = 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; then
    case "$1" in
      config)
        f="$PVE_QEMU_CONF_DIR/$2.conf"
        # Pending changes are applied in the CLI's answer, so a file with any goes to the CLI.
        # Snapshot sections are not part of the current config.
        if [ -r "$f" ] && ! grep -q '^\\[PENDING\\]' "$f"; then
          awk '/^\\[/ {exit} /^#/ {next} NF {print}' "$f"
          return 0
        fi
        ;;
      status)
        f="$QEMU_RUN_DIR/$2.pid"
        if [ ! -e "$f" ]; then echo "status: stopped"; return 0; fi
        pid="$(head -c 32 "$f" 2>/dev/null | tr -dc 0-9)"
        if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] \
            && tr '\\0' '\\n' <"/proc/$pid/cmdline" 2>/dev/null | grep -Fxq -- "$2" \
            && tr '\\0' '\\n' <"/proc/$pid/cmdline" 2>/dev/null | grep -Fxq -- "-id"; then
          echo "status: running"
          return 0
        fi
        ;;
    esac
  fi
  command timeout -k 5 30 qm "$@" </dev/null
}`;

/** With fast_qm on: the functions ahead of the binding check, which uses the config reader too. */
const FAST_QM_SHELL = `# The admission helper reads every VM with qm config and qm status. The CLI costs
# about 0.6 s a call, so on a host with 20 VMs that walk alone took 26 s of a wake.
# These two answer from the files the CLI itself reads, and hand anything they
# cannot answer exactly back to the real CLI. The binding check may use the config
# reader too: a missing file goes to the CLI, which then fails as before.
${FAST_QM_FUNCTIONS}`;

/** With fast_qm off: the functions inside the admission shell, for the helper only, as before. */
const ADMISSION_FAST_QM_SHELL = `# The admission helper reads every VM with qm config and qm status. The CLI costs
# about 0.6 s a call, so on a host with 20 VMs that walk alone took 26 s of a wake.
# For the helper only, these two answer from the files the CLI itself reads, and
# hand anything they cannot answer exactly back to the real CLI.
${FAST_QM_FUNCTIONS}`;

function stateShell(fastConfig: boolean): string {
  return `# One config read serves the binding check and the first state read.
read_state() {
  local out
  ST=""; QMP=""; LOCK=none
  if [ "$CONFIG_FRESH" = 1 ]; then
    CONFIG_FRESH=0
  else
    CONFIG="$(qm config "$VMID" 2>/dev/null)" || { CONFIG=""; return 1; }
  fi
  LOCK="$(printf '%s\\n' "$CONFIG" | awk '$1=="lock:" {print $2; exit}')"
  if ! qmp_fast; then
    out="$(qm status "$VMID" --verbose 2>/dev/null)" || return 1
    ST="$(printf '%s\\n' "$out" | awk '$1=="status:" {print $2; exit}')"
    QMP="$(printf '%s\\n' "$out" | awk '$1=="qmpstatus:" {print $2; exit}')"
  fi
  [ -n "$LOCK" ] || LOCK=none
  [ -n "$QMP" ] || QMP=none
  [ -n "$ST" ]
}
tier_of() {
  case "$ST/$QMP/$LOCK" in
    running/running/none) echo awake ;;
    running/paused/none) echo napping ;;
    stopped/*/suspended) echo hibernated ;;
    stopped/*/none) echo cold ;;
    *) echo unknown ;;
  esac
}
observe() { if read_state; then OBS="$(tier_of)"; else OBS=unknown; fi; }
# The exact binding tag, checked once per script, from the same config read the state read then reuses.
require_binding() {
  [ -n "$EXPECTED_BINDING_TAG" ] || finish false binding_missing
  local tags
  CONFIG="$(${fastConfig ? "hivra_fast_qm" : "qm"} config "$VMID" 2>/dev/null)" || finish false unreachable
  tags="$(printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\\n' "$tags" | tr ';' '\\n' | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null \\
    || finish false binding_mismatch
  CONFIG_FRESH=1
}`;
}

/** Checks the instantaneous signals of a probe. Prints ok, active or invalid. */
const PROBE_CHECK_PERL_BASE = String.raw`use strict;
use warnings;
use JSON::PP;
use B;
my $manual = (defined $ARGV[0] && $ARGV[0] eq "1") ? 1 : 0;
my $d = eval { JSON::PP::decode_json($ENV{HIVRA_PROBE} // "") };
unless (ref($d) eq "HASH") { print "invalid\n"; exit 0; }
# A count is a JSON number, never a string that looks like one.
sub as_count {
    my ($v) = @_;
    return undef if !defined($v) || ref($v);
    my $flags = B::svref_2object(\$v)->FLAGS;
    return undef unless ($flags & (B::SVp_IOK | B::SVp_NOK)) && !($flags & B::SVp_POK);
    return ($v >= 0 && $v == int($v)) ? $v + 0 : undef;
}
sub as_flag {
    my ($v) = @_;
    return JSON::PP::is_bool($v) ? ($v ? 1 : 0) : undef;
}
my $busy = 0;
for my $key (qw(activeRuns cliProcesses)) {
    my $n = as_count($d->{$key});
    unless (defined $n) { print "invalid\n"; exit 0; }
    $busy = 1 if $n > 0;
}
my $channels = $d->{liveChannels};
unless (ref($channels) eq "ARRAY") { print "invalid\n"; exit 0; }
__CHANNEL_CHECK__
# The only error that does not make the answer unknown is a failed timer count.
my $errs = $d->{errors};
unless (ref($errs) eq "ARRAY") { print "invalid\n"; exit 0; }
for my $e (@$errs) {
    unless (defined($e) && !ref($e) && $e eq "timers") { print "invalid\n"; exit 0; }
}
unless ($manual) {
    for my $key (qw(openConnections sshSessions)) {
        my $n = as_count($d->{$key});
        unless (defined $n) { print "invalid\n"; exit 0; }
        $busy = 1 if $n > 0;
    }
    for my $key (qw(terminalAttached desktopAttached)) {
        my $f = as_flag($d->{$key});
        unless (defined $f) { print "invalid\n"; exit 0; }
        $busy = 1 if $f;
    }
}
print $busy ? "active\n" : "ok\n";`;

const PLAIN_CHANNEL_CHECK = "$busy = 1 if @$channels;";

/**
 * The channel rule when a Telegram wake covers the agent: a live channel keeps
 * it awake unless it is on the allowlist, named in HIVRA_COVERED_CHANNELS, and
 * the probe's Telegram facts match what the server checked: the token is in
 * .env with the fingerprint in HIVRA_TG_FP, Hermes polls, and config.yaml has
 * no token of its own. The same rules as telegramWakeCoverage().
 */
const COVERED_CHANNEL_CHECK = String.raw`my %allowed = map { $_ => 1 } (${[TELEGRAM_CHANNEL_SPEC.probeTag].map((c) => JSON.stringify(c)).join(", ")});
my %covered = map { $_ => 1 } grep { $allowed{$_} } split /,/, ($ENV{HIVRA_COVERED_CHANNELS} // "");
my $fp = $ENV{HIVRA_TG_FP} // "";
my $tg = $d->{telegram};
my $tg_ok = $fp =~ /\A[0-9a-f]{16}\z/ && ref($tg) eq "HASH"
    && defined($tg->{hermesFp}) && !ref($tg->{hermesFp}) && $tg->{hermesFp} eq $fp
    && JSON::PP::is_bool($tg->{hermesTokenInEnv}) && $tg->{hermesTokenInEnv}
    && JSON::PP::is_bool($tg->{hermesWebhookMode}) && !$tg->{hermesWebhookMode}
    && JSON::PP::is_bool($tg->{hermesConfigToken}) && !$tg->{hermesConfigToken};
for my $c (@$channels) {
    $busy = 1 unless $tg_ok && defined($c) && !ref($c) && $covered{$c};
}`;

/** The probe check. With nothing covered it is exactly the check every sleep used before. */
export function probeCheckPerl(covered: boolean): string {
  return PROBE_CHECK_PERL_BASE.replace("__CHANNEL_CHECK__", () => (covered ? COVERED_CHANNEL_CHECK : PLAIN_CHANNEL_CHECK));
}

/** Where the channel fingerprint lines go in the probe: just before the OpenClaw read, as the Telegram facts do. */
const CHANNEL_FPS_ANCHOR = `oc = rjson(HOME + "/.openclaw/openclaw.json", 262144)\n`;

/** The probe a sleep runs: Telegram facts when Telegram is covered, and fingerprints for the generic channels asked about. */
export function idleProbeProgramFor(
  options: { telegram?: boolean; channels?: readonly ChannelWakeChannel[] } = {},
  specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS,
): string {
  const base = options.telegram === true ? IDLE_PROBE_TELEGRAM_PROGRAM : IDLE_PROBE_PROGRAM;
  const channels = options.channels ?? [];
  if (channels.length === 0) return base;
  if (!base.includes(CHANNEL_FPS_ANCHOR)) throw new Error("idle probe: channel anchor missing");
  return base.replace(CHANNEL_FPS_ANCHOR, () => channelFpsPython(channels, specs) + CHANNEL_FPS_ANCHOR);
}

/** The coverage a sleep script carries: the legacy Telegram-only form, the general form, or none. */
type ScriptCoverage =
  | { kind: "telegram"; coverage: TelegramSleepCoverage }
  | { kind: "channels"; coverage: ChannelSleepCoverage; specs: readonly ChannelWakeSpec[] };

function probeShell(manual: boolean, scriptCoverage: ScriptCoverage | null = null): string {
  if (scriptCoverage?.kind === "channels") return channelProbeShell(manual, scriptCoverage.coverage, scriptCoverage.specs);
  const coverage = scriptCoverage?.coverage ?? null;
  return `PROBE_PROGRAM=${shellQuote(coverage ? IDLE_PROBE_TELEGRAM_PROGRAM : IDLE_PROBE_PROGRAM)}
MANUAL=${manual ? 1 : 0}${coverage ? `
HIVRA_COVERED_CHANNELS=${shellQuote(coverage.channels.join(","))}
HIVRA_TG_FP=${shellQuote(coverage.fingerprint)}` : ""}
${probeFunctionsShell(coverage ? ' HIVRA_COVERED_CHANNELS="$HIVRA_COVERED_CHANNELS" HIVRA_TG_FP="$HIVRA_TG_FP"' : "", probeCheckPerl(coverage !== null))}`;
}

/** The general form: every covered channel is checked by its own predicate (see channelGatePerl). */
function channelProbeShell(manual: boolean, coverage: ChannelSleepCoverage, specs: readonly ChannelWakeSpec[]): string {
  const generic = coverage.channels
    .map((tag) => specs.find((spec) => spec.probeTag === tag)?.channel)
    .filter((channel): channel is ChannelWakeChannel => Boolean(channel));
  const program = idleProbeProgramFor({ telegram: coverage.channels.includes(TELEGRAM_CHANNEL_SPEC.probeTag), channels: generic }, specs);
  return `PROBE_PROGRAM=${shellQuote(program)}
MANUAL=${manual ? 1 : 0}
HIVRA_COVERED_CHANNELS=${shellQuote(coverage.channels.join(","))}
HIVRA_CHANNEL_FPS=${shellQuote(channelFpsEnv(coverage.fingerprints))}
${probeFunctionsShell(' HIVRA_COVERED_CHANNELS="$HIVRA_COVERED_CHANNELS" HIVRA_CHANNEL_FPS="$HIVRA_CHANNEL_FPS"', PROBE_CHECK_PERL_BASE.replace("__CHANNEL_CHECK__", () => channelGatePerl(specs)))}`;
}

function probeFunctionsShell(checkEnv: string, checkPerl: string): string {
  return `run_probe() {
  local out lines line
  PROBE_JSON=null
  qga_lock || return 1
  out="$(run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c "$PROBE_PROGRAM" 2>/dev/null)" || { qga_unlock; return 1; }
  qga_unlock
  lines="$(printf '%s\\n' "$out" | awk 'index($0, "${IDLE_PROBE_PREFIX}") == 1 { n++ } END { print n + 0 }')"
  [ "$lines" = 1 ] || return 1
  line="$(printf '%s\\n' "$out" | sed -n 's/^${IDLE_PROBE_PREFIX}//p')"
  # Re-encoded, so a guest cannot put anything but one JSON object into the receipt.
  PROBE_JSON="$(HIVRA_PROBE="$line" /usr/bin/perl -MJSON::PP -e 'my $d = JSON::PP::decode_json($ENV{HIVRA_PROBE}); die "shape" unless ref($d) eq "HASH"; print JSON::PP->new->canonical->encode($d);')" \\
    || { PROBE_JSON=null; return 1; }
}
probe_blocker() {
  HIVRA_PROBE="$PROBE_JSON"${checkEnv} /usr/bin/perl -MJSON::PP - "$MANUAL" <<'HIVRA_PROBE_CHECK'
${checkPerl}
HIVRA_PROBE_CHECK
}
# Runs the probe once and finishes the script, leaving the computer as it is, unless it is idle.
probe_or_finish() {
  local blocker
  run_probe || finish false probe_failed "$FROM"
  blocker="$(probe_blocker)" || finish false probe_failed "$FROM"
  case "$blocker" in
    ok) ;;
    invalid) finish false probe_invalid "$FROM" ;;
    *) finish false active "$FROM" ;;
  esac
}`;
}

// ---------------------------------------------------------------------------
// Idle probe host script
// ---------------------------------------------------------------------------

/**
 * Run the idle probe in the VM and print its one HIVRA_IDLE line. A VM that is
 * not plainly running (paused, saved to disk, stopped, or any odd state) is
 * refused with one HIVRA_IDLE_REFUSED line instead, because its guest agent
 * cannot answer.
 */
export function buildIdleProbeHostScript(
  target: { vmid: number; bindingTag: string | null },
  options: { telegram?: boolean; channels?: readonly ChannelWakeChannel[] } = {},
  specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS,
): string {
  return buildGuestReadHostScript(target, idleProbeProgramFor(options, specs));
}

/**
 * The shared body of a host script that runs one python program inside a VM
 * that is plainly running, behind the binding check and the guest agent lock.
 * Refusals print one HIVRA_IDLE_REFUSED line.
 */
function buildGuestReadHostScript(target: { vmid: number; bindingTag: string | null }, program: string): string {
  const tag = assertTarget(target.vmid, target.bindingTag);
  return `set -euo pipefail
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(tag)}
# The host script itself arrives on stdin, so no command may read it.
qm() { command timeout -k 5 25 qm "$@" </dev/null; }
refuse() { printf '${IDLE_REFUSED_PREFIX}%s\\n' "$1"; exit 0; }
[ -n "$EXPECTED_BINDING_TAG" ] || refuse binding_missing
CONFIG="$(qm config "$VMID" 2>/dev/null)" || refuse unreachable
printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fx -- "$EXPECTED_BINDING_TAG" >/dev/null \\
  || refuse binding_mismatch
# One call gives both the status and the qmpstatus.
VERBOSE="$(qm status "$VMID" --verbose 2>/dev/null)" || refuse unreachable
STATUS="$(printf '%s\\n' "$VERBOSE" | awk '$1=="status:" {print $2; exit}')"
QMPSTATUS="$(printf '%s\\n' "$VERBOSE" | awk '$1=="qmpstatus:" {print $2; exit}')"
LOCK="$(printf '%s\\n' "$CONFIG" | awk '$1=="lock:" {print $2; exit}')"
case "$STATUS/\${QMPSTATUS:-none}/\${LOCK:-none}" in
  running/running/none) ;;
  running/paused/none|stopped/*/suspended) refuse asleep ;;
  stopped/*/none) refuse not_running ;;
  *) refuse unexpected_state ;;
esac
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout -k 5 25 qm "$@" </dev/null; }
install -d -m 0755 /run/lock
# Taken only now, so a refusal never waits on it. No other script reads this computer's guest agent meanwhile.
exec 7>/run/lock/hivra-qga-${target.vmid}.lock
flock -x -w ${QGA_LOCK_WAIT_SECONDS} 7 || refuse guest_busy
run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c ${shellQuote(program)} || refuse guest_unreachable
`;
}

// ---------------------------------------------------------------------------
// Telegram token read (wake-on-message opt-in)
// ---------------------------------------------------------------------------

export const TELEGRAM_TOKEN_PREFIX = "HIVRA_TG_TOKEN ";
export const TELEGRAM_TOKEN_NONE_PREFIX = "HIVRA_TG_TOKEN_NONE ";

/**
 * Reads TELEGRAM_BOT_TOKEN from ~/.hermes/.env inside the guest, with the same
 * parser the idle probe fingerprints, and prints it on one line only when it
 * has a bot token's shape. Anything else prints a reason and no token.
 */
export const TELEGRAM_TOKEN_READ_PROGRAM = String.raw`import os, re, sys
# hivra-tg-token-read v1. Runs as root via the guest agent. Prints the token line and nothing else.
${TELEGRAM_ENV_VALUE_PY}
def none(why):
    sys.stdout.write("${TELEGRAM_TOKEN_NONE_PREFIX}" + why + "\n")
    sys.exit(0)
try:
    fd = os.open("/home/bux/.hermes/.env", os.O_RDONLY | os.O_NOFOLLOW)
    try: text = os.read(fd, 65536).decode("utf-8", "replace")
    finally: os.close(fd)
except OSError:
    none("no_env")
tok = env_value(text, "TELEGRAM_BOT_TOKEN")
if not tok: none("no_token")
if env_value(text, "TELEGRAM_WEBHOOK_URL"): none("webhook_mode")
if not re.match(r"^\d{6,}:[A-Za-z0-9_-]{30,}$", tok): none("bad_shape")
sys.stdout.write("${TELEGRAM_TOKEN_PREFIX}" + tok + "\n")
`;

/** Runs the token read in the VM. Refusals print one HIVRA_IDLE_REFUSED line, as the probe's do. */
export function buildTelegramTokenReadHostScript(target: { vmid: number; bindingTag: string | null }): string {
  return buildGuestReadHostScript(target, TELEGRAM_TOKEN_READ_PROGRAM);
}

export type TelegramTokenRead = { ok: true; token: string } | { ok: false; reason: string };

/** Strict read of the token script's answer. The token itself is never part of a failure. */
export function parseTelegramTokenRead(stdout: string): TelegramTokenRead {
  if (typeof stdout !== "string") return { ok: false, reason: "no_answer" };
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const tokens = lines.filter((line) => line.startsWith(TELEGRAM_TOKEN_PREFIX));
  const nones = lines.filter((line) => line.startsWith(TELEGRAM_TOKEN_NONE_PREFIX));
  if (tokens.length === 1 && nones.length === 0) {
    const token = tokens[0].slice(TELEGRAM_TOKEN_PREFIX.length);
    if (/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) return { ok: true, token };
    return { ok: false, reason: "bad_shape" };
  }
  if (tokens.length === 0 && nones.length === 1) {
    const reason = nones[0].slice(TELEGRAM_TOKEN_NONE_PREFIX.length).trim();
    return { ok: false, reason: /^[a-z_]{1,40}$/.test(reason) ? reason : "no_answer" };
  }
  const refused = parseIdleProbeRefusal(stdout);
  return { ok: false, reason: refused ?? "no_answer" };
}

// ---------------------------------------------------------------------------
// Probe parser and verdict
// ---------------------------------------------------------------------------

export interface IdleProbe {
  v: number;
  errors: string[];
  activeRuns: number;
  cliProcesses: number;
  openConnections: number;
  gatewayConnections: number;
  terminalAttached: boolean;
  terminalClients: number;
  sshSessions: number;
  desktopAttached: boolean;
  /** ISO time on the guest's clock, or null when it has never been used. */
  lastUsedAt: string | null;
  /** ISO time on the guest's clock, or null when nothing is scheduled. */
  nextJobAt: string | null;
  liveChannels: string[];
  loadavg: [number, number, number];
  cpus: number;
  uptimeS: number;
  /** The guest's clock when it ran. Every other time in the probe is compared with this. */
  now: string;
  ms: number;
  sysTimers?: number;
  /** Only when the probe was asked for Telegram wake facts. */
  telegram?: TelegramProbeFacts;
  /** Only when the probe was asked for channel wake fingerprints: per channel, the credential fingerprint or null. */
  channelFps?: Partial<Record<ChannelWakeChannel, string | null>>;
  /** The probe's per-channel facts, kept only alongside channelFps (a channel wake probe). */
  channelFacts?: ChannelProbeFacts;
}

function validateChannelFps(value: unknown): Partial<Record<ChannelWakeChannel, string | null>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Partial<Record<ChannelWakeChannel, string | null>> = {};
  for (const [key, fp] of Object.entries(value as Record<string, unknown>)) {
    if (!(CHANNEL_WAKE_CHANNEL_NAMES as readonly string[]).includes(key)) return null;
    if (fp !== null && (typeof fp !== "string" || !PROBE_FINGERPRINT.test(fp))) return null;
    out[key as ChannelWakeChannel] = fp;
  }
  return out;
}

const PROBE_FINGERPRINT = /^[0-9a-f]{16}$/;

function validateTelegramFacts(value: unknown): TelegramProbeFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ((row.hermesFp !== null && (typeof row.hermesFp !== "string" || !PROBE_FINGERPRINT.test(row.hermesFp)))
      || typeof row.hermesTokenInEnv !== "boolean" || typeof row.hermesWebhookMode !== "boolean"
      || typeof row.hermesConfigToken !== "boolean") return null;
  return {
    hermesFp: row.hermesFp,
    hermesTokenInEnv: row.hermesTokenInEnv,
    hermesWebhookMode: row.hermesWebhookMode,
    hermesConfigToken: row.hermesConfigToken,
  };
}

const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const COUNT_MAX = 1_000_000;

function isCount(value: unknown, max = COUNT_MAX): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}
function isoOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)));
}

/** Checks one probe object field by field. Anything unexpected is null. */
export function validateIdleProbe(value: unknown): IdleProbe | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const channels = row.liveChannels;
  const errors = row.errors;
  const load = row.loadavg;
  if (row.v !== IDLE_PROBE_VERSION
      || !Array.isArray(errors) || errors.length > 20 || !errors.every((e) => typeof e === "string" && /^[a-z_]{1,40}$/.test(e))
      || !isCount(row.activeRuns) || !isCount(row.cliProcesses) || !isCount(row.openConnections)
      || !isCount(row.gatewayConnections) || !isCount(row.terminalClients) || !isCount(row.sshSessions)
      || typeof row.terminalAttached !== "boolean" || typeof row.desktopAttached !== "boolean"
      || !isoOrNull(row.lastUsedAt) || !isoOrNull(row.nextJobAt)
      || typeof row.now !== "string" || !ISO_UTC.test(row.now) || !Number.isFinite(Date.parse(row.now))
      || !Array.isArray(channels) || channels.length > 50
      || !channels.every((c) => typeof c === "string" && /^[A-Za-z0-9:_.-]{1,64}$/.test(c))
      || !Array.isArray(load) || load.length !== 3 || !load.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= COUNT_MAX)
      || !isCount(row.cpus) || !isCount(row.uptimeS, 10 ** 10) || !isCount(row.ms, 10 ** 7)
      || (row.sysTimers !== undefined && !isCount(row.sysTimers))) return null;
  const telegram = row.telegram === undefined ? undefined : validateTelegramFacts(row.telegram);
  if (telegram === null) return null;
  const channelFps = row.channelFps === undefined ? undefined : validateChannelFps(row.channelFps);
  if (channelFps === null) return null;
  // Facts are read only for a channel wake probe. Malformed facts are dropped, and an adapter that needs them stays uncovered.
  const channelFacts = channelFps ? parseChannelProbeFacts(row.channelFacts) ?? undefined : undefined;
  return {
    v: row.v,
    errors: errors as string[],
    activeRuns: row.activeRuns,
    cliProcesses: row.cliProcesses,
    openConnections: row.openConnections,
    gatewayConnections: row.gatewayConnections,
    terminalAttached: row.terminalAttached,
    terminalClients: row.terminalClients,
    sshSessions: row.sshSessions,
    desktopAttached: row.desktopAttached,
    lastUsedAt: row.lastUsedAt,
    nextJobAt: row.nextJobAt,
    liveChannels: channels as string[],
    loadavg: [load[0] as number, load[1] as number, load[2] as number],
    cpus: row.cpus,
    uptimeS: row.uptimeS,
    now: row.now,
    ms: row.ms,
    ...(row.sysTimers === undefined ? {} : { sysTimers: row.sysTimers }),
    ...(telegram ? { telegram } : {}),
    ...(channelFps ? { channelFps } : {}),
    ...(channelFacts ? { channelFacts } : {}),
  };
}

/** Strict read of the probe's answer: exactly one prefixed line holding one valid object, else null. */
export function parseIdleProbeOutput(stdout: string): IdleProbe | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.startsWith(IDLE_PROBE_PREFIX));
  if (lines.length !== 1) return null;
  let value: unknown;
  try { value = JSON.parse(lines[0].slice(IDLE_PROBE_PREFIX.length)); } catch { return null; }
  return validateIdleProbe(value);
}

/** Why the host script would not run the probe, when it printed a refusal instead. */
export function parseIdleProbeRefusal(stdout: string): string | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.startsWith(IDLE_REFUSED_PREFIX));
  if (lines.length !== 1) return null;
  const reason = lines[0].slice(IDLE_REFUSED_PREFIX.length).trim();
  return /^[a-z_]{1,40}$/.test(reason) ? reason : null;
}

export interface IdleVerdictOptions {
  /** A manual test sleep ignores the open page's own connections and recent use. */
  manual: boolean;
  /** The server's clock now, used only to turn the next job time into server time. */
  nowMs: number;
  idleWindowS: number;
  horizonS: number;
  /** The VM's CPU cores. */
  cores: number;
  /** Live channels a wake covers (see channel-wake/registry.ts). Only allowlisted names count. */
  coveredChannels?: readonly string[];
  /** The generic channel specs the allowlist is built from. The registry's own by default (tests pass others). */
  channelSpecs?: readonly ChannelWakeSpec[];
}

export interface IdleVerdict {
  idle: boolean;
  reasons: string[];
  /** When the next scheduled job runs, on the server's clock, or null. */
  nextJobAt: string | null;
}

/** Load above this share of the cores counts as busy. */
export const IDLE_LOAD_PER_CORE = 0.5;

/**
 * Whether the agent can sleep, from one probe. Pure.
 *
 * Never idle, ever: a run in progress, a coding CLI process, a connected chat
 * channel, or a job due inside the horizon. Not idle unless this is a manual
 * sleep: an open connection, a terminal, an ssh session, a desktop, use inside
 * the idle window, or high load. Unknown or missing fields are not idle.
 *
 * Times inside the probe are compared with the probe's own clock, so a guest
 * clock that has drifted from the server's does not change the answer.
 */
export function idleVerdict(probeInput: unknown, options: IdleVerdictOptions): IdleVerdict {
  const probe = validateIdleProbe(probeInput);
  const reasons: string[] = [];
  const { manual, nowMs, idleWindowS, horizonS, cores } = options;
  if (!probe) return { idle: false, reasons: ["probe_invalid"], nextJobAt: null };
  if (![nowMs, idleWindowS, horizonS].every((n) => Number.isFinite(n) && n >= 0)) {
    return { idle: false, reasons: ["options_invalid"], nextJobAt: null };
  }

  // Anything the probe could not read is unknown, and unknown is not idle.
  if (probe.errors.some((name) => name !== "timers")) reasons.push("probe_error");

  if (probe.activeRuns > 0) reasons.push("active_runs");
  if (probe.cliProcesses > 0) reasons.push("cli_process");
  const covered = allowedCoveredChannels(options.coveredChannels, options.channelSpecs);
  if (probe.liveChannels.some((channel) => !covered.includes(channel))) reasons.push("live_channels");

  const probeNowMs = Date.parse(probe.now);
  let nextJobAt: string | null = null;
  if (probe.nextJobAt) {
    const untilJobMs = Date.parse(probe.nextJobAt) - probeNowMs;
    nextJobAt = new Date(nowMs + untilJobMs).toISOString();
    if (untilJobMs <= horizonS * 1000) reasons.push("job_soon");
  }

  if (!manual) {
    if (probe.openConnections > 0) reasons.push("open_connections");
    if (probe.terminalAttached) reasons.push("terminal_attached");
    if (probe.sshSessions > 0) reasons.push("ssh_sessions");
    if (probe.desktopAttached) reasons.push("desktop_attached");
    if (probe.lastUsedAt) {
      if (probeNowMs - Date.parse(probe.lastUsedAt) < idleWindowS * 1000) reasons.push("recent_use");
    } else if (probe.uptimeS < idleWindowS) {
      // Never used, but only just started: give it the window before it sleeps.
      reasons.push("recently_started");
    }
    if (!Number.isFinite(cores) || cores <= 0) reasons.push("load_unknown");
    else if (probe.loadavg[0] >= IDLE_LOAD_PER_CORE * cores) reasons.push("high_load");
  }

  return { idle: reasons.length === 0, reasons, nextJobAt };
}

// ---------------------------------------------------------------------------
// Sleep host script
// ---------------------------------------------------------------------------

/** What the server checked before a sleep with a Telegram wake: the covered channels and the token fingerprint. */
export interface TelegramSleepCoverage {
  channels: string[];
  fingerprint: string;
}

function assertCoverage(coverage: TelegramSleepCoverage | null | undefined): TelegramSleepCoverage | null {
  if (!coverage) return null;
  const channels = coverage.channels;
  if (!Array.isArray(channels) || channels.length === 0
      || channels.some((c) => c !== TELEGRAM_CHANNEL_SPEC.probeTag)
      || new Set(channels).size !== channels.length
      || typeof coverage.fingerprint !== "string" || !PROBE_FINGERPRINT.test(coverage.fingerprint)) {
    throw new Error("Invalid Telegram wake coverage.");
  }
  return { channels: [...channels], fingerprint: coverage.fingerprint };
}

/**
 * What the server checked before a sleep that covers channels beyond
 * Telegram: the covered probe tags, and per covered channel the credential
 * fingerprint the host must see again (Telegram's token fingerprint too).
 */
export interface ChannelSleepCoverage {
  channels: string[];
  fingerprints: Partial<Record<ChannelWakeChannel, string>>;
}

function assertChannelCoverage(
  coverage: ChannelSleepCoverage | null | undefined,
  specs: readonly ChannelWakeSpec[],
): ChannelSleepCoverage | null {
  if (!coverage) return null;
  const channels = coverage.channels;
  const allowed = coverableProbeTags(specs);
  const fps = coverage.fingerprints;
  const fail = () => { throw new Error("Invalid channel wake coverage."); };
  if (!Array.isArray(channels) || channels.length === 0 || new Set(channels).size !== channels.length
      || channels.some((c) => !allowed.includes(c)) || !fps || typeof fps !== "object") fail();
  const out: Partial<Record<ChannelWakeChannel, string>> = {};
  for (const tag of channels) {
    const channel = tag === TELEGRAM_CHANNEL_SPEC.probeTag ? "telegram" : specs.find((spec) => spec.probeTag === tag)?.channel;
    const fp = channel ? fps[channel] : undefined;
    if (!channel || typeof fp !== "string" || !PROBE_FINGERPRINT.test(fp)) fail();
    out[channel as ChannelWakeChannel] = fp as string;
  }
  // A fingerprint for a channel that is not covered would be checked for nothing: refuse it.
  if (Object.keys(fps).length !== Object.keys(out).length) fail();
  if (!channels.some((tag) => tag !== TELEGRAM_CHANNEL_SPEC.probeTag && genericChannelSpec(specs.find((s) => s.probeTag === tag)?.channel, specs))) fail();
  return { channels: [...channels], fingerprints: out };
}

export interface SleepHostScriptInput {
  vmid: number;
  bindingTag: string | null;
  tier: SleepScriptTier;
  /** A manual test sleep ignores the open page's own connections. */
  manual: boolean;
  /** Live channels a Telegram wake covers. Off (null) by default: every live channel keeps the agent awake. */
  telegramCoverage?: TelegramSleepCoverage | null;
  /**
   * Live channels covered when at least one channel other than Telegram is
   * covered. Never together with telegramCoverage; a sleep that covers only
   * Telegram uses telegramCoverage, so its script is exactly as before.
   */
  channelCoverage?: ChannelSleepCoverage | null;
  /** The binding check reads the VM's config file instead of starting the qm CLI. Off by default. */
  fastConfigRead?: boolean;
}

function napBody(): string {
  return `STEP="$(now_ms)"
read_state || finish false state_unreadable
mark read_state "$STEP"
FROM="$(tier_of)"
if [ "$FROM" != awake ]; then finish false not_sleepable "$FROM"; fi
STEP="$(now_ms)"
probe_or_finish
mark probe "$STEP"
# QMP stop, then query-status in the same session: the helper says ok only when the computer reports paused.
STEP="$(now_ms)"
ctl 10 qmp "$VMID" stop 5
mark suspend "$STEP"
if [ "$CTL_OK" != true ]; then
  STOP_REASON="$CTL_REASON"
  observe
  # Whatever else the computer now reports, it is never resumed from here.
  if [ "$STOP_REASON" = unconfirmed ]; then finish false suspend_unconfirmed "$OBS"; fi
  finish false suspend_failed "$OBS"
fi
finish true napped napping`;
}

function hibernateBody(): string {
  return `STEP="$(now_ms)"
read_state || finish false state_unreadable
mark read_state "$STEP"
FROM="$(tier_of)"
case "$FROM" in awake|napping) ;; *) finish false not_sleepable "$FROM" ;; esac
if [ "$FROM" = awake ]; then
  STEP="$(now_ms)"
  probe_or_finish
  mark probe "$STEP"
fi
VM_CONFIG="$CONFIG"
POOL_REASON=pool_unknown
pool_gate() {
  local mem disk_line storage volume state_storage found vg pool sizes size pct
  mem="$(printf '%s\\n' "$VM_CONFIG" | awk '$1=="memory:" {print $2; exit}')"
  [[ "$mem" =~ ^[0-9]+$ ]] && [ "$mem" -gt 0 ] || return 1
  disk_line="$(printf '%s\\n' "$VM_CONFIG" | awk '$1 ~ /^(scsi|virtio|sata|ide)[0-9]+:$/ && $2 !~ /media=cdrom/ && $2 ~ /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+/ {print $2; exit}')"
  [ -n "$disk_line" ] || return 1
  storage="\${disk_line%%:*}"
  volume="\${disk_line#*:}"
  volume="\${volume%%,*}"
  [[ "$volume" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  # The saved memory goes to the disk's storage unless the config says otherwise. Another storage cannot be checked here.
  state_storage="$(printf '%s\\n' "$VM_CONFIG" | awk '$1=="vmstatestorage:" {print $2; exit}')"
  if [ -n "$state_storage" ] && [ "$state_storage" != "$storage" ]; then return 1; fi
  found="$(command timeout 20 lvs --noheadings --separator '|' -o vg_name,pool_lv,lv_name </dev/null 2>/dev/null \\
    | awk -F'|' -v want="$volume" '{ for (i = 1; i <= 3; i++) gsub(/[[:space:]]/, "", $i) } $3 == want && $2 != "" { print $1 "|" $2; exit }')" || return 1
  [ -n "$found" ] || return 1
  vg="\${found%%|*}"
  pool="\${found#*|}"
  sizes="$(command timeout 20 lvs --noheadings --nosuffix --units m --separator '|' -o lv_size,data_percent "$vg/$pool" </dev/null 2>/dev/null \\
    | awk -F'|' '{ for (i = 1; i <= 2; i++) gsub(/[[:space:]]/, "", $i) } NF >= 2 { print $1 "|" $2; exit }')" || return 1
  size="\${sizes%%|*}"
  pct="\${sizes#*|}"
  [[ "$size" =~ ^[0-9]+([.][0-9]+)?$ ]] && [[ "$pct" =~ ^[0-9]+([.][0-9]+)?$ ]] || return 1
  if awk -v p="$pct" 'BEGIN { exit !(p + 0 > ${HIBERNATE_POOL_MAX_PERCENT}) }'; then POOL_REASON=pool_full; return 1; fi
  if ! awk -v s="$size" -v p="$pct" -v m="$mem" 'BEGIN { exit !(s * (100 - p) / 100 >= m * ${HIBERNATE_POOL_HEADROOM_FACTOR}) }'; then POOL_REASON=pool_headroom; return 1; fi
  return 0
}
STEP="$(now_ms)"
pool_gate || finish false "$POOL_REASON" "$FROM"
mark pool "$STEP"
ONBOOT_WAS="$(printf '%s\\n' "$VM_CONFIG" | awk '$1=="onboot:" {print $2; exit}')"
# A host that restarts must not resume a saved computer by itself, and the lock blocks this change afterwards.
# Only an autostart that is on is turned off, and a mark on the host says so, so the wake gives back exactly that.
if [ "$ONBOOT_WAS" = 1 ]; then
  install -d -m 0700 "$ONBOOT_MARK_DIR" || finish false onboot_failed "$FROM"
  : >"$ONBOOT_MARK" || finish false onboot_failed "$FROM"
  if ! qm set "$VMID" --onboot 0 >/dev/null; then rm -f "$ONBOOT_MARK"; finish false onboot_failed "$FROM"; fi
  ONBOOT_PENDING=1
fi
STEP="$(now_ms)"
RC=0
command timeout -k 10 ${HIBERNATE_TIMEOUT_SECONDS} systemd-run --unit="hivra-sleep-$VMID" --collect --wait --quiet qm suspend "$VMID" --todisk 1 </dev/null >/dev/null 2>&1 || RC=$?
observe
mark hibernate "$STEP"
HAS_VMSTATE=0
if printf '%s\\n' "$CONFIG" | grep '^vmstate:' >/dev/null; then HAS_VMSTATE=1; fi
if [ "$OBS" = hibernated ] && [ "$HAS_VMSTATE" = 1 ]; then
  ONBOOT_PENDING=0
  finish true hibernated hibernated
fi
# Not saved. A computer that is still up gets its autostart back.
case "$OBS" in
  awake|napping) if [ "$ONBOOT_WAS" = 1 ]; then qm set "$VMID" --onboot 1 >/dev/null 2>&1 && rm -f "$ONBOOT_MARK" || true; fi ;;
esac
if [ "$RC" = 124 ] || [ "$RC" = 137 ]; then finish false hibernate_timeout "$OBS"; fi
if [ "$RC" != 0 ]; then finish false hibernate_failed "$OBS"; fi
finish false hibernate_unconfirmed "$OBS"`;
}

/**
 * Put one computer to sleep. A nap pauses it with QMP `stop` straight on the
 * VM's monitor socket (milliseconds, RAM stays); a hibernate saves its RAM to
 * disk and stops it (`qm suspend --todisk 1`, run as a systemd unit so a
 * dropped connection cannot interrupt it).
 *
 * Steps: an exclusive non-blocking per-VM lock (busy aborts), the binding tag
 * check and one state read, check the guest is idle (the probe JSON goes in the
 * receipt), act, confirm.
 * Prints one HIVRA_SLEEP_RESULT line.
 */
export function buildSleepHostScript(
  input: SleepHostScriptInput,
  specs: readonly ChannelWakeSpec[] = GENERIC_CHANNEL_SPECS,
): string {
  const tag = assertTarget(input.vmid, input.bindingTag);
  if (input.tier !== "nap" && input.tier !== "hibernate") throw new Error("Invalid sleep tier.");
  const nap = input.tier === "nap";
  const telegramCoverage = assertCoverage(input.telegramCoverage);
  const channelCoverage = assertChannelCoverage(input.channelCoverage, specs);
  if (telegramCoverage && channelCoverage) throw new Error("Invalid channel wake coverage.");
  const coverage: ScriptCoverage | null = channelCoverage
    ? { kind: "channels", coverage: channelCoverage, specs }
    : telegramCoverage ? { kind: "telegram", coverage: telegramCoverage } : null;
  return `set -euo pipefail
VMID=${input.vmid}
EXPECTED_BINDING_TAG=${shellQuote(tag)}
TIER=${input.tier}
# The host script itself arrives on stdin, so no command may read it.
qm() { command timeout -k 5 30 qm "$@" </dev/null; }
${buildVmidBoundGuestExecPrelude()}
${receiptShell("sleep")}
${ctlShell()}
${input.fastConfigRead === true ? `${FAST_QM_SHELL}
` : ""}${stateShell(input.fastConfigRead === true)}
${probeShell(input.manual === true, coverage)}
install -d -m 0755 /run/lock
exec 9>/run/lock/hivra-vm-${input.vmid}.lock
# Another script holds the computer. Whatever it does next, this one changes nothing: say what the host shows now.
flock -x -n 9 || { require_binding; observe; finish false busy "$OBS"; }
require_binding
${nap ? napBody() : hibernateBody()}
`;
}

// ---------------------------------------------------------------------------
// Wake host script
// ---------------------------------------------------------------------------

/** The capacity policy a wake from hibernate is admitted under: the same inputs the start action uses. */
export interface WakeAdmission {
  /** Where `hivra-host-capacity-admission` lives on the host. */
  provisionerDirectory: string;
  hostReserveMb: number;
  enforceCeilings: boolean;
  cpuDensityMilli: number;
  memoryDensityMilli: number;
}

export interface WakeHostScriptInput {
  vmid: number;
  bindingTag: string | null;
  admission: WakeAdmission;
  /** The binding check reads the VM's config file instead of starting the qm CLI. Off by default. */
  fastConfigRead?: boolean;
  /** The guest fixup also drops stale outbound :443 connections (frozen long polls). Off by default. */
  killStaleSockets?: boolean;
}

function assertAdmission(admission: WakeAdmission): void {
  const ok = admission && typeof admission === "object"
    && typeof admission.provisionerDirectory === "string"
    && /^\/[A-Za-z0-9._/-]{1,200}$/.test(admission.provisionerDirectory) && !admission.provisionerDirectory.includes("..")
    && Number.isInteger(admission.hostReserveMb) && admission.hostReserveMb >= 512 && admission.hostReserveMb <= 10_000_000
    && typeof admission.enforceCeilings === "boolean"
    && Number.isInteger(admission.cpuDensityMilli) && admission.cpuDensityMilli >= 1000 && admission.cpuDensityMilli <= 4000
    && Number.isInteger(admission.memoryDensityMilli) && admission.memoryDensityMilli >= 1000 && admission.memoryDensityMilli <= 4000;
  if (!ok) throw new Error("Invalid wake admission policy.");
}

/** fastQmDefined: FAST_QM_SHELL already came earlier in the script, so it is not repeated here. */
function wakeAdmissionShell(admission: WakeAdmission, fastQmDefined: boolean): string {
  return `PROVISIONER_DIR=${shellQuote(admission.provisionerDirectory)}
HOST_RESERVE_MB=${admission.hostReserveMb}
ENFORCE_CEILINGS=${admission.enforceCeilings ? 1 : 0}
CPU_DENSITY_MILLI=${admission.cpuDensityMilli}
MEMORY_DENSITY_MILLI=${admission.memoryDensityMilli}
${fastQmDefined ? "" : `${ADMISSION_FAST_QM_SHELL}
`}run_admission() {
  (
    qm() { hivra_fast_qm "$@"; }
    export -f qm hivra_fast_qm
    export PVE_QEMU_CONF_DIR QEMU_RUN_DIR
    bash "$PROVISIONER_DIR/hivra-host-capacity-admission" "$@"
  )
}
# The same reading of the VM's own config as the start helper.
capacity_inputs() {
  TARGET_FLOOR_MB="$(printf '%s\\n' "$CONFIG" | awk '$1=="balloon:" {print $2; exit}')"
  [[ "$TARGET_FLOOR_MB" =~ ^[0-9]+$ ]] && [ "$TARGET_FLOOR_MB" -gt 0 ] \\
    || TARGET_FLOOR_MB="$(printf '%s\\n' "$CONFIG" | awk '$1=="memory:" {print $2; exit}')"
  TARGET_MAX_MB="$(printf '%s\\n' "$CONFIG" | awk '$1=="memory:" {print $2; exit}')"
  TARGET_MAX_CPU="$(printf '%s\\n' "$CONFIG" | awk '$1=="cpulimit:" {print $2; exit}')"
  if ! [[ "$TARGET_MAX_CPU" =~ ^[0-9]+([.][0-9]+)?$ ]] || [ "$TARGET_MAX_CPU" = "0" ]; then
    local cores sockets
    cores="$(printf '%s\\n' "$CONFIG" | awk '$1=="cores:" {print $2; exit}')"
    sockets="$(printf '%s\\n' "$CONFIG" | awk '$1=="sockets:" {print $2; exit}')"
    [ -n "$sockets" ] || sockets=1
    [[ "$cores" =~ ^[0-9]+$ ]] && [ "$cores" -gt 0 ] && [[ "$sockets" =~ ^[0-9]+$ ]] && [ "$sockets" -gt 0 ] || return 1
    TARGET_MAX_CPU="$((cores * sockets))"
  fi
  [[ "$TARGET_FLOOR_MB" =~ ^[0-9]+$ ]] && [[ "$TARGET_MAX_MB" =~ ^[0-9]+$ ]]
}`;
}

function wakeBody(): string {
  return `STEP="$(now_ms)"
read_state || finish false state_unreadable
mark read_state "$STEP"
FROM="$(tier_of)"
WOKE_REASON=resumed
AGENT_WAIT=${WAKE_AGENT_WAIT_SECONDS}
STEP="$(now_ms)"
case "$ST/$QMP/$LOCK" in
  running/paused/none)
    # QMP cont, confirmed by query-status. If the socket path fails, the CLI gets one try before the wake is called failed.
    ctl 10 qmp "$VMID" cont 5
    if [ "$CTL_OK" != true ]; then
      if ! qm resume "$VMID" >/dev/null; then observe; finish false resume_failed "$OBS"; fi
      observe
      [ "$OBS" = awake ] || finish false resume_unconfirmed "$OBS"
    fi
    ;;
  stopped/*/suspended)
    WOKE_REASON=restored
    AGENT_WAIT=${RESTORE_AGENT_WAIT_SECONDS}
    capacity_inputs || finish false capacity_inputs hibernated
    install -d -m 0755 /run/lock
    exec 8>/run/lock/hivra-allocation.lock
    flock -w 60 8 || finish false lock_timeout hibernated
    # The state may have changed while this waited for the lock.
    read_state || finish false state_unreadable
    [ "$(tier_of)" = hibernated ] || finish false state_changed "$(tier_of)"
    ADMIT="$(now_ms)"
    if ! run_admission "$VMID" "$TARGET_FLOOR_MB" "$TARGET_MAX_MB" "$TARGET_MAX_CPU" \\
        "$HOST_RESERVE_MB" "$ENFORCE_CEILINGS" "$CPU_DENSITY_MILLI" "$MEMORY_DENSITY_MILLI" 0 </dev/null >&2; then
      finish false capacity hibernated
    fi
    mark admission "$ADMIT"
    # The VM process outlives this script, so it must not inherit the lock descriptors.
    START="$(now_ms)"
    # Nor its stderr: the start leaves processes behind that held it, and with it
    # the SSH session, open for about 25 s after the computer was already up.
    if ! command timeout -k 10 ${HIBERNATE_TIMEOUT_SECONDS} qm start "$VMID" 7>&- 8>&- 9>&- >/dev/null 2>"$START_ERR" </dev/null; then
      observe
      finish false start_failed "$OBS"
    fi
    mark start "$START"
    # The lock stays held until the computer is counted as running.
    for _ in $(seq 1 30); do
      if qmp_fast && [ "$QMP" = running ]; then OBS=awake; break; fi
      observe
      [ "$OBS" = awake ] && break
      sleep 1
    done
    [ "$OBS" = awake ] || finish false start_unconfirmed "$OBS"
    flock -u 8
    exec 8>&-
    # Autostart comes back only if the hibernate turned it off.
    if [ -e "$ONBOOT_MARK" ]; then
      qm set "$VMID" --onboot 1 >/dev/null 2>&1 && rm -f "$ONBOOT_MARK" || true
    fi
    ;;
  running/running/none)
    WOKE_REASON=already
    ;;
  stopped/*/none)
    TO=cold
    finish false cold cold
    ;;
  *)
    finish false unexpected_state unknown
    ;;
esac
mark resume "$STEP"
# From here the computer is running. A failed fixup leaves it running and says what failed.
# One guest exec over the guest agent socket: set the clock from this host, kill the tunnel hard, restart it.
# After a restore the agent may need a few seconds to answer; the helper retries until AGENT_WAIT runs out.
STEP="$(now_ms)"
ctl $((AGENT_WAIT + 45)) fixup "$VMID" "$AGENT_WAIT"
VIA="$CTL_VIA"
TRIES="$CTL_TRIES"
if [ -n "$CTL_STEPS" ]; then STEPS="\${STEPS:+$STEPS,}$CTL_STEPS"; fi
mark fixup "$STEP"
[ "$CTL_OK" = true ] || finish false "$CTL_REASON" awake
finish true "$WOKE_REASON" awake`;
}

/**
 * Wake one computer. A paused one is resumed. A hibernated one is admitted
 * against host capacity exactly as the start action does, holding the host
 * lock across `qm start` until the computer is running, then started and given
 * back its autostart. An already running one only gets the fixups. A stopped
 * one with no saved state prints `to=cold, ok=false` so the caller falls back
 * to the normal start action.
 *
 * A nap is resumed with QMP `cont` (the CLI `qm resume` is the fallback). After
 * any wake ONE guest exec runs through the guest agent socket: set the clock
 * from this host (a guest cannot reach NTP and its clock froze), hard-kill the
 * tunnel and restart it. The caller then polls the public health check.
 * Prints one HIVRA_WAKE_RESULT line.
 */
export function buildWakeHostScript(input: WakeHostScriptInput): string {
  const tag = assertTarget(input.vmid, input.bindingTag);
  assertAdmission(input.admission);
  return `set -euo pipefail
VMID=${input.vmid}
EXPECTED_BINDING_TAG=${shellQuote(tag)}
# The host script itself arrives on stdin, so no command may read it.
qm() { command timeout -k 5 30 qm "$@" </dev/null; }
${receiptShell("wake")}
${ctlShell(input.killStaleSockets === true)}
${input.fastConfigRead === true ? `${FAST_QM_SHELL}
` : ""}${stateShell(input.fastConfigRead === true)}
${wakeAdmissionShell(input.admission, input.fastConfigRead === true)}
install -d -m 0755 /run/lock
# The sleep script holds this lock while it works. A wake never runs beside it:
# it would see a computer that is about to be paused and report it awake. It
# waits a little, then says busy with what the host shows, and changes nothing.
exec 9>/run/lock/hivra-vm-${input.vmid}.lock
flock -x -w ${WAKE_LOCK_WAIT_SECONDS} 9 || { require_binding; observe; finish false busy "$OBS"; }
require_binding
${wakeBody()}
`;
}

// ---------------------------------------------------------------------------
// Receipt parsers
// ---------------------------------------------------------------------------

const OBSERVED_STATES: readonly string[] = ["awake", "napping", "hibernated", "cold", "unknown"];
const REASON = /^[a-z_]{1,40}$/;
const STEP_NAME = /^[a-z_]{1,24}$/;
const MS_MAX = 24 * 60 * 60 * 1000;

interface ReceiptBase {
  ok: boolean;
  vmid: number;
  from: ObservedSleepState;
  to: ObservedSleepState;
  reason: string;
  ms: number;
  /** Step timings in milliseconds. */
  steps: Record<string, number>;
}

export interface SleepReceipt extends ReceiptBase {
  tier: SleepScriptTier;
  /** The idle probe's answer from inside the script, or null when it did not run. */
  probe: IdleProbe | null;
}

export interface WakeReceipt extends ReceiptBase {
  /** How the guest fixup ran: over the guest agent socket, through `qm guest exec`, or not at all. */
  via: "socket" | "qm" | "none";
  /** How many times the guest agent socket was tried. */
  tries: number;
}

function readReceiptLine(stdout: string, prefix: string): Record<string, unknown> | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return null;
  let value: unknown;
  try { value = JSON.parse(lines[0].slice(prefix.length)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readReceiptBase(row: Record<string, unknown>, expectedVmid?: number): ReceiptBase | null {
  const steps = row.steps;
  if (typeof row.ok !== "boolean"
      || !Number.isSafeInteger(row.vmid) || (row.vmid as number) < MIN_VMID
      || (expectedVmid !== undefined && row.vmid !== expectedVmid)
      || typeof row.from !== "string" || !OBSERVED_STATES.includes(row.from)
      || typeof row.to !== "string" || !OBSERVED_STATES.includes(row.to)
      || typeof row.reason !== "string" || !REASON.test(row.reason)
      || !Number.isInteger(row.ms) || (row.ms as number) < 0 || (row.ms as number) > MS_MAX
      || !steps || typeof steps !== "object" || Array.isArray(steps)) return null;
  const entries = Object.entries(steps as Record<string, unknown>);
  if (entries.length > 16) return null;
  const timings: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (!STEP_NAME.test(name) || !Number.isInteger(value) || (value as number) < 0 || (value as number) > MS_MAX) return null;
    timings[name] = value as number;
  }
  return {
    ok: row.ok,
    vmid: row.vmid as number,
    from: row.from as ObservedSleepState,
    to: row.to as ObservedSleepState,
    reason: row.reason,
    ms: row.ms as number,
    steps: timings,
  };
}

/** Strict read of the sleep script's one receipt line. Anything else is null, and null counts as a failure. */
export function parseSleepReceipt(stdout: string, expectedVmid?: number): SleepReceipt | null {
  const row = readReceiptLine(stdout, SLEEP_RESULT_PREFIX);
  if (!row) return null;
  const base = readReceiptBase(row, expectedVmid);
  if (!base || (row.tier !== "nap" && row.tier !== "hibernate")) return null;
  let probe: IdleProbe | null = null;
  if (row.probe !== null) {
    // A failed run keeps its receipt even when the guest's probe was malformed; a success needs a valid one.
    probe = validateIdleProbe(row.probe);
    if (!probe && base.ok) return null;
  }
  // A nap is only a success with the probe that justified it in hand.
  if (base.ok && row.tier === "nap" && !probe) return null;
  // A success must end where its tier says.
  if (base.ok && base.to !== (row.tier === "nap" ? "napping" : "hibernated")) return null;
  return { ...base, tier: row.tier, probe };
}

/** Strict read of the wake script's one receipt line. Anything else is null, and null counts as a failure. */
export function parseWakeReceipt(stdout: string, expectedVmid?: number): WakeReceipt | null {
  const row = readReceiptLine(stdout, WAKE_RESULT_PREFIX);
  if (!row) return null;
  const base = readReceiptBase(row, expectedVmid);
  if (!base) return null;
  // A success is an awake computer.
  if (base.ok && base.to !== "awake") return null;
  // Older receipts carry neither field.
  const via = row.via === undefined ? "none" : row.via;
  if (via !== "socket" && via !== "qm" && via !== "none") return null;
  const tries = row.tries === undefined ? 0 : row.tries;
  if (!Number.isInteger(tries) || (tries as number) < 0 || (tries as number) > 100_000) return null;
  // A success went through a fixup, so it says how.
  if (base.ok && base.reason !== "cold" && via === "none" && row.via !== undefined) return null;
  return { ...base, via, tries: tries as number };
}
