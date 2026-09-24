import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runRecoverStuckHivraProvisioningSweep,
  STUCK_PROVISIONING_THRESHOLD_MS,
} from "../recover-stuck-provisioning";
import { reconcileBankrEnvAfterHivraBoot } from "@/lib/agent-wallets/hivra-lane";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { captureHivraAgentComputerReady } from "@/lib/hivra/agent-ready-telemetry";
import { deleteBoxTunnel } from "@/lib/services/cloudflare-tunnel";
import { prepareHivraTailscaleForDelete } from "@/lib/hivra/tailscale-private-access";
import {
  checkHivraAgentRecoveryAuthority,
  resolveHivraAgentExecutionContext,
  resolveHivraAgentTeardownExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import {
  checkpointHivraAgentOperation,
  completeHivraAgentDelete,
  completeHivraAgentOperation,
  completeHivraAgentRunning,
  continueHivraAgentOperation,
  continueHivraAgentResizeOperation,
  claimHivraAgentOperationRecovery,
  persistHivraAgentProvisionIdentity,
  releaseHivraAgentOperation,
} from "@/lib/hivra/agent-operation-store";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/hivra/agent-ready-telemetry", () => ({
  captureHivraAgentComputerReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/agent-wallets/hivra-lane", () => ({
  reconcileBankrEnvAfterHivraBoot: jest.fn(),
}));

