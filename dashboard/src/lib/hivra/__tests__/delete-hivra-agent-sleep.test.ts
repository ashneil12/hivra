/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));
jest.mock("@/lib/hivra/agent-delete-cleanup", () => ({ HivraAgentDeleteCleanupError: class extends Error {} }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({
  describeHivraAgentExecutionContextError: jest.fn(),
  hivraAgentProvisionLogPath: jest.fn(),
  hivraAgentProvisionSecretPath: jest.fn(),
  hivraAgentStartLogPath: jest.fn(),
  resolveHivraAgentTeardownExecutionContext: jest.fn(),
}));
jest.mock("@/lib/hivra/tailscale-private-access", () => ({
  hivraPrivateAccessAuthority: jest.fn(),
  prepareHivraTailscaleForDelete: jest.fn(),
  sameHivraPrivateAccessAuthority: jest.fn(),
}));
const mockRequestDelete = jest.fn();
jest.mock("@/lib/hivra/agent-operation-store", () => ({
  completeHivraAgentDelete: jest.fn(),
  releaseHivraAgentOperation: jest.fn(),
  requestHivraAgentDelete: (...args: unknown[]) => mockRequestDelete(...args),
}));
const mockWake = jest.fn();
jest.mock("@/lib/hivra/sleep-aware", () => ({ wakeForUserAction: (...args: unknown[]) => mockWake(...args) }));

import { deleteProxmoxHivraAgent, verifiedDestroyHivraVmScript } from "../delete-hivra-agent";
import { backupJobFiles } from "../computer-backups/scripts";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_OPERATION = "22222222-2222-4222-8222-222222222222";
const BINDING = `hivra-bind-${"a".repeat(32)}`;
const OP_TAG = `hivra-op-${OPERATION.replace(/-/g, "")}`;
const SNAPSHOT = `hivrabk_${OPERATION.replace(/-/g, "")}`;

// A stub qm that refuses stop and destroy while the config lock is held, as PVE does.
const stubQm = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${CALLS:-$ROOT/calls}"
case "$1" in
  status)
    [ -f "$ROOT/exists" ] || exit 2
    echo "status: $(cat "$ROOT/status")"
    echo "qmpstatus: $(cat "$ROOT/status")" ;;
  config)
    echo "tags: ${OP_TAG};${BINDING}"
    echo "scsi0: local-lvm:vm-123-disk-0"
    [ -s "$ROOT/lock" ] && echo "lock: $(cat "$ROOT/lock")"; exit 0 ;;
  listsnapshot) [ ! -f "$ROOT/snapshot" ] || printf '%s\\n' '   \`-> ${SNAPSHOT} backup' ;;
  snapshot) touch "$ROOT/snapshot" ;;
  delsnapshot) [ "\${CLEANUP_FAILS:-0}" = 0 ] && rm -f "$ROOT/snapshot" ;;
  stop|destroy)
    case "$*" in *--skiplock*) SKIP=1 ;; *) SKIP= ;; esac
    if [ -s "$ROOT/lock" ] && [ -z "$SKIP" ]; then echo "VM is locked" >&2; exit 25; fi
    [ "$1" = destroy ] && rm -f "$ROOT/exists"
    exit 0 ;;
esac
`;

const realFlock = `#!/usr/bin/env python3
import fcntl, sys
try:
    flags = fcntl.LOCK_UN if '-u' in sys.argv else fcntl.LOCK_EX | fcntl.LOCK_NB
    fcntl.flock(int(sys.argv[-1]), flags)
except OSError:
    sys.exit(1)
`;

const stubRestic = `#!/bin/bash
if [ "$1" = backup ] && [[ "$*" == *scsi0.raw* ]]; then
  CALLS="$ROOT/during-upload.calls" bash "$ROOT/destroy.sh" 3>&- 7>&- 9>&- >"$ROOT/during-upload.out" 2>"$ROOT/during-upload.err"
  printf '%s' "$?" > "$ROOT/during-upload.status"
  printf '%064d\\n' 0 > "$ROOT/scsi0.sha256"
  printf '{"message_type":"summary","snapshot_id":"%064d","data_added":1}\\n' 0
fi
if [ "$1" = forget ]; then touch "$ROOT/pruned"; fi
exit 0
`;

function runDestroy(lock: string, options: { matching?: boolean; remainingDisk?: boolean; backup?: "cleaned" | "cleanup_failed" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "delete-sleep-"));
  try {
    mkdirSync(path.join(root, "bin"));
    const put = (name: string, body: string) => {
      const file = path.join(root, "bin", name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    };
    const noop = "#!/bin/sh\nexit 0\n";
    put("qm", stubQm);
    put("flock", options.backup ? realFlock : noop);
    put("sleep", noop);
    put("pvesm", `#!/bin/sh
