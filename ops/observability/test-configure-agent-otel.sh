#!/usr/bin/env bash
# Regression checks for configure-agent-otel.sh. The script runs as root on a guest,
# and the agent user owns everything under its home, so the script must never follow
# or replace a path the agent planted. These checks plant the links the agent could
# create and assert the script refuses them and leaves the link targets alone.
#
# Runs as a non-root user only. The fixtures are owned by the invoking user, and the
# script refuses a home that root owns, so a root run would fail every case for the
# wrong reason and pass the link cases without reaching the link logic. The agent
# step always runs through a stand-in for runuser: util-linux runuser refuses a
# non-root caller, so a Linux CI runner would fail every case before the script
# reaches the link logic. On macOS a stand-in also replaces GNU stat. The root-only
# privilege boundary (runuser to a real agent account) is NOT exercised here and is
# unverified on a Linux guest.
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  echo "run this test as a non-root user; see the note above" >&2
  exit 2
fi

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/configure-agent-otel.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/configure-agent-otel-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fakes="$work/bin"
mkdir -p "$fakes"
# Always a stand-in, even where runuser exists: see the note at the top.
cat >"$fakes/runuser" <<'STUB'
#!/bin/sh
# Test stand-in: drop "-u USER --" and run the rest as the current user.
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
STUB
chmod 0755 "$fakes/runuser"
if ! stat -c %U / >/dev/null 2>&1; then
  cat >"$fakes/stat" <<'STUB'
#!/bin/sh
# Test stand-in for GNU `stat -c FORMAT PATH` on BSD systems.
case "$2" in
  %U) exec /usr/bin/stat -f %Su "$3" ;;
  %u) exec /usr/bin/stat -f %u "$3" ;;
  '%U:%G') exec /usr/bin/stat -f '%Su:%Sg' "$3" ;;
  *) exit 2 ;;
esac
STUB
  chmod 0755 "$fakes/stat"
fi
export PATH="$fakes:$PATH"

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failures=$((failures + 1)); }

# A fresh sysroot and agent home for each case.
fixture() {
  case_dir="$work/$1"
  rm -rf "$case_dir"
  mkdir -p "$case_dir/home/agent/.codex" "$case_dir/sysroot"
  home="$case_dir/home/agent"
  sysroot="$case_dir/sysroot"
}

run_script() {
  set +e
  "$script" http://127.0.0.1:4318 "$home" "$sysroot" >"$case_dir/out" 2>"$case_dir/err"
  status=$?
  set -e
}

# 1. A clean home gets a managed block, mode 0600, and a rerun does not duplicate it.
fixture clean-home
run_script
if [ "$status" -eq 0 ] && grep -Fq '# hivra-activity-otel:start' "$home/.codex/config.toml"; then
  pass "clean home: block written"
else
  fail "clean home: block written (exit $status: $(cat "$case_dir/err"))"
fi
run_script
if [ "$status" -eq 0 ] && [ "$(grep -Fc '# hivra-activity-otel:start' "$home/.codex/config.toml")" -eq 1 ]; then
  pass "clean home: rerun keeps one block"
else
  fail "clean home: rerun keeps one block (exit $status)"
fi

# A refusal writes nothing outside the agent's own files, so no profile.d either.
no_profile_write() {
  if [ -e "$sysroot/etc/profile.d/hivra-agent-otel.sh" ]; then
    fail "$1: no profile.d written on refusal"
  else
    pass "$1: no profile.d written on refusal"
  fi
}

# 2. The agent plants config.toml as a link to a file it must not reach.
fixture config-link
secret="$case_dir/secret.txt"
printf 'ROOT_ONLY_SECRET=1\n' >"$secret"
ln -s "$secret" "$home/.codex/config.toml"
run_script
# Exit 4 exactly: any other non-zero exit would be a refusal for another reason.
if [ "$status" -eq 4 ] && [ -L "$home/.codex/config.toml" ] && [ "$(cat "$secret")" = "ROOT_ONLY_SECRET=1" ]; then
  pass "config link: refused with exit 4, link and target untouched"
else
  fail "config link: refused with exit 4, link and target untouched (exit $status, link=$([ -L "$home/.codex/config.toml" ] && echo yes || echo no))"
fi
no_profile_write "config link"
if grep -Fq 'ROOT_ONLY_SECRET' "$case_dir/out" "$case_dir/err" 2>/dev/null; then
  fail "config link: secret not echoed"
else
  pass "config link: secret not echoed"
fi

# 3. The agent plants .codex itself as a link to another directory.
fixture dir-link
elsewhere="$case_dir/elsewhere"
mkdir -p "$elsewhere"
printf 'ELSEWHERE=1\n' >"$elsewhere/config.toml"
rm -rf "$home/.codex"
ln -s "$elsewhere" "$home/.codex"
run_script
if [ "$status" -eq 4 ] && [ -L "$home/.codex" ] && [ "$(cat "$elsewhere/config.toml")" = "ELSEWHERE=1" ]; then
  pass "dir link: refused with exit 4, link and target untouched"
else
  fail "dir link: refused with exit 4, link and target untouched (exit $status)"
fi
no_profile_write "dir link"

# 4. An unmanaged [otel] block is still refused, and left alone.
fixture unmanaged-otel
printf '[otel]\nenvironment = "theirs"\n' >"$home/.codex/config.toml"
run_script
if [ "$status" -eq 3 ] && grep -Fq 'environment = "theirs"' "$home/.codex/config.toml"; then
  pass "unmanaged [otel]: refused with exit 3"
else
  fail "unmanaged [otel]: refused with exit 3 (exit $status)"
fi
no_profile_write "unmanaged [otel]"

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