jest.mock("@/lib/services/cloudflare-tunnel", () => ({
  deleteBoxTunnel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/hivra/tailscale-private-access", () => ({
  prepareHivraTailscaleForDelete: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

jest.mock("@/lib/hivra/agent-execution-context", () => ({
  checkHivraAgentRecoveryAuthority: jest.fn(),
  resolveHivraAgentExecutionContext: jest.fn(),
  resolveHivraAgentTeardownExecutionContext: jest.fn(),
  hivraAgentProvisionLogPath: (context: { paths: { logDirectory: string; provisionLogPrefix: string } }, vmid: number) =>
    `${context.paths.logDirectory}/${context.paths.provisionLogPrefix}${vmid}.log`,
  hivraAgentProvisionSecretPath: (_context: { kind: string }, vmid: number) =>
    `/var/lib/hivra/provision-results/${vmid}.secret`,
  hivraAgentStartLogPath: (context: { paths: { logDirectory: string; startLogPrefix: string } }, vmid: number) =>
    `${context.paths.logDirectory}/${context.paths.startLogPrefix}${vmid}.log`,
}));

jest.mock("@/lib/hivra/agent-operation-store", () => ({
  checkpointHivraAgentOperation: jest.fn(),
  completeHivraAgentDelete: jest.fn(),
  completeHivraAgentOperation: jest.fn(),
  completeHivraAgentRunning: jest.fn(),
  continueHivraAgentOperation: jest.fn(),
  continueHivraAgentResizeOperation: jest.fn(),
  claimHivraAgentOperationRecovery: jest.fn(),
  persistHivraAgentProvisionIdentity: jest.fn(),
  releaseHivraAgentOperation: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const AGENT_ID = "00000000-0000-4000-8000-000000001028";

interface RecordedUpdate {
  fields: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

function buildStuckRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: AGENT_ID,
    user_id: "user_42",
    type: "claude-code",
    computer_profile: null,
    computer_substrate: "proxmox-kvm",
    status: "provisioning",
    vmid: 1093,
    ip: "10.250.20.93",
    proxmox_host: "fixturenode21",
    deployment_mode: "hivra-managed",
    infrastructure_connection_id: null,
    deployment_target_id: null,
    infrastructure_connection_revision: null,
    infrastructure_binding_token_hash: "b".repeat(64),
    infrastructure_binding_token_enforced: true,
    cf_tunnel_id: "cf-tunnel-1",
    cf_hostname: "box-fixturecase01.hermesos.cloud",
    chat_url: null,
    api_token: "a".repeat(64),
    provisioned_at: null,
    desired_state: "running",
    operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    operation_kind: "provision",
    operation_started_at: "2026-06-07T09:38:17Z",
    operation_payload: null,
    allocation_operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    created_at: "2026-06-07T09:38:17Z",
    ...overrides,
  };
}

const READY_MARKER =
  `{"vmid":1093,"ip":"10.250.20.93","cores":2,"mem_mb":4096,"agent_kind":"claude","api_token":"${"a".repeat(64)}","chat_url":"https://box-fixturecase01.hermesos.cloud","ready":true}`;

describe("runRecoverStuckHivraProvisioningSweep", () => {
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;
  const mockedResolveTarget = resolveProxmoxTargetConfiguration as jest.MockedFunction<
    typeof resolveProxmoxTargetConfiguration
  >;
  const mockedLogEvent = logHivraAgentEvent as jest.MockedFunction<typeof logHivraAgentEvent>;
  const mockedCaptureReady = captureHivraAgentComputerReady as jest.MockedFunction<
    typeof captureHivraAgentComputerReady
  >;
  const mockedResolveContext = resolveHivraAgentExecutionContext as jest.MockedFunction<
    typeof resolveHivraAgentExecutionContext
  >;
  const mockedCheckRecoveryAuthority = checkHivraAgentRecoveryAuthority as jest.MockedFunction<
    typeof checkHivraAgentRecoveryAuthority
  >;
  const mockedResolveTeardownContext = resolveHivraAgentTeardownExecutionContext as jest.MockedFunction<
    typeof resolveHivraAgentTeardownExecutionContext
  >;
  const mockedCompleteRunning = completeHivraAgentRunning as jest.MockedFunction<
    typeof completeHivraAgentRunning
  >;
  const mockedCheckpointOperation = checkpointHivraAgentOperation as jest.MockedFunction<
    typeof checkpointHivraAgentOperation
  >;
  const mockedCompleteOperation = completeHivraAgentOperation as jest.MockedFunction<
    typeof completeHivraAgentOperation
  >;
  const mockedContinueOperation = continueHivraAgentOperation as jest.MockedFunction<
    typeof continueHivraAgentOperation
  >;
  const mockedContinueResizeOperation = continueHivraAgentResizeOperation as jest.MockedFunction<
    typeof continueHivraAgentResizeOperation
  >;
  const mockedPersistIdentity = persistHivraAgentProvisionIdentity as jest.MockedFunction<
    typeof persistHivraAgentProvisionIdentity
  >;
  const mockedClaimRecovery = claimHivraAgentOperationRecovery as jest.MockedFunction<
    typeof claimHivraAgentOperationRecovery
  >;
  const mockedReleaseOperation = releaseHivraAgentOperation as jest.MockedFunction<
    typeof releaseHivraAgentOperation
  >;
  const mockedCompleteDelete = completeHivraAgentDelete as jest.MockedFunction<
    typeof completeHivraAgentDelete
  >;
  const mockedPreparePrivateAccess = prepareHivraTailscaleForDelete as jest.MockedFunction<
    typeof prepareHivraTailscaleForDelete
  >;
  const mockedReconcileWallet = reconcileBankrEnvAfterHivraBoot as jest.MockedFunction<
    typeof reconcileBankrEnvAfterHivraBoot
  >;
  const realFetch = global.fetch;
  let updates: RecordedUpdate[];

  function installSupabase(
    rows: Array<Record<string, unknown>>,
    opts: { updateMatches?: boolean } = {},
  ) {
    // Guarded updates (.eq("status","provisioning")) report the rows they
    // actually flipped via .select(). updateMatches=false simulates losing the
    // race to a concurrent poll: the update lands on zero rows.
    const updateMatches = opts.updateMatches !== false;
    updates = [];
    mockedFrom.mockImplementation(() => {
      const filters: Array<[string, unknown]> = [];
      let updateFields: Record<string, unknown> | null = null;
      let candidateLimit = Infinity;
      let excludesFolderRecovery = false;
      let excludesDesktopPrepare = false;
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = jest.fn(self);
      chain.is = jest.fn((col: string, val: unknown) => {
        filters.push([col, val]);
        return chain;
      });
      chain.not = jest.fn((col: string, op: string, val: unknown) => {
        filters.push([`${col}:${op}`, val]);
        return chain;
      });
      chain.lt = jest.fn(self);
      chain.neq = jest.fn((col: string, val: unknown) => {
        expect([col, val]).toEqual(["operation_kind", "desktop_prepare"]);
        excludesDesktopPrepare = true;
        return chain;
      });
      chain.order = jest.fn(self);
      chain.or = jest.fn((filter: string) => {
        expect(filter).toBe("operation_kind.neq.restore,operation_payload->>folderRecoveryId.is.null");
        excludesFolderRecovery = true;
        return chain;
      });
      chain.limit = jest.fn((limit: number) => { candidateLimit = limit; return chain; });
      chain.eq = jest.fn((col: string, val: unknown) => {
        filters.push([col, val]);
        return chain;
      });
      chain.update = jest.fn((fields: Record<string, unknown>) => {
        updateFields = fields;
        return chain;
      });
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (updateFields) {
          updates.push({ fields: updateFields, filters });
          const idFilter = filters.find(([col]) => col === "id");
          return resolve({
            data: updateMatches ? [{ id: idFilter?.[1] ?? null }] : [],
            error: null,
          });
        }
        const eligible = excludesDesktopPrepare ? rows.filter(row => row.operation_kind !== "desktop_prepare") : rows;
        const candidates = excludesFolderRecovery ? eligible.filter((row) => row.operation_kind !== "restore"
          || (row.operation_payload as Record<string, unknown> | null)?.folderRecoveryId == null) : eligible;
        return resolve({ data: candidates.slice(0, candidateLimit), error: null });
      };
      return chain;
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveTarget.mockReturnValue({ id: "fixturenode21", env: {} } as ReturnType<
      typeof resolveProxmoxTargetConfiguration
    >);
    mockedResolveContext.mockResolvedValue({
      kind: "managed",
      provisionerChannel: "default",
      host: "fixturenode21",
      env: { PROXMOX_VMID_START: "1000", PROXMOX_VMID_END: "1200" },
      paths: {
        provisionerDirectory: "/root/hivra-provisioner",
        logDirectory: "/root",
        provisionLogPrefix: "hivra-prov-",
        startLogPrefix: "hivra-start-",
        storage: "local-lvm",
        vmSshKeyPath: null,
      },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
      infrastructureBindingTagEnforced: true,
    });
    mockedResolveTeardownContext.mockImplementation(mockedResolveContext);
    mockedCheckRecoveryAuthority.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    mockedCompleteRunning.mockResolvedValue(true);
    mockedCheckpointOperation.mockResolvedValue(true);
    mockedCompleteOperation.mockResolvedValue(true);
    mockedContinueOperation.mockResolvedValue(true);
    mockedContinueResizeOperation.mockResolvedValue(true);
    mockedPersistIdentity.mockResolvedValue(true);
    mockedClaimRecovery.mockResolvedValue(true);
    mockedReleaseOperation.mockResolvedValue(true);
    mockedCompleteDelete.mockResolvedValue(true);
    mockedPreparePrivateAccess.mockResolvedValue({ ok: true, disposition: "guest_logged_out" });
    mockedReconcileWallet.mockReset().mockResolvedValue({ status: "skipped" });
    global.fetch = jest.fn().mockRejectedValue(new Error("no network in tests"));
  });

  it("starts evidence-only reconciliation after the normal launch window", () => {
    expect(STUCK_PROVISIONING_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });

  it("includes target-bound rows so owner-scoped portable recovery can reconcile them", async () => {
    installSupabase([]);

    await runRecoverStuckHivraProvisioningSweep();

    expect(mockedFrom.mock.results.some((result) => result.value?.is?.mock?.calls?.length > 0)).toBe(false);
    const query = mockedFrom.mock.results[0].value;
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("operation_id"));
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("allocation_operation_id"));
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("infrastructure_binding_token_hash"));
    expect(query.not).toHaveBeenCalledWith("operation_id", "is", null);
    expect(query.eq).not.toHaveBeenCalledWith("status", "provisioning");
    expect(query.lt).toHaveBeenCalledWith("operation_started_at", expect.any(String));
    expect(query.lt).not.toHaveBeenCalledWith("created_at", expect.anything());
  });

  it("checks owner-bound SSH authority, then claims the exact stale lease before any provider probe", async () => {
    installSupabase([buildStuckRow()]);
    mockedClaimRecovery.mockResolvedValue(false);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 });
    expect(mockedClaimRecovery).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedOperationStartedAt: "2026-06-07T09:38:17Z",
    }));
    expect(mockedCheckRecoveryAuthority).toHaveBeenCalledWith(expect.objectContaining({
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
    }));
    expect(mockedCheckRecoveryAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      mockedClaimRecovery.mock.invocationCallOrder[0],
    );
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("does not renew a stale lease when owner-bound credentials cannot be resolved", async () => {
    installSupabase([buildStuckRow({
      deployment_mode: "self-managed",
      proxmox_host: "hivra-self-managed",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 7,
    })]);
    mockedResolveTeardownContext.mockRejectedValue(new Error("credential decrypt failed"));

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 });
    expect(mockedCheckRecoveryAuthority).not.toHaveBeenCalled();
    expect(mockedClaimRecovery).not.toHaveBeenCalled();
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("does not renew a stale lease when the exact owner-bound SSH authority is unusable", async () => {
    installSupabase([buildStuckRow({
      deployment_mode: "self-managed",
      proxmox_host: "hivra-self-managed",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 7,
    })]);
    mockedCheckRecoveryAuthority.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Permission denied (publickey)",
      error: "ssh failed",
    });

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 });
    expect(mockedCheckRecoveryAuthority).toHaveBeenCalledTimes(1);
    expect(mockedClaimRecovery).not.toHaveBeenCalled();
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it.each(["start", "restart"])(
    "releases a pre-transition stale %s lease when the operation receipt never landed and provider state is unchanged",
    async (operationKind) => {
      installSupabase([buildStuckRow({
        status: "running",
        operation_kind: operationKind,
        allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      })]);
      mockedRunScript.mockResolvedValue({
        ok: true,
        stdout: [
          "HIVRA_RECOVERY_VM exists",
          "HIVRA_RECOVERY_VM_STATUS running",
          "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
          "HIVRA_RECOVERY_OWNERSHIP match",
          "HIVRA_RECOVERY_OPERATION_RECEIPT missing",
          "",
        ].join("\n"),
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

      const summary = await runRecoverStuckHivraProvisioningSweep();

      expect(summary).toMatchObject({ scanned: 1, skipped: 1 });
      expect(mockedCompleteOperation).toHaveBeenCalledWith(expect.objectContaining({
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expectedDesiredState: "running",
        status: "running",
      }));
      expect(mockedCompleteRunning).not.toHaveBeenCalled();
    },
  );

  it("continues a pre-transition restart lease before accepting its exact start-log result", async () => {
    installSupabase([buildStuckRow({
      status: "running",
      operation_kind: "restart",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        "HIVRA_RECOVERY_VM_STATUS running",
        "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
        "HIVRA_RECOVERY_OWNERSHIP match",
        "HIVRA_RECOVERY_OPERATION_RECEIPT match",
        `HIVRA_RECOVERY_MARKER ${READY_MARKER}`,
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 1 });
    expect(mockedContinueOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "provisioning",
    }));
    expect(mockedCompleteRunning).toHaveBeenCalledWith(expect.objectContaining({
      operationKind: "restart",
    }));
  });

  it("settles a stale start with a matching receipt but no healthy result from exact locked VM state", async () => {
    installSupabase([buildStuckRow({
      status: "provisioning",
      operation_kind: "start",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        "HIVRA_RECOVERY_VM_STATUS running",
        "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
        "HIVRA_RECOVERY_OWNERSHIP match",
        "HIVRA_RECOVERY_OPERATION_RECEIPT match",
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, recovered: 1, skipped: 0 });
    expect(mockedCompleteOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedDesiredState: "running",
      status: "running",
    }));
    expect(mockedRunScript.mock.calls[0][0]).toContain("/run/lock/hivra-allocation.lock");
  });

  it("recovers a legacy cpu/ram-only resize with pinned maxima through the atomic envelope CAS", async () => {
    installSupabase([buildStuckRow({
      status: "running",
      operation_kind: "resize",
      operation_payload: { cpu: 2, ram: 4 },
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        "HIVRA_RECOVERY_VM_STATUS running",
        "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
        "HIVRA_RECOVERY_OWNERSHIP match",
        "HIVRA_RECOVERY_OPERATION_RECEIPT missing",
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 1 });
    expect(mockedContinueResizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      status: "provisioning", cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4,
    }));
    expect(mockedContinueOperation).not.toHaveBeenCalled();
  });

  it("settles a stale resize with a matching receipt but no healthy result from exact provider configuration", async () => {
    installSupabase([buildStuckRow({
      status: "provisioning",
      operation_kind: "resize",
      operation_payload: { cpu: 2, ram: 4 },
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        "HIVRA_RECOVERY_VM_STATUS running",
        "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
        "HIVRA_RECOVERY_OWNERSHIP match",
        "HIVRA_RECOVERY_OPERATION_RECEIPT match",
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, recovered: 1, skipped: 0 });
    expect(mockedContinueResizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "provisioning",
      cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4,
    }));
  });

  it("recovers an explicit resize only from its exact maximum and persists all four values atomically", async () => {
    installSupabase([buildStuckRow({
      status: "provisioning",
      operation_kind: "resize",
      operation_payload: { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 },
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        "HIVRA_RECOVERY_VM_STATUS running",
        "HIVRA_RECOVERY_VM_CONFIG 4 4 8192 4096",
        "HIVRA_RECOVERY_OWNERSHIP match",
        "HIVRA_RECOVERY_OPERATION_RECEIPT missing",
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 1 });
    expect(mockedContinueResizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8,
    }));
    expect(mockedCompleteOperation).toHaveBeenCalledWith(expect.not.objectContaining({ cpu: expect.anything() }));
  });

  it("converges a stale stop lease from exact stopped provider state", async () => {
    installSupabase([buildStuckRow({
      status: "running",
      desired_state: "stopped",
      operation_kind: "stop",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        "HIVRA_RECOVERY_VM_STATUS stopped",
        "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
        "HIVRA_RECOVERY_OWNERSHIP match",
        "HIVRA_RECOVERY_OPERATION_RECEIPT missing",
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 1 });
    expect(mockedCompleteOperation).toHaveBeenCalledWith(expect.objectContaining({
      expectedDesiredState: "stopped",
      status: "stopped",
    }));
  });

  it.each(["folder", "desktop_prepare"])("does not let twelve old %s journals starve an unrelated recoverable lifecycle operation", async kind => {
    const folderRows = Array.from({ length: 12 }, (_, index) => buildStuckRow({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      operation_kind: kind === "folder" ? "restore" : "desktop_prepare",
      operation_payload: kind === "folder" ? { folderRecoveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : {},
      operation_started_at: "2026-06-01T00:00:00Z",
    }));
    installSupabase([...folderRows, buildStuckRow({ status: "running", desired_state: "stopped",
      operation_kind: "stop", allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })]);
    mockedRunScript.mockResolvedValue({ ok: true, stderr: "", stdout: [
      "HIVRA_RECOVERY_VM exists", "HIVRA_RECOVERY_VM_STATUS stopped", "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
      "HIVRA_RECOVERY_OWNERSHIP match", "HIVRA_RECOVERY_OPERATION_RECEIPT missing", "",
    ].join("\n") } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    const summary = await runRecoverStuckHivraProvisioningSweep();
    expect(summary).toMatchObject({ scanned: 1, recovered: 1, skipped: 0 });
    expect(mockedCompleteOperation).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID, status: "stopped" }));
    expect(mockedRunScript).toHaveBeenCalledTimes(1);
  });

  it.each(["start", "stop", "restart", "resize"])(
    "releases a delete-superseded %s lease only after FD8 and exact provider ownership evidence",
    async (operationKind) => {
      installSupabase([buildStuckRow({
        status: operationKind === "stop" ? "running" : "provisioning",
        desired_state: "deleted",
        operation_kind: operationKind,
        operation_payload: operationKind === "resize" ? { cpu: 2, ram: 4 } : null,
        allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      })]);
      mockedRunScript.mockResolvedValue({
        ok: true,
        stdout: [
          "HIVRA_RECOVERY_VM exists",
          "HIVRA_RECOVERY_VM_STATUS running",
          "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
          "HIVRA_RECOVERY_OWNERSHIP match",
          "HIVRA_RECOVERY_OPERATION_RECEIPT match",
          "",
        ].join("\n"),
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

      const summary = await runRecoverStuckHivraProvisioningSweep();

      expect(summary).toMatchObject({ scanned: 1, skipped: 1 });
      expect(mockedRunScript.mock.calls[0][0]).toContain("/run/lock/hivra-allocation.lock");
      expect(mockedRunScript.mock.calls[0][0]).toContain(`hivra-bind-${"b".repeat(32)}`);
      expect(mockedReleaseOperation).toHaveBeenCalledWith(expect.objectContaining({
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        markError: false,
      }));
    },
  );

  it("retains a delete-superseded lifecycle lease when provider ownership is not exact", async () => {
    installSupabase([buildStuckRow({
      desired_state: "deleted",
      operation_kind: "restart",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        "HIVRA_RECOVERY_VM_STATUS running",
        "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
        "HIVRA_RECOVERY_OWNERSHIP mismatch",
        "HIVRA_RECOVERY_OPERATION_RECEIPT match",
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, skipped: 1 });
    expect(mockedReleaseOperation).not.toHaveBeenCalled();
  });

  it("retries and completes a stale delete only after provider and storage absence are verified", async () => {
    installSupabase([buildStuckRow({
      status: "stopped",
      desired_state: "deleted",
      operation_kind: "delete",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_RECOVERED_DELETE_OK 1093\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ cancelled: 1 });
    expect(mockedRunScript).toHaveBeenCalledWith(
      expect.stringContaining("VM volumes remain after delete reconciliation"),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockedCompleteDelete).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
    expect(mockedPreparePrivateAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: AGENT_ID, operation_kind: "delete", computer_substrate: "proxmox-kvm" }),
      expect.objectContaining({ infrastructureBindingTagEnforced: true }),
    );
  });

  it("retains a stale delete when exact-bound private-access logout is unconfirmed", async () => {
    installSupabase([buildStuckRow({
      status: "stopped",
      desired_state: "deleted",
      operation_kind: "delete",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })]);
    mockedPreparePrivateAccess.mockResolvedValue({
      ok: false, disposition: "unconfirmed", failureCode: "guest_unreachable",
    });

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, skipped: 1 });
    expect(mockedRunScript).not.toHaveBeenCalledWith(
      expect.stringContaining("VM volumes remain after delete reconciliation"),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockedCompleteDelete).not.toHaveBeenCalled();
  });

  it("recovers a provider coordinate from the exact persistent operation intent before probing it", async () => {
    installSupabase([buildStuckRow({ vmid: null, ip: null, allocation_operation_id: null })]);
    mockedRunScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: "HIVRA_RECOVERY_INTENT 1093 10.250.20.93\n",
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>)
      .mockResolvedValueOnce({
        ok: true,
        stdout: [
          "HIVRA_RECOVERY_VM exists",
          "HIVRA_RECOVERY_VM_STATUS running",
          "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
          "HIVRA_RECOVERY_OWNERSHIP match",
          "HIVRA_RECOVERY_OPERATION_RECEIPT missing",
          `HIVRA_RECOVERY_MARKER ${READY_MARKER}`,
          "",
        ].join("\n"),
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(mockedPersistIdentity).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vmid: 1093,
      ip: "10.250.20.93",
    }));
    expect(summary).toMatchObject({ recovered: 1 });
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it("flips a stuck row to running from the orchestrator log marker", async () => {
    installSupabase([buildStuckRow()]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: `HIVRA_RECOVERY_VM exists\nHIVRA_RECOVERY_OWNERSHIP match\nHIVRA_RECOVERY_MARKER ${READY_MARKER}\n`,
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, recovered: 1, markedError: 0, skipped: 0 });
    expect(summary.results[0]).toMatchObject({ action: "recovered_from_log" });
    expect(mockedCompleteRunning).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_42",
      agentId: AGENT_ID,
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operationKind: "provision",
      chatUrl: "https://box-fixturecase01.hermesos.cloud",
      ip: "10.250.20.93",
      apiToken: "a".repeat(64),
      provisionedAt: expect.any(String),
    }));
    expect(mockedLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "provisioned",
        agentId: AGENT_ID,
        detail: expect.objectContaining({ recovered: true, via: "log_marker" }),
      })
    );
    expect(mockedCaptureReady).toHaveBeenCalledWith({
      userId: "user_42",
      agentId: AGENT_ID,
      agentType: "claude-code",
      deploymentMode: "hivra-managed",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vmid: 1093,
      evidence: "recovery_log_marker",
    });
    // Recovery keeps the box's tunnel — teardown is for terminal failures only.
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
  });

  it("preserves an existing provisioned_at on recovery", async () => {
    installSupabase([buildStuckRow({ provisioned_at: "2026-06-01T00:00:00Z" })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: `HIVRA_RECOVERY_VM exists\nHIVRA_RECOVERY_OWNERSHIP match\nHIVRA_RECOVERY_MARKER ${READY_MARKER}\n`,
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    await runRecoverStuckHivraProvisioningSweep();

    expect(mockedCompleteRunning).toHaveBeenCalledWith(expect.objectContaining({
      provisionedAt: "2026-06-01T00:00:00Z",
    }));
    expect(mockedCaptureReady).not.toHaveBeenCalled();
  });

  it("recovers the persistent one-shot bearer after a host reboot and consumes it", async () => {
    installSupabase([buildStuckRow({
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      infrastructure_connection_id: "11111111-1111-4111-8111-111111111111",
      deployment_target_id: "22222222-2222-4222-8222-222222222222",
      infrastructure_connection_revision: 3,
    })]);
    mockedResolveContext.mockResolvedValue({
      kind: "self-managed",
      host: "pve-user",
      env: {},
      paths: {
        provisionerDirectory: "/opt/hivra/provisioner",
        logDirectory: "/var/log/hivra",
        provisionLogPrefix: "provision-",
        startLogPrefix: "start-",
        storage: "local-lvm",
        vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
      infrastructureBindingTagEnforced: true,
    } as unknown as Awaited<ReturnType<typeof resolveHivraAgentExecutionContext>>);
    mockedRunScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: `HIVRA_RECOVERY_VM exists\nHIVRA_RECOVERY_OWNERSHIP match\nHIVRA_RECOVERY_MARKER ${READY_MARKER}\nHIVRA_RECOVERY_SECRET ${"c".repeat(64)}\n`,
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 1 });
    expect(mockedRunScript.mock.calls[0][0]).toContain("/var/lib/hivra/provision-results/1093.secret");
    expect(mockedCompleteRunning).toHaveBeenCalledWith(expect.objectContaining({ apiToken: "c".repeat(64) }));
    expect(mockedRunScript.mock.calls[1][0]).toContain("rm -f -- '/var/lib/hivra/provision-results/1093.secret'");
  });

  it("recovers via tunnel healthz when the VM exists but no marker landed", async () => {
    installSupabase([buildStuckRow()]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_RECOVERY_VM exists\nHIVRA_RECOVERY_OWNERSHIP match\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 1 });
    expect(summary.results[0]).toMatchObject({ action: "recovered_via_tunnel" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://box-fixturecase01.hermesos.cloud/healthz",
      expect.objectContaining({ redirect: "manual" })
    );
    expect(mockedCompleteRunning).toHaveBeenCalledWith(expect.objectContaining({
      chatUrl: "https://box-fixturecase01.hermesos.cloud",
    }));
  });

  it("skips (no update) when the host probe fails — transient, retried next sweep", async () => {
    installSupabase([buildStuckRow()]);
    mockedRunScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host refused",
      error: "ssh failed",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, recovered: 0, markedError: 0, skipped: 1 });
    expect(updates).toHaveLength(0);
  });

  it.each(["running", "stopped"])("preserves an owned %s VM and its provision lease without a terminal result", async (vmStatus) => {
    installSupabase([buildStuckRow()]);
    mockedRunScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: [
          "HIVRA_RECOVERY_VM exists",
          `HIVRA_RECOVERY_VM_STATUS ${vmStatus}`,
          "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
          "HIVRA_RECOVERY_OWNERSHIP match",
          "HIVRA_RECOVERY_OPERATION_RECEIPT missing",
          "",
        ].join("\n"),
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ markedError: 0, recovered: 0, cancelled: 0, skipped: 1 });
    expect(summary.results[0].reason).toContain("no terminal provision result");
    expect(mockedRunScript).toHaveBeenCalledTimes(1);
    expect(mockedReleaseOperation).not.toHaveBeenCalled();
    expect(mockedCompleteDelete).not.toHaveBeenCalled();
    expect(mockedCompleteRunning).not.toHaveBeenCalled();
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("completes delete with the provision lease when delete wins during exact compensation", async () => {
    const notReady = READY_MARKER.replace('"ready":true', '"ready":false');
    installSupabase([buildStuckRow()]);
    mockedCheckpointOperation.mockResolvedValue(false);
    mockedRunScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: [
          "HIVRA_RECOVERY_VM exists",
          "HIVRA_RECOVERY_VM_STATUS running",
          "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
          "HIVRA_RECOVERY_OWNERSHIP match",
          "HIVRA_RECOVERY_OPERATION_RECEIPT missing",
          `HIVRA_RECOVERY_MARKER ${notReady}`,
          "",
        ].join("\n"),
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "HIVRA_CANCELLED_PROVISION_CLEANED 1093\n",
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ cancelled: 1, markedError: 0, skipped: 0 });
    expect(mockedCompleteDelete).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
    expect(mockedReleaseOperation).not.toHaveBeenCalled();
    // The shared finalizer owns verified cleanup; recovery must not perform
    // best-effort cleanup after erasing those resource identities.
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
  });

  it("never probes a tunnel or mutates a VM whose stable ownership tag mismatches", async () => {
    installSupabase([buildStuckRow()]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_RECOVERY_VM exists\nHIVRA_RECOVERY_OWNERSHIP mismatch\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 0, markedError: 1, skipped: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockedCompleteRunning).not.toHaveBeenCalled();
  });

  it("marks error when the VM is gone and provisioning never completed", async () => {
    installSupabase([buildStuckRow()]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_RECOVERY_VM missing\nHIVRA_RECOVERY_OWNERSHIP match\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ markedError: 1 });
    expect(mockedReleaseOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      markError: true,
    }));
    expect(mockedLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "failed",
        detail: expect.objectContaining({ reason: "stuck_provisioning_vm_missing" }),
      })
    );
    // Terminal failure: the named tunnel + CNAME created before kickoff would
    // otherwise be orphaned in the Cloudflare account (nothing else sweeps them).
    expect(deleteBoxTunnel).toHaveBeenCalledWith({
      tunnelId: "cf-tunnel-1",
      hostname: "box-fixturecase01.hermesos.cloud",
    });
  });

  it("leaves the tunnel alone when the error flip loses the race to a concurrent poll", async () => {
    installSupabase([buildStuckRow()], { updateMatches: false });
    mockedReleaseOperation.mockResolvedValue(false);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_RECOVERY_VM missing\nHIVRA_RECOVERY_OWNERSHIP match\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    await runRecoverStuckHivraProvisioningSweep();

    // Zero rows matched the provisioning-guarded update — the row was flipped
    // (possibly to running) under us, so its tunnel belongs to a live box.
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
  });

  it("trusts a live tunnel over a stale ready:false marker", async () => {
    const notReady = READY_MARKER.replace('"ready":true', '"ready":false').replace(
      '"chat_url":"https://box-fixturecase01.hermesos.cloud"',
      '"chat_url":""'
    );
    installSupabase([buildStuckRow()]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: `HIVRA_RECOVERY_VM exists\nHIVRA_RECOVERY_OWNERSHIP match\nHIVRA_RECOVERY_MARKER ${notReady}\n`,
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 1, markedError: 0 });
    expect(mockedCompleteRunning).toHaveBeenCalledWith(expect.objectContaining({
      chatUrl: "https://box-fixturecase01.hermesos.cloud",
      apiToken: "a".repeat(64),
    }));
  });

  it("compensates a terminal ready:false provision when the exactly owned VM still exists", async () => {
    const notReady = READY_MARKER.replace('"ready":true', '"ready":false');
    installSupabase([buildStuckRow()]);
    mockedRunScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: [
          "HIVRA_RECOVERY_VM exists",
          "HIVRA_RECOVERY_VM_STATUS running",
          "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
          "HIVRA_RECOVERY_OWNERSHIP match",
          "HIVRA_RECOVERY_OPERATION_RECEIPT match",
          `HIVRA_RECOVERY_MARKER ${notReady}`,
          "",
        ].join("\n"),
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "HIVRA_CANCELLED_PROVISION_CLEANED 1093\n",
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ markedError: 1, skipped: 0 });
    expect(mockedRunScript.mock.calls[1][0]).toContain("VM ownership changed during cancellation");
    expect(mockedReleaseOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      markError: true,
    }));
  });

  it("marks error on a ready:false marker when the tunnel is unreachable too", async () => {
    const notReady = READY_MARKER.replace(
      '"ready":true',
      '"ready":false,"error":"provisioning failed; cleanup verified; inspect the host log"',
    );
    installSupabase([buildStuckRow()]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: `HIVRA_RECOVERY_VM missing\nHIVRA_RECOVERY_OWNERSHIP match\nHIVRA_RECOVERY_MARKER ${notReady}\n`,
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ markedError: 1 });
    expect(mockedReleaseOperation).toHaveBeenCalledWith(expect.objectContaining({ markError: true }));
    expect(deleteBoxTunnel).toHaveBeenCalledWith({
      tunnelId: "cf-tunnel-1",
      hostname: "box-fixturecase01.hermesos.cloud",
    });

    const probeScript = String(mockedRunScript.mock.calls[0][0]);
    const fixture = mkdtempSync(path.join(tmpdir(), "hivra-recovery-failure-marker-"));
    try {
      const logPath = path.join(fixture, "provision.log");
      writeFileSync(logPath, `${notReady}\n`);
      const markerProbe = [
        probeScript.split("\n").find((line) => line.startsWith("LOG=")),
        probeScript.split("\n").find((line) => line.startsWith("MARKER=")),
        "printf '%s\\n' \"$MARKER\"",
      ].join("\n").replace("'/root/hivra-prov-1093.log'", `'${logPath}'`);
      expect(spawnSync("bash", [], { input: markerProbe, encoding: "utf8" })).toMatchObject({
        status: 0,
        stdout: `${notReady}\n`,
        stderr: "",
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("releases a stale provision with no durable host allocation intent", async () => {
    installSupabase([buildStuckRow({ vmid: null })]);
    mockedRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "missing" });

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, markedError: 1, skipped: 0 });
    expect(mockedRunScript).toHaveBeenCalledTimes(1);
    expect(mockedReleaseOperation).toHaveBeenCalledWith(expect.objectContaining({ markError: true }));
  });

  it.each([
    { cf_tunnel_id: null },
    { operation_payload: { stage: "pre_allocation_access" }, cf_tunnel_id: null, cf_hostname: null },
    { operation_payload: { stage: "pre_allocation_access" }, desired_state: "deleted" },
  ])("retains unresolved pre-allocation access state without provider mutations: %j", async (state) => {
    installSupabase([buildStuckRow({ vmid: null, ...state })]);
    const summary = await runRecoverStuckHivraProvisioningSweep();
    expect(summary).toMatchObject({ scanned: 1, markedError: 0, skipped: 1 });
    expect(mockedReleaseOperation).not.toHaveBeenCalled();
    expect(mockedCompleteDelete).not.toHaveBeenCalled();
    expect(mockedRunScript).not.toHaveBeenCalled();
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
    expect(mockedClaimRecovery).not.toHaveBeenCalled();
  });

  it("never probes a no-vmid row as an SSRF oracle even when a URL is persisted", async () => {
    installSupabase([buildStuckRow({ vmid: null })]);
    mockedRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "missing" });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ recovered: 0, markedError: 1, skipped: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockedCompleteRunning).not.toHaveBeenCalled();
  });

  it("compensates a cancelled provision only through exact owner-bound cleanup", async () => {
    installSupabase([buildStuckRow({ desired_state: "deleted" })]);
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_CANCELLED_PROVISION_CLEANED 1093\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ cancelled: 1, skipped: 0 });
    const cleanupScript = mockedRunScript.mock.calls[0][0];
    expect(cleanupScript).toContain("/run/lock/hivra-allocation.lock");
    expect(cleanupScript).toContain(`hivra-bind-${"b".repeat(32)}`);
    expect(cleanupScript).toContain("hivra-op-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa");
    expect(cleanupScript).toContain("VM volumes remain after cancellation");
    expect(mockedCompleteDelete).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
  });

  it("unwedges a delete-requested migration-window managed provision with a VMID", async () => {
    installSupabase([buildStuckRow({
      desired_state: "deleted",
      infrastructure_binding_token_enforced: false,
      allocation_operation_id: null,
      operation_payload: { compatibility: "n_minus_one" },
    })]);
    mockedResolveTeardownContext.mockResolvedValue({
      kind: "managed",
      provisionerChannel: "default",
      host: "fixturenode21",
      env: {},
      paths: {
        provisionerDirectory: "/root/hivra-provisioner",
        logDirectory: "/root",
        provisionLogPrefix: "hivra-prov-",
        startLogPrefix: "hivra-start-",
        storage: "local-lvm",
        vmSshKeyPath: null,
      },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
      infrastructureBindingTagEnforced: false,
    });
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_RECOVERED_DELETE_OK 1093\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 1, cancelled: 1, skipped: 0 });
    const cleanupScript = mockedRunScript.mock.calls[0][0];
    expect(cleanupScript).toContain("ALLOW_MANAGED_LEGACY=1");
    expect(cleanupScript).toContain("/run/lock/hivra-allocation.lock");
    expect(cleanupScript).toContain("for PROC in /proc/[0-9]*");
    expect(cleanupScript).toContain("legacy provision process $PID did not stop");
    expect(cleanupScript).toContain("VM volumes remain after delete reconciliation");
    expect(mockedCompleteDelete).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
  });

  it("retains the provision lease when a raced foreign VM makes cancellation cleanup fail", async () => {
    installSupabase([buildStuckRow({ desired_state: "deleted" })]);
    mockedRunScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "refusing to destroy a foreign VM during cancellation",
      error: "remote command failed",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ cancelled: 0, skipped: 1 });
    expect(mockedCompleteDelete).not.toHaveBeenCalled();
    expect(mockedReleaseOperation).not.toHaveBeenCalled();
  });

  it("keeps sweeping the remaining rows when one row's recovery throws", async () => {
    installSupabase([
      buildStuckRow({ id: "11111111-1111-4111-9111-111111111111", vmid: 2100 }),
      buildStuckRow({ id: "22222222-2222-4222-9222-222222222222", vmid: 1093 }),
    ]);
    mockedRunScript
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        ok: true,
        stdout: `HIVRA_RECOVERY_VM exists\nHIVRA_RECOVERY_OWNERSHIP match\nHIVRA_RECOVERY_MARKER ${READY_MARKER}\n`,
        stderr: "",
      } as Awaited<ReturnType<typeof runProxmoxHostScript>>);

    const summary = await runRecoverStuckHivraProvisioningSweep();

    expect(summary).toMatchObject({ scanned: 2, recovered: 1, skipped: 1 });
  });

  // Regression (Gap C): a box this sweep brings up after nobody polled it must
  // get the wallet row applied to its bankr.env, as a polled boot does.
  describe("wallet env after a recovered boot", () => {
    const probe = (vmStatus: string, receipt: "match" | "missing", marker = "") => ({
      ok: true,
      stdout: [
        "HIVRA_RECOVERY_VM exists",
        `HIVRA_RECOVERY_VM_STATUS ${vmStatus}`,
        "HIVRA_RECOVERY_VM_CONFIG 2 2 4096",
        "HIVRA_RECOVERY_OWNERSHIP match",
        `HIVRA_RECOVERY_OPERATION_RECEIPT ${receipt}`,
        ...(marker ? [`HIVRA_RECOVERY_MARKER ${marker}`] : []),
        "",
      ].join("\n"),
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    const staleStart = (overrides: Partial<Record<string, unknown>> = {}) => buildStuckRow({
      status: "provisioning",
      operation_kind: "start",
      allocation_operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ...overrides,
    });

    it("re-applies the wallet row once after flipping a stale start to running, without the teardown context", async () => {
      installSupabase([staleStart()]);
      mockedRunScript.mockResolvedValue(probe("running", "match", READY_MARKER));

      const summary = await runRecoverStuckHivraProvisioningSweep();

      expect(summary).toMatchObject({ recovered: 1 });
      expect(mockedReconcileWallet).toHaveBeenCalledTimes(1);
      const [call] = mockedReconcileWallet.mock.calls[0];
      expect(call).toEqual({
        userId: "user_42",
        agent: expect.objectContaining({ id: AGENT_ID, type: "claude-code", status: "running", ip: "10.250.20.93" }),
        trigger: "recovery",
      });
      expect(call.executionContext).toBeUndefined();
      expect(mockedCompleteRunning.mock.invocationCallOrder[0]).toBeLessThan(
        mockedReconcileWallet.mock.invocationCallOrder[0],
      );
    });

    it("does not touch the wallet when another poll wins the running flip", async () => {
      installSupabase([staleStart()]);
      mockedRunScript.mockResolvedValue(probe("running", "match", READY_MARKER));
      mockedCompleteRunning.mockResolvedValue(false);

      await runRecoverStuckHivraProvisioningSweep();

      expect(mockedReconcileWallet).not.toHaveBeenCalled();
    });

    it.each([
      ["settled stale start with a receipt", staleStart, "match"],
      ["stale start without a receipt", () => staleStart({ status: "running" }), "missing"],
      ["stale restart without a receipt", () => staleStart({ status: "running", operation_kind: "restart" }), "missing"],
      ["stale resize without a receipt", () => staleStart({ operation_kind: "resize", operation_payload: { cpu: 2, ram: 4 } }), "missing"],
    ] as const)("re-applies the wallet row for a %s only when the VM is running", async (_label, row, receipt) => {
      installSupabase([row()]);
      mockedRunScript.mockResolvedValue(probe("stopped", receipt));
      await runRecoverStuckHivraProvisioningSweep();
      expect(mockedCompleteOperation).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped" }));
      expect(mockedReconcileWallet).not.toHaveBeenCalled();

      installSupabase([row()]);
      mockedRunScript.mockResolvedValue(probe("running", receipt));
      await runRecoverStuckHivraProvisioningSweep();
      expect(mockedCompleteOperation).toHaveBeenLastCalledWith(expect.objectContaining({ status: "running" }));
      expect(mockedReconcileWallet).toHaveBeenCalledTimes(1);
      expect(mockedReconcileWallet).toHaveBeenCalledWith(expect.objectContaining({
        userId: "user_42",
        agent: expect.objectContaining({ id: AGENT_ID, status: "running" }),
        trigger: "recovery",
      }));
    });

    it("does not re-apply after a lost lifecycle completion", async () => {
      installSupabase([staleStart({ status: "running" })]);
      mockedRunScript.mockResolvedValue(probe("running", "missing"));
      mockedCompleteOperation.mockResolvedValue(false);

      await runRecoverStuckHivraProvisioningSweep();

      expect(mockedReconcileWallet).not.toHaveBeenCalled();
    });

    it("keeps the recovery outcome when the wallet sync rejects", async () => {
      installSupabase([staleStart()]);
      mockedRunScript.mockResolvedValue(probe("running", "match", READY_MARKER));
      mockedReconcileWallet.mockRejectedValue(new Error("unexpected"));

      const summary = await runRecoverStuckHivraProvisioningSweep();

      expect(summary).toMatchObject({ scanned: 1, recovered: 1, skipped: 0 });
      expect(summary.results[0]).toMatchObject({ action: "recovered_from_log" });
      expect(mockedReconcileWallet).toHaveBeenCalledTimes(1);
    });
  });
});
