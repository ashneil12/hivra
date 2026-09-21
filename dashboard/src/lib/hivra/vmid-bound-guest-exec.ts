/**
 * Build host-side helpers for executing bounded programs in one exact Proxmox
 * VM through QEMU Guest Agent's VMID-scoped virtio channel.
 *
 * Private IP reachability is not an identity boundary. Even a pinned SSH host
 * key can be cloned into an image or reached through stale routing. `qm guest
 * exec` selects the already-authorised VMID without consulting the guest
 * network and accepts at most 1 MiB of stdin, which is sufficient for Hivra's
 * small guest-operation bundles.
 *
 * Callers must define and validate VMID before appending this prelude.
 */
export function buildVmidBoundGuestExecPrelude(): string {
  return String.raw`HIVRA_QGA_RESULT_FILE=""
cleanup_hivra_qga_result() {
  case "${"$"}{HIVRA_QGA_RESULT_FILE:-}" in
    /run/hivra-qga-result.*) rm -f -- "$HIVRA_QGA_RESULT_FILE" ;;
    "") ;;
    *) printf 'refusing to remove unexpected QGA result file\n' >&2; return 1 ;;
  esac
  HIVRA_QGA_RESULT_FILE=""
}
trap cleanup_hivra_qga_result EXIT HUP INT TERM
decode_hivra_qga_result() {
  local decode_status=0
  [ "$(stat -c '%s' "$HIVRA_QGA_RESULT_FILE")" -le 1048576 ] || {
    printf 'HIVRA_QGA_FAILURE result_too_large\n' >&2
    cleanup_hivra_qga_result
    return 125
  }
  /usr/bin/perl -MJSON::PP - "$HIVRA_QGA_RESULT_FILE" <<'HIVRA_QGA_DECODE' || decode_status=$?
use strict;
use warnings;
my $path = shift @ARGV;
my ($stdout, $stderr, $exitcode);
eval {
    open my $stream, '<', $path or die "open";
    local $/;
    my $raw = <$stream>;
    my $document = JSON::PP::decode_json($raw);
    close $stream;
    die "shape" unless ref($document) eq 'HASH' && $document->{exited};
    $exitcode = $document->{exitcode};
    my @exitcode_tokens = $raw =~ /"exitcode"\s*:\s*(\d+)/g;
    my @exited_tokens = $raw =~ /"exited"\s*:\s*(?:1|true)(?:\s*[,}])/g;
    die "exitcode" unless defined($exitcode) && !ref($exitcode) && @exitcode_tokens == 1
        && @exited_tokens == 1 && "$exitcode" eq "$exitcode_tokens[0]";
    $stdout = exists($document->{'out-data'}) ? $document->{'out-data'} : '';
    $stderr = exists($document->{'err-data'}) ? $document->{'err-data'} : '';
    die "streams" if ref($stdout) || ref($stderr);
};
if ($@) {
    print STDERR "HIVRA_QGA_FAILURE result_invalid\n";
    exit 125;
}
print STDOUT $stdout;
print STDERR $stderr;
exit($exitcode >= 0 && $exitcode <= 255 ? $exitcode : 125);
HIVRA_QGA_DECODE
  cleanup_hivra_qga_result
  if [ "$decode_status" -ne 0 ]; then
    printf 'HIVRA_QGA_FAILURE guest_exit_%s\n' "$decode_status" >&2
  fi
  return "$decode_status"
}
run_vmid_bound_guest_exec() {
  HIVRA_QGA_RESULT_FILE="$(mktemp /run/hivra-qga-result.XXXXXXXX)"
  chmod 0600 "$HIVRA_QGA_RESULT_FILE"
  if ! qm guest exec "$VMID" --timeout 0 -- "$@" > "$HIVRA_QGA_RESULT_FILE"; then
    printf 'HIVRA_QGA_FAILURE dispatch\n' >&2
    cleanup_hivra_qga_result
    return 125
  fi
  decode_hivra_qga_result
}
run_vmid_bound_guest_exec_stdin() {
  HIVRA_QGA_RESULT_FILE="$(mktemp /run/hivra-qga-result.XXXXXXXX)"
  chmod 0600 "$HIVRA_QGA_RESULT_FILE"
  if ! qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@" > "$HIVRA_QGA_RESULT_FILE"; then
    printf 'HIVRA_QGA_FAILURE dispatch_stdin\n' >&2
    cleanup_hivra_qga_result
    return 125
  fi
  decode_hivra_qga_result
}`;
}
