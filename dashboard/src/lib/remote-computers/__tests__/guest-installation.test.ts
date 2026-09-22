import {
  buildRemoteDesktopGuestInstallScript,
  buildRemoteDesktopGuestTransportDiagnosticScript,
  diagnoseRemoteDesktopGuestTransport,
  buildRemoteDesktopGuestRestartScript,
  installRemoteDesktopOnHivraAgent,
  verifyRemoteDesktopRestartOnHivraAgent,
} from "@/lib/remote-computers/guest-installation";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const AGENT_ID = "00000000-0000-4000-8000-000000001041";
const OPERATION_ID = "00000000-0000-4000-8000-000000002041";
const BOOT_ID = "00000000-0000-4000-8000-000000003041";
const receipt = (exitCode = 0) => ({ version: 1, operationId: OPERATION_ID, computerId: AGENT_ID,
  vmid: 1112, guestIp: "10.250.20.62", bindingTag: "hivra-bind-exact", bootId: BOOT_ID, exitCode });
const resultReceipt = (exitCode = 0) => ({ ok: true, stdout: `HIVRA_DESKTOP_PREPARE_TERMINAL ${JSON.stringify(receipt(exitCode))}\n`, stderr: "" });
const CONTROL_BYPASS_SECRET = "canary_control_bypass_1234567890";
function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID, user_id: "user_123", type: "linux-desktop", computer_profile: "ubuntu-desktop",
    status: "running", desired_state: "running",
    operation_id: null, operation_kind: null, vmid: 1112, ip: "10.250.20.62",
    chat_url: "https://agent.example.test/webchat?token=redacted", deployment_mode: "hivra-managed",
    proxmox_host: "fixturenode11", infrastructure_binding_token_enforced: true,
    managed_provisioner_channel: "canary", computer_substrate: "proxmox-kvm",
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  let current = agent();
  const context = { kind: "managed", host: "fixturenode11", provisionerChannel: "canary",
    env: { PROXMOX_SSH_HOST: "192.0.2.11" }, paths: { provisionerDirectory: "/root/hivra-provisioner-canary", vmSshKeyPath: "/root/key" },
    infrastructureBindingTag: "hivra-bind-exact", infrastructureBindingTagEnforced: true };
  return {
    loadAgent: jest.fn(async () => current),
    resolveContext: jest.fn().mockResolvedValue(context),
    resolveObservationContext: jest.fn().mockResolvedValue(context),
    syncManagedBundle: jest.fn().mockResolvedValue({ ok: true }),
    runHostScript: jest.fn().mockResolvedValue(resultReceipt()),
    inspectCapability: jest.fn().mockResolvedValue({ ok: true, agentId: AGENT_ID, targetId: "fixturenode11", vmid: 1112 }),
    beginPrepare: jest.fn(async () => {
      current = agent({ operation_id: OPERATION_ID, operation_kind: "desktop_prepare" });
      return { operationId: OPERATION_ID, phase: "claimed", resumed: false };
    }),
    dispatchPrepare: jest.fn().mockResolvedValue(true),
    cancelPrepare: jest.fn().mockResolvedValue(true),
    completePrepare: jest.fn(async () => { current = agent(); return true; }),
    retainPrepare: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("remote desktop guest installation", () => {
  it("builds a fixed selected-VM installer with cleanup and no browser-selected command", () => {
    const script = buildRemoteDesktopGuestInstallScript({ vmid: 1112, guestIp: "10.250.20.62", operationId: OPERATION_ID,
      provisionerDirectory: "/root/hivra-provisioner",
      infrastructureBindingTag: "hivra-bind-exact", computerId: AGENT_ID,
      controlOrigin: "https://canary.hermesos.cloud", publicOrigin: "https://agent.example.test",
      controlBypassSecret: CONTROL_BYPASS_SECRET });
    expect(script).toContain("qm status \"$VMID\"");
    expect(script).toContain("grep -Fxq \"$EXPECTED_BINDING_TAG\"");
    expect(script).toContain('grep -Fxq "ip=$GUEST_IP/24"');
    expect(script).toContain("PROVISIONER_DIR='/root/hivra-provisioner'");
    expect(script).toContain('SOURCE="$PROVISIONER_DIR/remote-desktop"');
    expect(script).not.toContain("/opt/hivra/provisioner/VERSION");
    expect(script).toContain('REMOTE_DIR="/run/hivra-remote-desktop-install.$COMPUTER_ID.$OPERATION_ID"');
    expect(script.indexOf("flock -w 60 8")).toBeLessThan(script.indexOf('qm status "$VMID"'));
    expect(script).toContain("/run/lock/hivra-allocation.lock");
    expect(script).toContain('run_vmid_bound_guest_exec /usr/bin/install -d -o 0 -g 0 -m 0700 -- "$REMOTE_DIR"');
    expect(script).toContain('qm guest exec "$VMID" --timeout 0 -- "$@"');
    expect(script).toContain('/usr/bin/base64 --decode > "$2"');
    expect(script).toContain('run_vmid_bound_guest_exec /bin/bash -c');
    expect(script).toContain('source_sha="$(/usr/bin/sha256sum "$SOURCE/$candidate"');
    expect(script).toContain('/usr/bin/sha256sum --check --status');
    expect(script).not.toContain("/usr/bin/awk '\\''{print $1}'");
    expect(script).toContain('run_vmid_bound_guest_exec /bin/bash -c');
    expect(script).not.toContain('guest_sha="$(run_vmid_bound_guest_exec');
    expect(script).toContain('transfer_guest_source broker.cjs guest_source_transfer_broker');
    expect(script).toContain('transfer_guest_source install-guest.py guest_source_transfer_installer');
    expect(script).toContain('transfer_guest_source server.cjs guest_source_transfer_server');
    expect(script).not.toContain("/usr/bin/tar -C");
    expect(script.slice(script.indexOf("trap cleanup EXIT"))).toContain("run_vmid_bound_guest_exec_stdin");
    expect(script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
    expect(script).toContain('CONTROL_BYPASS_FILE="$REMOTE_DIR/control-bypass-secret"');
    expect(script).toContain('CONTROL_BYPASS_ARGS=(--control-bypass-file "$CONTROL_BYPASS_FILE")');
    expect(script).toContain('/usr/bin/chown 0:0 "$1"');
    expect(script).toContain('/usr/bin/chmod 0600 "$1"');
    expect(script).not.toContain(CONTROL_BYPASS_SECRET);
    const encodedBypass = script.match(/CONTROL_BYPASS_SECRET_B64='([A-Za-z0-9+/=]+)'/)?.[1];
    expect(Buffer.from(encodedBypass!, "base64").toString("utf8")).toBe(CONTROL_BYPASS_SECRET);
    expect(script).not.toContain("GUEST_SSH");
    expect(script).toContain("^/run/hivra-remote-desktop-install\\.[0-9a-f-]{36}\\.[0-9a-f-]{36}$");
    expect(script).not.toContain("mktemp -d /opt/hivra/");
    expect(script).toContain("trap cleanup EXIT HUP INT TERM");
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("set_install_phase target_vmid");
    expect(script).toContain("set_install_phase target_running");
    expect(script).toContain("TARGET_RUNNING=0");
    expect(script).toContain("awk '/^status:/{print $2; exit}'");
    expect(script).toContain("set_install_phase target_binding_tag");
    expect(script).toContain("set_install_phase target_guest_ip");
    expect(script).toContain("set_install_phase target_guest_identity");
    expect(script).toContain("set_install_phase target_guest_exec_ready");
    expect(script).toContain('qm guest cmd "$VMID" ping');
    expect(script).toContain("run_vmid_bound_guest_exec /usr/bin/true");
    expect(script).toContain("for _ in $(seq 1 30)");
    expect(script).toContain('qm guest exec "$VMID" --timeout 0 -- "$@"');
    expect(script).toContain("HIVRA_QGA_FAILURE result_invalid");
    expect(script).not.toContain("StrictHostKeyChecking");
    expect(script).toContain("set_install_phase target_bundle_version");
    expect(script).toContain("set_install_phase target_source_closure");
    expect(script).toContain("set_install_phase guest_temp_directory_path");
    expect(script).toContain("set_install_phase guest_temp_directory_reset");
    expect(script).toContain("set_install_phase guest_temp_directory_create");
    expect(script).toContain("guest_source_transfer_broker");
    expect(script).toContain("guest_source_transfer_installer");
    expect(script).toContain("guest_source_transfer_server");
    expect(script).toContain("set_install_phase guest_installer");
    expect(script).toContain("set_install_phase guest_capability_evidence");
    expect(script).toContain("set_install_phase guest_isolation_evidence");
    expect(script).toContain("/opt/hivra/remote-desktop/capability.json");
    expect(script).toContain("/opt/hivra/remote-desktop/input-isolation");
    expect(script).toContain("set_install_phase guest_cleanup");
    expect(script).toContain("trap - EXIT HUP INT TERM ERR");
    expect(script).toContain("HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s");
    expect(script).toContain("--computer-kind hivra-agent");
    expect(script).toContain('--source-dir "$REMOTE_DIR"');
    expect(script).toContain("fcntl.LOCK_EX|fcntl.LOCK_NB");
    expect(script).toContain("pass_fds=(lock_fd,)");
    expect(script).not.toContain("HIVRA_REMOTE_DESKTOP_INSTALLED");
    expect(script).not.toContain("$COMMAND");
    const syntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: script });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("uses the resolved self-managed provisioner directory without accepting traversal", () => {
    const base = { vmid: 1112, guestIp: "10.250.20.62", operationId: OPERATION_ID,
      infrastructureBindingTag: "hivra-bind-exact", computerId: AGENT_ID,
      controlOrigin: "https://canary.hermesos.cloud", publicOrigin: "https://agent.example.test" };
    expect(buildRemoteDesktopGuestInstallScript({
      ...base,
      provisionerDirectory: "/opt/hivra/provisioner",
    })).toContain("PROVISIONER_DIR='/opt/hivra/provisioner'");
    expect(() => buildRemoteDesktopGuestInstallScript({
      ...base,
      provisionerDirectory: "/root/../tenant",
    })).toThrow("target is invalid");
    expect(() => buildRemoteDesktopGuestInstallScript({
      ...base,
      provisionerDirectory: "/opt/hivra/provisioner",
      controlBypassSecret: "bad secret",
    })).toThrow("control bypass secret is invalid");
  });

  it("syncs only the selected managed host, installs the bound guest, then records real capability proof", async () => {
    const deps = dependencies();
    await expect(installRemoteDesktopOnHivraAgent(
      AGENT_ID,
      "https://canary.hermesos.cloud",
      deps as never,
      { controlBypassSecret: CONTROL_BYPASS_SECRET, controlBypassRequired: true },
    )).resolves.toMatchObject({
      ok: true, agentId: AGENT_ID, targetId: "fixturenode11", vmid: 1112, changed: true,
    });
    expect(deps.syncManagedBundle).toHaveBeenCalledWith("canary", "fixturenode11");
    expect(deps.runHostScript).toHaveBeenCalledWith(
      expect.not.stringContaining(CONTROL_BYPASS_SECRET),
      expect.objectContaining({ PROXMOX_SSH_HOST: "192.0.2.11" }),
      { timeoutMs: 900_000, maxOutputBytes: 32 * 1024 },
    );
    expect(deps.runHostScript.mock.calls[0][0]).toContain("VMID=1112");
    expect(deps.inspectCapability).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({
      loadAgent: expect.any(Function),
      resolveContext: expect.any(Function),
      runHostScript: deps.runHostScript,
    }), { preparationOperationId: OPERATION_ID });
    const inspectionDeps = deps.inspectCapability.mock.calls[0][1];
    const capturedAgent = await inspectionDeps.loadAgent(AGENT_ID);
    expect(capturedAgent).toMatchObject({ id: AGENT_ID, proxmox_host: "fixturenode11", vmid: 1112 });
    await expect(inspectionDeps.loadAgent("00000000-0000-4000-8000-000000000001")).resolves.toBeNull();
    await expect(inspectionDeps.resolveContext("user_123", capturedAgent)).resolves.toMatchObject({
      kind: "managed", host: "fixturenode11", infrastructureBindingTag: "hivra-bind-exact",
    });
    await expect(inspectionDeps.resolveContext("another_user", capturedAgent)).rejects.toThrow(
      "Remote desktop inspection binding changed.",
    );
  });

  it("does not touch infrastructure for an unstable or unbound agent", async () => {
    for (const changed of [{ status: "provisioning" }, { operation_kind: "restart" }, { infrastructure_binding_token_enforced: false }, { ip: "invalid" }]) {
      const deps = dependencies({ loadAgent: jest.fn().mockResolvedValue(agent(changed)) });
      expect((await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://canary.hermesos.cloud", deps as never)).ok).toBe(false);
      expect(deps.resolveContext).not.toHaveBeenCalled();
      expect(deps.syncManagedBundle).not.toHaveBeenCalled();
      expect(deps.runHostScript).not.toHaveBeenCalled();
    }
  });

  it("refuses protected Canary legacy/default delivery before claiming or syncing", async () => {
    const deps = dependencies();
    deps.resolveContext.mockResolvedValue({ ...(await deps.resolveContext()), provisionerChannel: "default" });
    const result = await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://canary.hermesos.cloud", deps as never,
      { controlBypassSecret: CONTROL_BYPASS_SECRET, controlBypassRequired: true });
    expect(result).toMatchObject({ ok: false, code: "computer_not_ready", error: expect.stringContaining("isolated Canary") });
    expect(deps.beginPrepare).not.toHaveBeenCalled();
    expect(deps.syncManagedBundle).not.toHaveBeenCalled();
    expect(deps.runHostScript).not.toHaveBeenCalled();
  });

  it("never synchronizes the shared default bundle during normal preparation", async () => {
    const deps = dependencies();
    deps.resolveContext.mockResolvedValue({ ...(await deps.resolveContext()), provisionerChannel: "default" });
    await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never);
    expect(deps.syncManagedBundle).not.toHaveBeenCalled();
    expect(deps.runHostScript).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when fresh authority claim or dispatch CAS loses", async () => {
    const stale = dependencies({ beginPrepare: jest.fn().mockResolvedValue(null) });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", stale as never))
      .toMatchObject({ ok: false, code: "computer_not_ready" });
    expect(stale.syncManagedBundle).not.toHaveBeenCalled();
    expect(stale.runHostScript).not.toHaveBeenCalled();
    const cancelled = dependencies({ dispatchPrepare: jest.fn().mockResolvedValue(false) });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", cancelled as never))
      .toMatchObject({ ok: false, code: "computer_not_ready" });
    expect(cancelled.cancelPrepare).toHaveBeenCalledWith("user_123", OPERATION_ID);
    expect(cancelled.runHostScript).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, stdout: "", stderr: "host_timeout" },
    { ok: true, stdout: "", stderr: "" },
    { ok: true, stdout: resultReceipt().stdout.replace('"exitCode":0', '"exitCode":-15'), stderr: "" },
  ])("retains a dispatched lease without exact terminal evidence %#", async result => {
    const deps = dependencies({ runHostScript: jest.fn().mockResolvedValue(result) });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: false, code: "desktop_prepare_pending" });
    expect(deps.retainPrepare).toHaveBeenCalledWith(expect.objectContaining({ operationId: OPERATION_ID }));
    expect(deps.completePrepare).not.toHaveBeenCalled();
    expect(deps.cancelPrepare).not.toHaveBeenCalled();
    expect(deps.inspectCapability).not.toHaveBeenCalled();
  });

  it("releases a known stopped failure without claiming readiness", async () => {
    const deps = dependencies({ runHostScript: jest.fn().mockResolvedValue(resultReceipt(7)) });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: false, code: "desktop_prepare_failed" });
    expect(deps.completePrepare).toHaveBeenCalledWith("user_123", receipt(7));
    expect(deps.inspectCapability).not.toHaveBeenCalled();
  });

  it.each([{ user_id: "another_owner" }, { vmid: 1124 }, { managed_provisioner_channel: "default" }])(
    "retains the lease if fresh completion identity drifts: %j", async change => {
      const deps = dependencies();
      deps.loadAgent.mockResolvedValueOnce(agent()).mockResolvedValue(agent({ ...change, operation_id: OPERATION_ID, operation_kind: "desktop_prepare" }));
      expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
        .toMatchObject({ ok: false, code: "desktop_prepare_pending" });
      expect(deps.completePrepare).not.toHaveBeenCalled();
      expect(deps.inspectCapability).not.toHaveBeenCalled();
    });

  it("retains a fresh host_target_running miss without a second apply", async () => {
    const deps = dependencies({
      runHostScript: jest.fn().mockResolvedValue({
        ok: false, stdout: "",
        stderr: "HIVRA_REMOTE_DESKTOP_HOST_FAILURE target_running\n",
        error: "Remote bash exited with code 1",
      }),
    });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: false, code: "desktop_prepare_pending", error: expect.stringContaining("host_target_running") });
    expect(deps.runHostScript).toHaveBeenCalledTimes(1);
    expect(deps.retainPrepare).toHaveBeenCalled();
    expect(deps.completePrepare).not.toHaveBeenCalled();
  });

  it("applies on a resumed host_target_running miss instead of staying paused", async () => {
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValueOnce(agent({ operation_id: OPERATION_ID, operation_kind: "desktop_prepare" }))
        .mockResolvedValueOnce(agent({ operation_id: OPERATION_ID, operation_kind: "desktop_prepare" })).mockResolvedValue(agent()),
      beginPrepare: jest.fn().mockResolvedValue({ operationId: OPERATION_ID, phase: "dispatched", resumed: true }),
      runHostScript: jest.fn()
        .mockResolvedValueOnce({
          ok: false, stdout: "",
          stderr: "HIVRA_REMOTE_DESKTOP_HOST_FAILURE target_running\n",
          error: "Remote bash exited with code 1",
        })
        .mockResolvedValueOnce(resultReceipt()),
    });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: true, changed: false });
    expect(deps.runHostScript).toHaveBeenCalledTimes(2);
    expect(deps.runHostScript.mock.calls[0][0]).toContain("OBSERVE_ONLY=1");
    expect(deps.runHostScript.mock.calls[1][0]).toContain("OBSERVE_ONLY=0");
    expect(deps.syncManagedBundle).toHaveBeenCalledWith("canary", "fixturenode11");
    expect(deps.completePrepare).toHaveBeenCalledWith("user_123", receipt());
    expect(deps.retainPrepare).not.toHaveBeenCalled();
    expect(deps.dispatchPrepare).not.toHaveBeenCalled();
  });

  it("retains a resumed re-apply when Canary bundle sync fails before the second apply", async () => {
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValueOnce(agent({ operation_id: OPERATION_ID, operation_kind: "desktop_prepare" }))
        .mockResolvedValue(agent({ operation_id: OPERATION_ID, operation_kind: "desktop_prepare" })),
      beginPrepare: jest.fn().mockResolvedValue({ operationId: OPERATION_ID, phase: "dispatched", resumed: true }),
      syncManagedBundle: jest.fn().mockResolvedValue({ ok: false }),
      runHostScript: jest.fn().mockResolvedValue({
        ok: false, stdout: "",
        stderr: "HIVRA_REMOTE_DESKTOP_HOST_FAILURE target_running\n",
        error: "Remote bash exited with code 1",
      }),
    });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: false, code: "desktop_prepare_pending", error: expect.stringContaining("managed_bundle_sync") });
    expect(deps.runHostScript).toHaveBeenCalledTimes(1);
    expect(deps.syncManagedBundle).toHaveBeenCalledWith("canary", "fixturenode11");
    expect(deps.retainPrepare).toHaveBeenCalled();
    expect(deps.completePrepare).not.toHaveBeenCalled();
  });

  it("observes a dispatched retry without syncing, transferring sources or redispatching", async () => {
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValueOnce(agent({ operation_id: OPERATION_ID, operation_kind: "desktop_prepare" }))
        .mockResolvedValueOnce(agent({ operation_id: OPERATION_ID, operation_kind: "desktop_prepare" })).mockResolvedValue(agent()),
      beginPrepare: jest.fn().mockResolvedValue({ operationId: OPERATION_ID, phase: "dispatched", resumed: true }),
    });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: true, changed: false });
    expect(deps.syncManagedBundle).not.toHaveBeenCalled();
    expect(deps.dispatchPrepare).not.toHaveBeenCalled();
    expect(deps.resolveObservationContext).toHaveBeenCalledTimes(1);
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.runHostScript.mock.calls[0][0]).toContain("OBSERVE_ONLY=1");
    const script = deps.runHostScript.mock.calls[0][0] as string;
    expect(script.indexOf('if [ "$OBSERVE_ONLY"')).toBeLessThan(script.indexOf("set_install_phase target_bundle_version"));
    expect(deps.completePrepare).toHaveBeenCalledWith("user_123", receipt());
  });

  it("cancels only an undispatched resumed attempt and never touches the guest", async () => {
    const deps = dependencies({ beginPrepare: jest.fn().mockResolvedValue({ operationId: OPERATION_ID, phase: "claimed", resumed: true }) });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: false, code: "computer_not_ready" });
    expect(deps.cancelPrepare).toHaveBeenCalledWith("user_123", OPERATION_ID);
    expect(deps.syncManagedBundle).not.toHaveBeenCalled();
    expect(deps.runHostScript).not.toHaveBeenCalled();
  });

  it("does not report readiness if Delete arrives during capability inspection", async () => {
    const deps = dependencies();
    deps.inspectCapability.mockImplementation(async () => {
      deps.loadAgent.mockResolvedValue(agent({ desired_state: "deleted" }));
      return { ok: true };
    });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: false, code: "computer_not_ready" });
    expect(deps.completePrepare).toHaveBeenCalledWith("user_123", receipt());
    expect(deps.retainPrepare).not.toHaveBeenCalled();
  });

  it("does not report readiness when a new Restart is claimed immediately after completion", async () => {
    const deps = dependencies();
    deps.completePrepare.mockImplementation(async () => {
      deps.loadAgent.mockResolvedValue(agent({ operation_id: BOOT_ID, operation_kind: "restart" }));
      return true;
    });
    expect(await installRemoteDesktopOnHivraAgent(AGENT_ID, "https://control.example.test", deps as never))
      .toMatchObject({ ok: false, code: "computer_not_ready" });
    expect(deps.retainPrepare).not.toHaveBeenCalled();
  });

  it("fails closed before host mutation for invalid or self-managed bypass configuration", async () => {
    const invalid = dependencies();
    await expect(installRemoteDesktopOnHivraAgent(
      AGENT_ID,
      "https://canary.hermesos.cloud",
      invalid as never,
      { controlBypassSecret: "invalid secret" },
    )).resolves.toMatchObject({ ok: false, error: "Remote desktop install configuration is invalid." });
    expect(invalid.loadAgent).not.toHaveBeenCalled();
    expect(invalid.syncManagedBundle).not.toHaveBeenCalled();
    expect(invalid.runHostScript).not.toHaveBeenCalled();

    const missing = dependencies();
    await expect(installRemoteDesktopOnHivraAgent(
      AGENT_ID,
      "https://canary.hermesos.cloud",
      missing as never,
      { controlBypassRequired: true },
    )).resolves.toMatchObject({ ok: false, error: "Remote desktop install configuration is invalid." });
    expect(missing.loadAgent).not.toHaveBeenCalled();
    expect(missing.syncManagedBundle).not.toHaveBeenCalled();
    expect(missing.runHostScript).not.toHaveBeenCalled();

    const selfManaged = dependencies({
      resolveContext: jest.fn().mockResolvedValue({
        kind: "self-managed", host: "connection:target", env: {},
        paths: { provisionerDirectory: "/opt/hivra/provisioner", vmSshKeyPath: "/root/key" },
        infrastructureBindingTag: "hivra-bind-exact", infrastructureBindingTagEnforced: true,
      }),
    });
    await expect(installRemoteDesktopOnHivraAgent(
      AGENT_ID,
      "https://canary.hermesos.cloud",
      selfManaged as never,
      { controlBypassSecret: CONTROL_BYPASS_SECRET },
    )).resolves.toMatchObject({ ok: false, error: "Remote desktop install configuration is invalid." });
    expect(selfManaged.syncManagedBundle).not.toHaveBeenCalled();
    expect(selfManaged.runHostScript).not.toHaveBeenCalled();
  });

  it("restarts only the identity-bound guest and proves persistent workspace plus capability", async () => {
    const deps = dependencies({
      runHostScript: jest.fn().mockImplementation((script: string) => {
        const encoded = script.match(/RESTART_PROGRAM_BASE64='([A-Za-z0-9+/=]+)'/)?.[1] ?? "";
        const marker = Buffer.from(encoded, "base64").toString("utf8").match(/WORKSPACE_MARKER_SHA256='([a-f0-9]{64})'/)?.[1];
        return Promise.resolve({ ok: true, stdout: `HIVRA_REMOTE_DESKTOP_RESTARTED ${JSON.stringify({ protocol: "hivra-remote-desktop-restarted-v1", workspaceMarkerSha256: marker })}\n`, stderr: "" });
      }),
    });
    const result = await verifyRemoteDesktopRestartOnHivraAgent(AGENT_ID, deps as never);
    expect(result).toMatchObject({ ok: true, targetId: "fixturenode11", vmid: 1112 });
    expect(result.workspaceMarkerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(deps.runHostScript).toHaveBeenCalledWith(
      expect.stringContaining("run_vmid_bound_guest_exec /bin/bash -c"),
      expect.objectContaining({ PROXMOX_SSH_HOST: "192.0.2.11" }),
      { timeoutMs: 180_000, maxOutputBytes: 16 * 1024 },
    );
    expect(deps.inspectCapability).toHaveBeenCalledWith(AGENT_ID);
  });

  it("builds a restart probe without exposing broad host authority", () => {
    const script = buildRemoteDesktopGuestRestartScript({
      vmid: 1112,
      guestIp: "10.250.20.62",
      infrastructureBindingTag: "hivra-bind-exact",
      publicOrigin: "https://agent.example.test",
      workspaceMarkerSha256: "b".repeat(64),
    });
    expect(script).toContain("qm status \"$VMID\"");
    expect(script).toContain("grep -Fxq \"$EXPECTED_BINDING_TAG\"");
    expect(script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
    expect(script).not.toContain("StrictHostKeyChecking");
    const encoded = script.match(/RESTART_PROGRAM_BASE64='([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encoded).toBeTruthy();
    const guestProgram = Buffer.from(encoded!, "base64").toString("utf8");
    expect(guestProgram).toContain(".hivra-restart-proof");
    expect(guestProgram).toContain("WORKSPACE=/home/bux/Hivra");
    expect(guestProgram).toContain('BUX_UID="$(/usr/bin/id -u bux)"');
    expect(guestProgram).toContain('BUX_GID="$(/usr/bin/id -g bux)"');
    expect(guestProgram).not.toContain("/var/lib/hivra/remote-desktop/workspace");
    expect(guestProgram).not.toContain("-o 1000 -g 1000");
    expect(guestProgram).toContain("bux-hivra-chat.service");
    expect(script).not.toContain("qm destroy");
    const syntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: script });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("accepts a clean install exit only after independent exact capability proof", async () => {
    const proved = dependencies();
    await expect(installRemoteDesktopOnHivraAgent(
      AGENT_ID,
      "https://canary.hermesos.cloud",
      proved as never,
    )).resolves.toMatchObject({ ok: true });
    expect(proved.inspectCapability).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({
      loadAgent: expect.any(Function),
      resolveContext: expect.any(Function),
      runHostScript: proved.runHostScript,
    }), { preparationOperationId: OPERATION_ID });

    const unproved = dependencies({
      runHostScript: jest.fn().mockResolvedValue(resultReceipt()),
      inspectCapability: jest.fn().mockResolvedValue({ ok: false, error: "exact proof failed" }),
    });
    await expect(installRemoteDesktopOnHivraAgent(
      AGENT_ID,
      "https://canary.hermesos.cloud",
      unproved as never,
    )).resolves.toMatchObject({
      ok: false,
      error: "exact proof failed",
    });
  });

  it("returns only bounded failure codes from host and guest installer failures", async () => {
    for (const [hostResult, expected] of [
      [{ ok: false, stdout: "", stderr: "", error: "Proxmox host script output exceeded 32768 bytes" }, "host_output_limit"],
      [{ ok: false, stdout: "", stderr: "remote desktop install failed: docker_pull_failed\n", error: "Remote bash exited with code 1" }, "guest_docker_pull_failed"],
      [{ ok: false, stdout: "", stderr: "remote desktop install failed: Selkies input isolation could not be verified\n", error: "Remote bash exited with code 1" }, "guest_input_isolation_failed"],
      [{ ok: false, stdout: "", stderr: "remote desktop install failed: Selkies loopback authentication is not enforced\n", error: "Remote bash exited with code 1" }, "guest_loopback_auth_failed"],
      [{ ok: false, stdout: "", stderr: "remote desktop install failed: Selkies loopback surface is not ready\n", error: "Remote bash exited with code 1" }, "guest_loopback_surface_failed"],
      [{ ok: false, stdout: "", stderr: "HIVRA_REMOTE_DESKTOP_HOST_FAILURE guest_source_transfer\n", error: "Remote bash exited with code 1" }, "host_guest_source_transfer"],
      [{ ok: false, stdout: "", stderr: "HIVRA_QGA_FAILURE guest_exit_2\nHIVRA_REMOTE_DESKTOP_HOST_FAILURE guest_source_transfer\n", error: "Remote bash exited with code 1" }, "host_guest_source_transfer_qga_guest_exit_2"],
      [{ ok: false, stdout: "", stderr: "HIVRA_REMOTE_DESKTOP_PHASE target_running\nHIVRA_REMOTE_DESKTOP_PHASE guest_installer\n", error: "Remote bash exited with code 137" }, "host_guest_installer_remote_exit"],
    ] as const) {
      const deps = dependencies({ runHostScript: jest.fn().mockResolvedValue(hostResult) });
      await expect(installRemoteDesktopOnHivraAgent(AGENT_ID, "https://canary.hermesos.cloud", deps as never)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(expected),
      });
    }
  });

  it("does not surface unrecognized guest stderr", async () => {
    const deps = dependencies({
      runHostScript: jest.fn().mockResolvedValue({
        ok: false,
        stdout: "",
        stderr: "remote desktop install failed: credential=private\n",
        error: "Remote bash exited with code 1",
      }),
    });
    await expect(installRemoteDesktopOnHivraAgent(
      AGENT_ID,
      "https://canary.hermesos.cloud",
      deps as never,
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("guest_remote_exit"),
    });
  });

  it("runs only fixed VMID-bound transport probes and parses their bounded receipt", async () => {
    const script = buildRemoteDesktopGuestTransportDiagnosticScript({
      vmid: 1112,
      guestIp: "10.250.20.62",
      infrastructureBindingTag: "hivra-bind-exact",
    });
    expect(script).toContain('grep -Fxq "$EXPECTED_BINDING_TAG"');
    expect(script).toContain('grep -Fxq "ip=$GUEST_IP/24"');
    expect(script).toContain("run_diagnostic_probe true /usr/bin/true");
    expect(script).toContain("run_diagnostic_probe rm /usr/bin/rm -rf");
    expect(script).toContain("DIAGNOSTIC_PHASE=shared_decoder_true");
    expect(script).toContain("DIAGNOSTIC_PHASE=shared_decoder_rm");
    expect(script).toContain("DIAGNOSTIC_PHASE=desktop_runtime");
    expect(script).toContain("run_vmid_bound_guest_exec /usr/bin/rm -rf");
    expect(script).toContain("HIVRA_QGA_DIAGNOSTIC_HOST_FAILURE %s");
    expect(script).toContain("/usr/bin/perl -MJSON::PP");
    expect(script).toContain('"exited"\\s*:\\s*(?:1|true)');
    expect(script).toContain('"exitcode"\\s*:\\s*(\\d+)');
    expect(script).not.toContain("/usr/bin/python3");
    expect(script).not.toContain("qm destroy");
    const encodedDesktopProgram = script.match(/DESKTOP_DIAGNOSTIC_PROGRAM_BASE64='([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encodedDesktopProgram).toBeTruthy();
    const desktopProgram = Buffer.from(encodedDesktopProgram!, "base64").toString("utf8");
    expect(desktopProgram).toContain("docker inspect --format");
    expect(desktopProgram).toContain("docker logs --tail 160");
    expect(desktopProgram).toContain("/usr/bin/timeout 8 /usr/bin/docker");
    expect(desktopProgram).toContain("HIVRA_SELKIES_RUNTIME_DIAGNOSTIC_V1");
    expect(desktopProgram).toContain("/usr/bin/curl --config -");
    expect(desktopProgram).not.toContain('-H "Authorization: Basic $BASIC_PAIR"');
    expect(desktopProgram).not.toContain('echo "$LOGS"');
    const desktopSyntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: desktopProgram });
    expect({ status: desktopSyntax.status, stderr: desktopSyntax.stderr }).toEqual({ status: 0, stderr: "" });
    const syntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: script });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });

    const probes = ["true", "rm", "printf", "shell"].map((label, index) => ({
      label,
      dispatchExit: 0,
      exited: true,
      exitcode: 0,
      exitedTokenClass: "boolean-true",
      exitcodeTokenClass: "integer",
      strictDecodeValid: true,
      resultKeys: ["exitcode", "exited"],
      stdoutClass: index === 2 ? "diagnostic-marker" : "empty",
      stdoutLength: index === 2 ? 11 : 0,
      stderrClass: "empty",
      stderrLength: 0,
    }));
    const desktop = {
      selkiesUnit: "active", brokerUnit: "active", containerState: "running",
      containerOomKilled: false, containerExitCode: 0, containerRestartCount: 0,
      basicAuthFile: true, unauthenticatedHttpStatus: 401, authenticatedHttpStatus: 200,
      logClass: "other",
    };
    const deps = dependencies({
      runHostScript: jest.fn().mockResolvedValue({
        ok: true,
        stdout: probes.map(value => `HIVRA_QGA_TRANSPORT_DIAGNOSTIC_V1 ${JSON.stringify(value)}`).join("\n")
          + `\nHIVRA_SELKIES_RUNTIME_DIAGNOSTIC_V1 ${JSON.stringify(desktop)}\n`,
        stderr: "",
      }),
    });
    await expect(diagnoseRemoteDesktopGuestTransport(AGENT_ID, deps as never)).resolves.toMatchObject({
      ok: true,
      agentId: AGENT_ID,
      targetId: "fixturenode11",
      vmid: 1112,
      probes,
      desktop,
    });

    const failed = dependencies({
      runHostScript: jest.fn().mockResolvedValue({
        ok: false,
        stdout: "",
        stderr: "HIVRA_QGA_FAILURE result_invalid\nHIVRA_QGA_DIAGNOSTIC_HOST_FAILURE probe_rm_dispatch\n",
        error: "Remote bash exited with code 1",
      }),
    });
    await expect(diagnoseRemoteDesktopGuestTransport(AGENT_ID, failed as never)).resolves.toMatchObject({
      ok: false,
      error: "Remote desktop guest transport diagnostic failed (host_probe_rm_dispatch_qga_result_invalid).",
    });

    const missingDesktopReceipt = dependencies({
      runHostScript: jest.fn().mockResolvedValue({
        ok: true,
        stdout: probes.map(value => `HIVRA_QGA_TRANSPORT_DIAGNOSTIC_V1 ${JSON.stringify(value)}`).join("\n") + "\n",
        stderr: "",
      }),
    });
    await expect(diagnoseRemoteDesktopGuestTransport(AGENT_ID, missingDesktopReceipt as never)).resolves.toMatchObject({
      ok: false,
      error: "Remote desktop guest transport diagnostic receipt is invalid.",
    });
  });

  it("keeps package, Docker progress, and curl credential input inside the guest", () => {
    const installer = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py"), "utf8");
    expect(installer).toContain("stderr=subprocess.PIPE");
    expect(installer).toContain("check=False");
    expect(installer).toContain('raise RuntimeError(f"{safe_stage}_failed")');
    expect(installer).not.toContain("stderr=subprocess.PIPE if capture else None");
  });

  it("locks one-to-one desktop density and aligned geometry in the actual container environment", () => {
    const installer = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py"), "utf8");
    const environment = installer.slice(installer.indexOf('write_private(docker_env_path, "\\n".join(['),
      installer.indexOf("    broker_environment = ["));
    expect(environment).toContain('"SELKIES_FORCE_ALIGNED_RESOLUTION=true|locked"');
    expect(environment.match(/SELKIES_FORCE_ALIGNED_RESOLUTION=/g)).toHaveLength(1);
    // DPI is an enum: an explicit 96 override is automatically locked.
    // The bool-only |locked suffix would discard that override upstream.
    expect(environment).toContain('"SELKIES_SCALING_DPI=96"');
    expect(environment).not.toContain('SELKIES_SCALING_DPI=96|locked');
    expect(environment.match(/SELKIES_SCALING_DPI=/g)).toHaveLength(1);
    expect(environment).toContain('"SELKIES_USE_CSS_SCALING=true|locked"');
    expect(environment.match(/SELKIES_USE_CSS_SCALING=/g)).toHaveLength(1);
    expect(environment).toContain('"SELKIES_MODE=websockets"');
    expect(environment).toContain('"SELKIES_WAYLAND=false"');
    expect(environment).toContain('"SELKIES_FRAMERATE=60"');
    expect(environment).toContain('"SELKIES_VIDEO_BITRATE=25000"');
  });

  it("keeps the optional control bypass in protected files and out of argv, receipts, and errors", () => {
    const installer = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py"), "utf8");
    const server = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/server.cjs"), "utf8");
    expect(installer).toContain('parser.add_argument("--control-bypass-file")');
    expect(installer).toContain("os.O_NOFOLLOW");
    expect(installer).toContain("stat.S_IMODE(info.st_mode) != 0o600");
    expect(installer).toContain('CONTROL_BYPASS_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{16,256}$")');
    expect(installer).toContain('CONTROL_BYPASS_PATH = ROOT / "control-protection-bypass"');
    expect(installer).toContain("write_private(CONTROL_BYPASS_PATH, control_bypass_secret, uid=0, gid=broker_gid, mode=0o640)");
    expect(installer).toContain("CONTROL_BYPASS_PATH.unlink()");
    expect(installer.indexOf("path.unlink()")).toBeLessThan(installer.indexOf('payload.decode("ascii")'));
    expect(installer).toContain('raise RuntimeError("control_bypass_file_cleanup_failed") from None');
    expect(installer).toContain('f"HIVRA_REMOTE_DESKTOP_CONTROL_BYPASS_FILE={CONTROL_BYPASS_PATH}"');
    expect(installer).not.toContain("HIVRA_REMOTE_DESKTOP_CONTROL_BYPASS_SECRET=");
    expect(installer).toContain('input_text=f\'header = "x-vercel-protection-bypass: {secret}"\\n\'');
    expect(installer).toContain('result.stdout.strip() != "405"');
    const capability = installer.slice(installer.indexOf("    capability = {"), installer.indexOf("    return capability"));
    expect(capability).not.toContain("control_bypass");
    expect(server).toContain("controlBypassSecret: optionalControlBypassSecret()");
    expect(server).toContain("info.uid !== 0 || info.gid !== process.getgid()");
    expect(server).toContain("(info.mode & 0o777) !== 0o640");
    expect(server).not.toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
  });

  it("reads the bounded root-only transfer once, removes it, and probes without secret argv", () => {
    const installerPath = path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py");
    const program = String.raw`
import importlib.util
import pathlib
import stat
import sys
import tempfile
import types
from unittest import mock

spec = importlib.util.spec_from_file_location("remote_desktop_guest_installer", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
secret = "canary_control_bypass_1234567890"
with tempfile.TemporaryDirectory() as directory:
    source = pathlib.Path(directory).resolve()
    transfer = source / "control-bypass-secret"
    root_file = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0)
    transfer.write_text(secret, encoding="ascii")
    transfer.chmod(0o600)
    with mock.patch.object(module.os, "fstat", return_value=root_file):
        assert module.read_control_bypass_secret(str(transfer), source) == secret
    assert not transfer.exists()

    transfer.write_text("a" * 257, encoding="ascii")
    transfer.chmod(0o600)
    with mock.patch.object(module.os, "fstat", return_value=root_file):
        try:
            module.read_control_bypass_secret(str(transfer), source)
            raise AssertionError("oversized secret accepted")
        except ValueError as error:
            assert str(error) == "control_bypass_secret_invalid"
    assert not transfer.exists()

    transfer.write_text(secret, encoding="ascii")
    transfer.chmod(0o600)
    with mock.patch.object(module.os, "fstat", return_value=root_file):
        with mock.patch.object(pathlib.Path, "unlink", side_effect=OSError):
            try:
                module.read_control_bypass_secret(str(transfer), source)
                raise AssertionError("cleanup failure accepted")
            except RuntimeError as error:
                assert str(error) == "control_bypass_file_cleanup_failed"
    transfer.unlink()

calls = []
def fake_run(command, **kwargs):
    calls.append((command, kwargs))
    return types.SimpleNamespace(returncode=0, stdout="405")
module.run = fake_run
module.verify_control_origin_access("https://canary.example.test", secret)
command, kwargs = calls.pop()
assert all(secret not in argument for argument in command)
assert kwargs["input_text"] == f'header = "x-vercel-protection-bypass: {secret}"\n'
module.run = lambda command, **kwargs: types.SimpleNamespace(returncode=0, stdout="401")
try:
    module.verify_control_origin_access("https://canary.example.test", secret)
    raise AssertionError("protection response accepted")
except RuntimeError as error:
    assert str(error) == "control_origin_bypass_probe_failed"
`;
    const result = spawnSync("python3", ["-I", "-B", "-c", program, installerPath], { encoding: "utf8" });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("waits for the protected Selkies HTTP contract instead of trusting process state", () => {
    const installer = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py"), "utf8");
    expect(installer).toContain('"SELKIES_ENABLE_BASIC_AUTH=true"');
    expect(installer).toContain("container_deadline = time.monotonic() + 120");
    expect(installer).toContain('candidate.get("State", {}).get("Running") is True');
    expect(installer).toContain('raise RuntimeError("selkies_container_readiness_timeout")');
    expect(installer).toContain("deadline = time.monotonic() + 120");
    expect(installer).toContain('unauthorized.returncode == 0 and unauthorized.stdout.strip() == "401"');
    expect(installer).toContain('authenticated.returncode == 0 and authenticated.stdout.strip() == "200"');
    expect(installer).toContain('raise RuntimeError("selkies_readiness_timeout")');
    expect(installer).toContain("time.sleep(2)");
    expect(installer).toContain('["/usr/bin/systemctl", "enable", "hivra-selkies-desktop.service"]');
    expect(installer).toContain('["/usr/bin/systemctl", "restart", "hivra-selkies-desktop.service"]');
    expect(installer).toContain('["/usr/bin/systemctl", "restart", "hivra-remote-desktop-broker.service"]');
    expect(installer).not.toContain('["/usr/bin/systemctl", "enable", "--now", "hivra-selkies-desktop.service"]');
    const rotatedCredential = installer.indexOf("write_private(basic_path");
    const selkiesRestart = installer.indexOf('["/usr/bin/systemctl", "restart", "hivra-selkies-desktop.service"]');
    const brokerRestart = installer.indexOf('["/usr/bin/systemctl", "restart", "hivra-remote-desktop-broker.service"]');
    expect(rotatedCredential).toBeGreaterThanOrEqual(0);
    expect(selkiesRestart).toBeGreaterThan(rotatedCredential);
    expect(brokerRestart).toBeGreaterThan(selkiesRestart);
    expect(installer).toContain('"--config", "-"');
    expect(installer).toContain("input_text=authenticated_curl_config");
    expect(installer).not.toContain('f"Authorization: Basic {basic_pair}"');
  });

  it("keeps immutable capability evidence outside broker-owned runtime state", () => {
    const installer = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py"), "utf8");
    expect(installer).toContain('isolation_path = ROOT / "input-isolation"');
    expect(installer).toContain('write_private(ROOT / "capability.json"');
    expect(installer).toContain('parent_info = os.lstat(parent)');
    expect(installer).toContain('parent_info.st_mode & 0o022');
    expect(installer).toContain('os.chown(ROOT, 0, 0)');
    expect(installer).not.toContain('write_private(STATE / "capability.json"');
    expect(installer).not.toContain('isolation_path = STATE / "input-isolation"');
  });

  it("mounts only the shared bux workspace and resolves its ownership dynamically", () => {
    const installer = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py"), "utf8");
    expect(installer).toContain('WORKSPACE = Path("/home/bux/Hivra")');
    expect(installer).toContain('["/usr/bin/id", "-u", "bux"]');
    expect(installer).toContain('["/usr/bin/id", "-g", "bux"]');
    expect(installer).toContain("--mount type=bind,src={WORKSPACE},dst=/home/ubuntu/Hivra");
    expect(installer).not.toContain('workspace = STATE / "workspace"');
    expect(installer).not.toContain("os.chown(workspace, 1000, 1000)");
  });

  it("derives a no-network image that maps the named desktop user onto the bux identity", () => {
    const installerPath = path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py");
    const program = String.raw`
import hashlib,importlib.util,json,os,pathlib,stat,subprocess,tempfile,time,types,sys
spec=importlib.util.spec_from_file_location('desktop_guest',sys.argv[1])
guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
base_id='sha256:'+'a'*64; runtime_id='sha256:'+'b'*64; calls=[]; derived_labels={}
def document(derived):
 labels={'upstream':'retained'}
 if derived: labels.update(derived_labels)
 return {'Id':runtime_id if derived else base_id,'Os':'linux','Architecture':'amd64',
  'RepoDigests':[] if derived else [guest.IMAGE],
  'RootFS':{'Type':'layers','Layers':['sha256:'+'c'*64]+(['sha256:'+'d'*64] if derived else [])},
  'Config':{'User':'ubuntu' if derived else '1000','Entrypoint':['/etc/container-entrypoint.sh'],
   'Cmd':None,'WorkingDir':'/home/ubuntu','Volumes':None,'Labels':labels}}
def fake_run(command,**options):
 calls.append((command,options))
 if command[:3]==['/usr/bin/docker','image','inspect']:
  return types.SimpleNamespace(stdout=json.dumps([document(command[3]!=guest.IMAGE)]),returncode=0)
 if command[:2]==['/usr/bin/docker','build']:
  labels=[command[index+1] for index,value in enumerate(command) if value=='--label']
  derived_labels.update(entry.split('=',1) for entry in labels)
  return types.SimpleNamespace(stdout='',returncode=0)
 raise AssertionError(command)
guest.run=fake_run
identity=guest.build_identity_image(1001,1001)
assert identity=={'baseImage':guest.IMAGE,'baseImageIndexDigest':guest.IMAGE_INDEX_DIGEST,
 'baseImageId':base_id,'runtimeImageId':runtime_id,
 'identityRecipeSha256':identity['identityRecipeSha256'],'desktopUser':'ubuntu','desktopUid':1001,'desktopGid':1001}
build=[entry for entry in calls if entry[0][:2]==['/usr/bin/docker','build']]
assert len(build)==1
command,options=build[0]; recipe=options['input_text']
assert command[:4]==['/usr/bin/docker','build','--pull=false','--network=none'] and command[-1]=='-'
assert recipe.startswith('FROM '+guest.IMAGE+'\nUSER 0\n') and recipe.endswith('USER ubuntu\n')
dockerfile_lines=recipe.splitlines()
assert all(line.endswith('\\') for line in dockerfile_lines[2:-2])
assert not dockerfile_lines[-2].endswith('\\')
assert all(not line.startswith(('root=os.path.','expected={','def kind','def selected','def inspect','def walk_error','for parent,')) for line in dockerfile_lines)
assert '/usr/sbin/groupmod -g 1001 ubuntu' in recipe and '/usr/sbin/usermod -u 1001 -g 1001 ubuntu' in recipe
assert 'passwd_rows="$(/usr/bin/getent passwd)"' in recipe and 'group_rows="$(/usr/bin/getent group)"' in recipe
assert 'seen==1 && valid==1' in recipe
assert 'target_passwd_status=$?' in recipe and '[ "$target_passwd_status" = "2" ]' in recipe
assert 'target_group_status=$?' in recipe and '[ "$target_group_status" = "2" ]' in recipe
assert 'target_uid_inode="$(/usr/bin/find / -xdev -uid 1001' in recipe and '[ -z "$target_uid_inode" ]' in recipe
assert 'target_gid_inode="$(/usr/bin/find / -xdev -gid 1001' in recipe and '[ -z "$target_gid_inode" ]' in recipe
assert '/usr/bin/find / -xdev -uid 1000 -exec /usr/bin/chown -h 1001 {} +' in recipe
assert '/usr/bin/find / -xdev -gid 1000 -exec /usr/bin/chgrp -h 1001 {} +' in recipe
assert 'HIVRA_DESKTOP_IDENTITY_BUILD_FAILURE %s' in recipe
assert 'special_mode_contract' in recipe and 'symlink_identity_rewrite' in recipe and 'special_mode_restore' in recipe
assert 'os.replace(temporary,path)' in recipe and 'blocked_xattrs' in recipe
assert '/usr/bin/chmod 2775 /usr/local/share/fonts' in recipe
assert '/usr/bin/chmod 4755 /opt/google/chrome/chrome-sandbox' in recipe
assert '2775:1001:1001' in recipe and '4755:1001:1001' in recipe
assert '| /usr/bin/grep' not in recipe
assert 'remaining_uid="$(/usr/bin/find / -xdev -uid 1000' in recipe
assert 'remaining_gid="$(/usr/bin/find / -xdev -gid 1000' in recipe
assert all(token not in recipe for token in ('ADD ','COPY ','apt-get','curl ','wget '))
assert identity['identityRecipeSha256']==hashlib.sha256(recipe.encode()).hexdigest()
noop=guest.identity_image_recipe(1000,1000)
assert '/usr/sbin/usermod' not in noop and '/usr/sbin/groupmod' not in noop and '/usr/bin/find' not in noop
assert noop.endswith('USER ubuntu\n')
uid_only=guest.identity_image_recipe(1001,1000)
assert '/usr/sbin/usermod -u 1001 ubuntu' in uid_only and '/usr/sbin/groupmod' not in uid_only
assert '-uid 1000 -exec /usr/bin/chown' in uid_only and '-gid 1000 -exec /usr/bin/chgrp' not in uid_only
gid_only=guest.identity_image_recipe(1000,1001)
assert '/usr/sbin/groupmod -g 1001 ubuntu' in gid_only and '/usr/sbin/usermod -g 1001 ubuntu' in gid_only
assert '-gid 1000 -exec /usr/bin/chgrp' in gid_only and '-uid 1000 -exec /usr/bin/chown' not in gid_only
for invalid in ((999,1001),(1001,999),(True,1001),(1001,60001)):
 try: guest.identity_image_recipe(*invalid); raise AssertionError('unsafe identity accepted')
 except RuntimeError as error: assert str(error)=='desktop_identity_unsafe'

def special_contract(root):
 return subprocess.run([sys.executable,'-I','-B','-c',guest.SPECIAL_MODE_VALIDATOR,
  str(root),str(os.getuid()),str(os.getgid()),'1','1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary)
 fonts=root/'usr/local/share/fonts'; sandbox=root/'opt/google/chrome/chrome-sandbox'
 fonts.mkdir(parents=True); sandbox.parent.mkdir(parents=True)
 sandbox.write_bytes(b'pinned chrome sandbox fixture')
 os.chmod(fonts,0o2775); os.chmod(sandbox,0o4755)
 assert special_contract(root)==0
 os.chmod(sandbox,0o755)
 assert special_contract(root)!=0
 os.chmod(sandbox,0o4755)
 extra=root/'unexpected-special'; extra.write_bytes(b'unexpected'); os.chmod(extra,0o4755)
 assert special_contract(root)!=0
 extra.unlink(); sandbox.unlink(); sandbox.symlink_to(fonts)
 assert special_contract(root)!=0

def rewrite_symlinks(root,old_uid,old_gid,new_uid,new_gid,remap_uid,remap_gid,initial_attrs,perturb_atime=False):
 root_alias=os.path.abspath(os.fspath(root)); root_real=os.path.realpath(root_alias)
 def key(path):
  value=os.path.abspath(os.fspath(path))
  return root_real+value[len(root_alias):] if value==root_alias or value.startswith(root_alias+os.sep) else value
 store={key(path):dict(attrs) for path,attrs in initial_attrs.items()}
 calls=[]
 real={name:getattr(os,name) for name in ('listxattr','getxattr','setxattr','unlink','symlink','replace','lchown','readlink') if hasattr(os,name)}
 real.update({'unlink':os.unlink,'symlink':os.symlink,'replace':os.replace,'lchown':os.lchown,'readlink':os.readlink})
 def listxattr(path,follow_symlinks=False): return list(store.get(key(path),{}))
 def getxattr(path,name,follow_symlinks=False): return store[key(path)][name]
 def setxattr(path,name,value,follow_symlinks=False): store.setdefault(key(path),{})[name]=bytes(value)
 def unlink(path,*args,**kwargs):
  result=real['unlink'](path,*args,**kwargs); store.pop(key(path),None); return result
 def symlink(target,path,*args,**kwargs):
  result=real['symlink'](target,path,*args,**kwargs); store[key(path)]={}; return result
 def replace(source,destination,*args,**kwargs):
  attrs=store.pop(key(source),{}); result=real['replace'](source,destination,*args,**kwargs); store[key(destination)]=attrs; return result
 def lchown(path,uid,gid): calls.append((key(path),uid,gid)); return real['lchown'](path,uid,gid)
 def readlink(path,*args,**kwargs):
  target=real['readlink'](path,*args,**kwargs)
  if perturb_atime and key(path) in store:
   info=os.lstat(path); os.utime(path,ns=(info.st_atime_ns+1000000,info.st_mtime_ns),follow_symlinks=False)
  return target
 os.listxattr=listxattr; os.getxattr=getxattr; os.setxattr=setxattr; os.unlink=unlink; os.symlink=symlink; os.replace=replace; os.lchown=lchown; os.readlink=readlink
 previous=sys.argv
 try:
  sys.argv=['symlink-rewriter',str(root),str(old_uid),str(old_gid),str(new_uid),str(new_gid),str(int(remap_uid)),str(int(remap_gid))]
  exec(guest.SYMLINK_IDENTITY_REWRITER,{})
 finally:
  sys.argv=previous
  for name,value in real.items(): setattr(os,name,value)
 return store,calls

with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary); target=root/'target'; target.write_bytes(b'unchanged target')
 links={root/'relative':'target',root/'absolute':str(target.resolve()),root/'dangling':'missing-target'}
 timestamp=1234567890000000000
 # Linux relatime re-stamps a link's atime whenever it is followed while
 # atime<=ctime; a future atime keeps the baseline stable across traversal.
 future_atime=time.time_ns()+86400*10**9
 for path,target_value in links.items():
  path.symlink_to(target_value); os.utime(path,ns=(future_atime,timestamp+1000000),follow_symlinks=False)
 before={}
 for path in links:
  target_value=os.readlink(path); before[path]=(os.lstat(path),target_value)
 sibling=root/'sibling'; sibling.write_bytes(b'do not replace'); sibling_before=(os.lstat(sibling).st_ino,sibling.read_bytes())
 attrs={path:{'user.hivra.test':('value-'+path.name).encode()} for path in links}
 rewritten,calls=rewrite_symlinks(root,os.getuid(),os.getgid(),os.getuid(),os.getgid(),True,True,attrs,perturb_atime=True)
 assert len(calls)==3
 for path,target_value in links.items():
  old_info,old_target=before[path]; new_info=os.lstat(path)
  assert stat.S_ISLNK(new_info.st_mode) and os.readlink(path)==old_target==target_value
  assert (new_info.st_uid,new_info.st_gid,stat.S_IMODE(new_info.st_mode))==(old_info.st_uid,old_info.st_gid,stat.S_IMODE(old_info.st_mode))
  assert (new_info.st_atime_ns,new_info.st_mtime_ns)==(old_info.st_atime_ns,old_info.st_mtime_ns)
  assert rewritten[os.path.join(os.path.realpath(path.parent),path.name)]==attrs[path]
 assert (os.lstat(sibling).st_ino,sibling.read_bytes())==sibling_before
 assert target.read_bytes()==b'unchanged target'
 unselected=root/'unselected'; unselected.symlink_to('still-unselected'); unselected_before=(os.lstat(unselected),os.readlink(unselected))
 rewritten,calls=rewrite_symlinks(root,os.getuid()+1,os.getgid()+1,os.getuid(),os.getgid(),True,True,{unselected:{'user.hivra.test':b'untouched'}})
 assert calls==[] and os.readlink(unselected)==unselected_before[1] and os.lstat(unselected).st_ino==unselected_before[0].st_ino
 assert rewritten[os.path.join(os.path.realpath(unselected.parent),unselected.name)]=={'user.hivra.test':b'untouched'}

with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary); selected=root/'selected'; selected.symlink_to('target')
 collision=root/f'.selected.hivra-identity-{os.getpid()}-0'; collision.write_bytes(b'preserve collision')
 try: rewrite_symlinks(root,os.getuid(),os.getgid(),os.getuid(),os.getgid(),True,True,{selected:{}}); raise AssertionError('temporary sibling overwrite accepted')
 except RuntimeError as error: assert str(error)=='temporary symlink exists'
 assert collision.read_bytes()==b'preserve collision' and os.readlink(selected)=='target'

with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary); selected=root/'selected'; selected.symlink_to('target')
 try: rewrite_symlinks(root,os.getuid(),os.getgid(),os.getuid(),os.getgid(),True,True,{selected:{'user.overlay.metacopy':b'blocked'}}); raise AssertionError('overlay metadata accepted')
 except RuntimeError as error: assert str(error)=='unsupported xattrs'
 assert os.readlink(selected)=='target'

def failed_build(command,**options):
 if command[:3]==['/usr/bin/docker','image','inspect']:
  return types.SimpleNamespace(stdout=json.dumps([document(False)]),stderr='',returncode=0)
 if command[:2]==['/usr/bin/docker','build']:
  return types.SimpleNamespace(stdout='',stderr='step output\\nHIVRA_DESKTOP_IDENTITY_BUILD_FAILURE special_mode_contract\\n',returncode=1)
 raise AssertionError(command)
guest.run=failed_build
try: guest.build_identity_image(1001,1001); raise AssertionError('special-mode failure marker ignored')
except RuntimeError as error: assert str(error)=='desktop_identity_image_build_special_mode_contract_failed'

def failed_symlink_build(command,**options):
 if command[:3]==['/usr/bin/docker','image','inspect']:
  return types.SimpleNamespace(stdout=json.dumps([document(False)]),stderr='',returncode=0)
 if command[:2]==['/usr/bin/docker','build']:
  return types.SimpleNamespace(stdout='',stderr='step output\\nHIVRA_DESKTOP_IDENTITY_BUILD_FAILURE symlink_identity_rewrite\\n',returncode=1)
 raise AssertionError(command)
guest.run=failed_symlink_build
try: guest.build_identity_image(1001,1001); raise AssertionError('symlink failure marker ignored')
except RuntimeError as error: assert str(error)=='desktop_identity_image_build_symlink_identity_rewrite_failed'
`;
    const result = spawnSync("python3", ["-I", "-B", "-c", program, installerPath], { encoding: "utf8" });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("probes container write-through ownership before publishing desktop capability", () => {
    const installer = readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py"), "utf8");
    expect(installer).toContain("verify_workspace_identity(runtime_image_id, bux_uid, bux_gid)");
    expect(installer).toContain('"--network", "none", "--read-only"');
    expect(installer).toContain('"--cap-drop", "ALL", "--security-opt", "no-new-privileges"');
    expect(installer).toContain('"--entrypoint", "/bin/bash", runtime_image_id');
    expect(installer).toContain('info.st_uid != uid');
    expect(installer).toContain('info.st_gid != gid');
    expect(installer).toContain("os.O_DIRECTORY | os.O_NOFOLLOW");
    expect(installer).toContain("os.fstat(workspace_fd)");
    expect(installer).toContain("os.stat(probe_name, dir_fd=workspace_fd, follow_symlinks=False)");
    expect(installer).toContain("os.unlink(probe_name, dir_fd=workspace_fd)");
    expect(installer).not.toContain("probe_directory.mkdir");
    expect(installer).not.toContain("os.chown(probe_directory");
    expect(installer.indexOf("verify_workspace_identity(runtime_image_id"))
      .toBeLessThan(installer.indexOf("selkies_unit = f"));
    const imageBuild = installer.indexOf("image_identity = resolve_identity_image(bux_uid, bux_gid)");
    const workspaceProof = installer.indexOf("verify_workspace_identity(runtime_image_id, bux_uid, bux_gid)");
    for (const persistentWrite of [
      'for source_file in (broker_source, server_source):',
      "write_private(CONTROL_BYPASS_PATH, control_bypass_secret",
      "write_private(basic_path, basic_pair",
      "write_private(docker_env_path",
      "write_private(broker_env_path",
    ]) {
      expect(imageBuild).toBeGreaterThanOrEqual(0);
      expect(workspaceProof).toBeGreaterThan(imageBuild);
      expect(installer.indexOf(persistentWrite)).toBeGreaterThan(workspaceProof);
    }
    expect(installer).toContain("{runtime_image_id}");
    expect(installer).not.toContain("{IMAGE}\nExecStop=");
  });
});
