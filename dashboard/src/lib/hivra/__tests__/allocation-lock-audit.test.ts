import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocationLockAcquired } from "../allocation-lock-audit";

it("attributes a real acquisition without handing the allocation lock to the logger", () => {
  const dir = mkdtempSync(join(tmpdir(), "hivra-lock-audit-"));
  try {
    const lock = join(dir, "allocation.lock");
    const audit = join(dir, "audit");
    writeFileSync(join(dir, "logger"), `#!/usr/bin/env bash
set -eu
[ ! -e /proc/self/fd/8 ] && [ ! -e /proc/self/fd/9 ]
exec 7>"$LOCK"
! flock -nx 7
printf '%s\\n' "$*" > "$AUDIT"
exit 1
`, { mode: 0o700 });
    const result = spawnSync("bash", ["-c", `set -eu
exec 8>"$LOCK"
exec 9>/dev/null
flock -nx 8
${allocationLockAcquired("agent-disk-wake")}
printf '%s\\n' "$BASHPID"
`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOCK: lock, AUDIT: audit },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(audit, "utf8")).toBe(
      `--socket-errors=off -t hivra-allocation-lock -- event=acquired mode=exclusive operation=agent-disk-wake holder_pid=${result.stdout.trim()}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("does not allow dynamic text or credentials in operation labels", () => {
  expect(() => allocationLockAcquired("launch\ncredential=example")).toThrow("Invalid allocation lock operation");
});
