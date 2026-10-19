import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProxmoxPowerScript } from "@/lib/services/proxmox/script-builders";
import { verifiedStopVmScript } from "@/lib/hivra/agent-power-scripts";

const identity = "11111111-1111-4111-8111-111111111111";
const fakeQm = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ROOT/calls"
case "$1" in
status) printf 'status: %s\\n' "$(cat "$ROOT/status")" ;;
config) printf 'name: %s\\ntags: %s\\nonboot: %s\\n' "$NAME" "$TAG" "$READBACK" ;;
set) [ "$WRITE_FAIL" = 0 ] || exit 1 ;;
shutdown|stop) printf stopped > "$ROOT/status" ;;
esac
`;
function execute(kind: "legacy" | "computer", overrides: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "deleted-owner-power-"));
  try {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin/qm"), fakeQm, { mode: 0o755 });
    writeFileSync(path.join(root, "bin/flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(root, "status"), overrides.STATE || "running");
    const script = kind === "legacy"
      ? buildProxmoxPowerScript({ vmid: 123, expectedInstanceId: identity, action: "shutdown", setOnboot: 0, verifyOnboot: true })
      : verifiedStopVmScript(123, 1, "hivra-bind-fixture", true);
    const result = spawnSync("bash", [], { input: script.replaceAll("/run/lock", path.join(root, "lock")), encoding: "utf8", env: {
      ...process.env, ROOT: root, PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      NAME: "hermes-fixture-11111111", TAG: "hivra-bind-fixture", READBACK: "0", WRITE_FAIL: "0", ...overrides,
    } });
    return { code: result.status, calls: readFileSync(path.join(root, "calls"), "utf8"), state: readFileSync(path.join(root, "status"), "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
for (const kind of ["legacy", "computer"] as const) {
  describe(`${kind} deleted owner shutdown`, () => {
    it("still stops the VM when disabling autostart fails, and reports incomplete", () => {
      const result = execute(kind, { WRITE_FAIL: "1" });
      expect(result.state).toBe("stopped");
      expect(result.code).not.toBe(0);
    });
    it("rejects incorrect autostart readback", () => {
      expect(execute(kind, { READBACK: "1" }).code).not.toBe(0);
    });
    it("verifies autostart even when the VM was already stopped", () => {
      const result = execute(kind, { STATE: "stopped" });
      expect(result.code).toBe(0);
      expect(result.calls).toContain("set 123 --onboot 0");
      expect(result.calls).not.toContain("shutdown");
    });
    it("refuses a different VM identity before any mutation", () => {
      const result = execute(kind, { NAME: "foreign-vm", TAG: "foreign-tag" });
      expect(result.code).not.toBe(0);
      expect(result.calls).not.toContain("set 123");
      expect(result.calls).not.toContain("shutdown");
    });
  });
}