case "$1" in
  status) printf 'Name Type Status\\nlocal-lvm lvmthin active\\n' ;;
  path) echo /dev/pve/vm-123-disk-0 ;;
  list) ${options.remainingDisk ? `echo snap_vm-123-disk-0_${SNAPSHOT}` : ":"} ;;
  *) exit 1 ;;
esac
`);
    put("stat", "#!/bin/sh\necho 600:0:0\n");
    writeFileSync(path.join(root, "exists"), "");
    writeFileSync(path.join(root, "status"), lock ? "stopped" : "running");
    writeFileSync(path.join(root, "lock"), lock);
    writeFileSync(path.join(root, "calls"), "");
    const intents = path.join(root, "operations");
    mkdirSync(intents);
    const intent = path.join(intents, `operation-${OPERATION}.selected`);
    const otherIntent = path.join(intents, `operation-${OTHER_OPERATION}.selected`);
    writeFileSync(intent, `operation_id=${OPERATION}\nvmid=${options.matching === false ? 124 : 123}\nip=10.251.20.50\nbinding_tag=${BINDING}\nbinding_enforced=1\n`);
    writeFileSync(otherIntent, "unrelated reservation\n");
    const script = verifiedDestroyHivraVmScript({
      vmid: 123, storage: "local-lvm", expectedAllocationOperationId: OPERATION,
      expectedInfrastructureBindingTag: BINDING, allowManagedLegacyAuthority: false, cleanupPaths: [path.join(root, "log")],
    }).replaceAll("/run/lock", path.join(root, "lock-dir")).replaceAll("/run/hivra-provision", path.join(root, "prov"))
      .replaceAll("/var/lib/hivra/provision-results", path.join(root, "results"))
      .replaceAll("/var/lib/hivra/provision-operations", intents);
    const env = { ...process.env, ROOT: root, PATH: `${path.join(root, "bin")}:${process.env.PATH}` };
    let backup;
    if (options.backup) {
      put("restic", stubRestic);
      put("timeout", '#!/bin/sh\nshift 3\nexec "$@"\n');
      put("ionice", '#!/bin/sh\nshift\nexec "$@"\n');
      put("lvchange", noop);
      put("blockdev", "#!/bin/sh\necho 4096\n");
      const lockDir = path.join(root, "lock-dir");
      mkdirSync(lockDir);
      const job = backupJobFiles("backup").run.replaceAll("/run/lock", lockDir)
        .replaceAll("/var/lib/hivra/restic-cache", path.join(root, "restic-cache"));
      writeFileSync(path.join(root, "run.sh"), job);
      writeFileSync(path.join(root, "destroy.sh"), script);
      writeFileSync(path.join(root, "params"), `JOB_ID=${OPERATION}\nKIND=backup\nAGENT_ID=${OPERATION}\nVMID=123\nEXPECTED_BINDING_TAG=${BINDING}\nKEEP_DAILY=7\nKEEP_WEEKLY=4\nUPLOAD_LIMIT_KIB=0\n`);
      writeFileSync(path.join(root, "secret"), "RESTIC_PASSWORD=stub\n");
      const run = spawnSync("bash", [path.join(root, "run.sh")], {
        encoding: "utf8", timeout: 25_000,
        env: { ...env, CLEANUP_FAILS: options.backup === "cleanup_failed" ? "1" : "0" },
      });
      const receipt = readFileSync(path.join(root, "result.json"), "utf8");
      if (run.status !== 0 || !existsSync(path.join(root, "during-upload.status"))) {
        throw new Error(`Backup did not reach the upload fixture: ${run.stderr}\n${receipt}\n${readFileSync(path.join(root, "calls"), "utf8")}`);
      }
      backup = {
        result: JSON.parse(receipt),
        duringCode: readFileSync(path.join(root, "during-upload.status"), "utf8"),
        duringErr: readFileSync(path.join(root, "during-upload.err"), "utf8"),
        touchedVmDuringUpload: existsSync(path.join(root, "during-upload.calls")),
        pruned: existsSync(path.join(root, "pruned")),
      };
    }
    const result = spawnSync("bash", [], { input: script, encoding: "utf8", env, timeout: 15_000 });
    return {
      code: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: readFileSync(path.join(root, "calls"), "utf8").split("\n").filter(Boolean),
      stillThere: existsSync(path.join(root, "exists")),
      intentPresent: existsSync(intent),
      otherIntentPresent: existsSync(otherIntent),
      snapshotPresent: existsSync(path.join(root, "snapshot")),
      backup,
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("destroy script and a hibernated computer", () => {
  it("destroys a hibernated computer, skipping its config lock only after the tag check", () => {
    const result = runDestroy("suspended");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stillThere).toBe(false);
    expect(result.calls.find((call) => call.startsWith("destroy"))).toContain("--skiplock 1");
    expect(result.calls.find((call) => call.startsWith("stop"))).toContain("--skiplock 1");
    // The tag is read (qm config) before anything is stopped or destroyed.
    expect(result.calls.findIndex((call) => call.startsWith("config"))).toBeLessThan(result.calls.findIndex((call) => call.startsWith("stop")));
  });

  it("does not skip the lock for a computer that is not hibernated", () => {
    const result = runDestroy("");
    expect(result.code).toBe(0);
    expect(result.stillThere).toBe(false);
    expect(result.calls.some((call) => call.includes("--skiplock"))).toBe(false);
  });

  it("refuses Delete before touching the VM during a real backup-script upload, then deletes after cleanup", () => {
    const result = runDestroy("", { backup: "cleaned" });
    expect(result.backup).toMatchObject({
      result: { status: "succeeded", reason: "saved" },
      duringCode: "1", duringErr: expect.stringContaining("Backup is active"),
      touchedVmDuringUpload: false, pruned: true,
    });
    expect(result).toMatchObject({ code: 0, stillThere: false, snapshotPresent: false, intentPresent: false });
  });

  it("reports failed snapshot cleanup and refuses to destroy the VM while the snapshot remains", () => {
    const result = runDestroy("", { backup: "cleanup_failed" });
    expect(result.backup).toMatchObject({ result: { status: "failed", reason: "snapshot_cleanup_failed" }, pruned: false });
    expect(result).toMatchObject({ code: 1, stillThere: true, snapshotPresent: true, intentPresent: true });
    expect(result.stderr).toContain("still has a backup snapshot");
    expect(result.calls.some((call) => /^(stop|destroy) /.test(call))).toBe(false);
  });

  it("clears the original allocation reservation after verified deletion without touching another reservation", () => {
    expect(runDestroy("")).toMatchObject({ code: 0, stillThere: false, intentPresent: false, otherIntentPresent: true });
  });

  it("keeps the reservation if volumes remain or its identity does not match the deleted allocation", () => {
    expect(runDestroy("", { remainingDisk: true })).toMatchObject({ code: 1, intentPresent: true, otherIntentPresent: true });
    expect(runDestroy("", { matching: false })).toMatchObject({ code: 1, intentPresent: true, otherIntentPresent: true });
  });

  it("keeps the ownership check ahead of the skip: a changed tag still refuses", () => {
    const script = verifiedDestroyHivraVmScript({
      vmid: 123, storage: "local-lvm", expectedAllocationOperationId: OPERATION,
      expectedInfrastructureBindingTag: BINDING, allowManagedLegacyAuthority: false, cleanupPaths: [],
    });
    expect(script.indexOf("ownership changed before deletion")).toBeLessThan(script.indexOf("--skiplock 1"));
  });
});

describe("deleteProxmoxHivraAgent and a sleeping computer", () => {
  it("wakes the computer first, for any owner, and does not depend on the answer", async () => {
    mockWake.mockResolvedValue({ ok: false, reason: "failed", status: 503, code: "computer_asleep", message: "x" });
    mockRequestDelete.mockResolvedValue("not_found");
    const row = { id: "agent-1", status: "running", sleep_state: "hibernated" };
    expect(await deleteProxmoxHivraAgent("owner", row)).toEqual({ ok: false, message: "Agent not found", status: 404 });
    expect(mockWake).toHaveBeenCalledWith(row, { allowLapsed: true });
    expect(mockWake.mock.invocationCallOrder[0]).toBeLessThan(mockRequestDelete.mock.invocationCallOrder[0]);
  });

  it("still deletes when the wake itself throws", async () => {
    mockWake.mockRejectedValue(new Error("down"));
    mockRequestDelete.mockResolvedValue("deleted");
    expect(await deleteProxmoxHivraAgent("owner", { id: "agent-1", sleep_state: "napping", status: "running" })).toEqual({ ok: true });
  });

  it("does not wait on a sleep state left behind when the delete was already requested", async () => {
    mockWake.mockClear();
    mockRequestDelete.mockResolvedValue("deleted");
    expect(await deleteProxmoxHivraAgent("owner", { id: "agent-1", status: "running", desired_state: "deleted", sleep_state: "waking" })).toEqual({ ok: true });
    expect(mockWake).not.toHaveBeenCalled();
  });
});
