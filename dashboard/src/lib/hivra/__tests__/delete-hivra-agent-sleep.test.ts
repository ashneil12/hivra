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

const OPERATION = "11111111-1111-4111-8111-111111111111";
const BINDING = `hivra-bind-${"a".repeat(32)}`;
const OP_TAG = `hivra-op-${OPERATION.replace(/-/g, "")}`;

// A stub qm that refuses stop and destroy while the config lock is held, as PVE does.
const stubQm = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ROOT/calls"
case "$1" in
  status) [ -f "$ROOT/exists" ] || exit 2; echo "status: $(cat "$ROOT/status")" ;;
  config) echo "tags: ${OP_TAG};${BINDING}"; [ -s "$ROOT/lock" ] && echo "lock: $(cat "$ROOT/lock")"; exit 0 ;;
  stop|destroy)
    case "$*" in *--skiplock*) SKIP=1 ;; *) SKIP= ;; esac
    if [ -s "$ROOT/lock" ] && [ -z "$SKIP" ]; then echo "VM is locked" >&2; exit 25; fi
    [ "$1" = destroy ] && rm -f "$ROOT/exists"
    exit 0 ;;
esac
`;

function runDestroy(lock: string) {
  const root = mkdtempSync(path.join(tmpdir(), "delete-sleep-"));
  try {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin/qm"), stubQm);
    for (const name of ["flock", "sleep"]) writeFileSync(path.join(root, "bin", name), "#!/bin/sh\nexit 0\n");
    writeFileSync(path.join(root, "bin/pvesm"), "#!/bin/sh\nexit 0\n");
    for (const name of ["qm", "flock", "sleep", "pvesm"]) chmodSync(path.join(root, "bin", name), 0o755);
    writeFileSync(path.join(root, "exists"), "");
    writeFileSync(path.join(root, "status"), lock ? "stopped" : "running");
    writeFileSync(path.join(root, "lock"), lock);
    writeFileSync(path.join(root, "calls"), "");
    const script = verifiedDestroyHivraVmScript({
      vmid: 123, storage: "local-lvm", expectedAllocationOperationId: OPERATION,
      expectedInfrastructureBindingTag: BINDING, allowManagedLegacyAuthority: false, cleanupPaths: [path.join(root, "log")],
    }).replaceAll("/run/lock", path.join(root, "lock-dir")).replaceAll("/run/hivra-provision", path.join(root, "prov"))
      .replaceAll("/var/lib/hivra/provision-results", path.join(root, "results"));
    const result = spawnSync("bash", [], {
      input: script, encoding: "utf8",
      env: { ...process.env, ROOT: root, PATH: `${path.join(root, "bin")}:${process.env.PATH}` },
    });
    return {
      code: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: readFileSync(path.join(root, "calls"), "utf8").split("\n").filter(Boolean),
      stillThere: existsSync(path.join(root, "exists")),
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
