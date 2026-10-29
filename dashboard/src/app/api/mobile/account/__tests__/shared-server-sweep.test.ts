/**
 * DELETE /api/mobile/account against the REAL instance DELETE handler (F011).
 *
 * Only the external providers and the database are stubbed (Clerk, Supabase as
 * an in-memory table, the Hetzner server delete, Cloudflare DNS). The account
 * sweep calls the instance handler once per agent, so these cases lock in what
 * a Hetzner server shared by several agents does to the sweep:
 *   - two agents on one server: the server is removed once, both rows are
 *     deleted and the Clerk user is deleted (200)
 *   - another user's live agent on the same server: the sweep refuses, no
 *     server delete, no Clerk delete (502)
 *   - a web DELETE of one agent on a shared server still refuses (409)
 */

import { NextRequest } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { deleteHetznerServer } from "@/lib/services/hetzner-instance-service";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import { DELETE as deleteAccount } from "../route";
import { DELETE as deleteInstance } from "@/app/api/instances/[id]/route";

// The same external-service mocks the instance DELETE suite uses.
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());;

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.requireActual("@/lib/ops-events").sanitizeOpsMetadata,
}));

jest.mock("@/lib/instance-activity", () => ({
  recordInstanceUserActivity: jest.fn().mockResolvedValue({
    ok: true,
    recordedAt: "2026-05-14T20:30:00.000Z",
  }),
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/hetzner/client", () => ({
  getServer: jest.fn(),
  powerOnServer: jest.fn(),
  shutdownServer: jest.fn(),
  rebootServer: jest.fn(),
  rebuildServer: jest.fn(),
  enableServerBackup: jest.fn(),
  disableServerBackup: jest.fn(),
}));

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  getHetznerInstanceStatus: jest.fn(),
  deleteHetznerServer: jest.fn(),
  resolveGatewayConfiguration: jest.fn(),
  buildAgentDeployScript: jest.fn(),
  buildAutoUpdateTimerProvisioningScript: jest.fn(() => "#!/usr/bin/env bash\necho auto-update"),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => {
  const actual = jest.requireActual("@/lib/services/proxmox-instance-service");
  return {
    ...actual,
    deleteProxmoxInstance: jest.fn(),
    discoverProxmoxInfrastructureForInstance: jest.fn(),
    getProxmoxInstanceStatus: jest.fn(),
    startProxmoxInstance: jest.fn(),
    shutdownProxmoxInstance: jest.fn(),
    rebootProxmoxInstance: jest.fn(),
    provisionProxmoxInstance: jest.fn(),
  };
});

// Gateway auto-wake admission guard: default-admit so the existing
// power-action tests exercise the start path unchanged; the wake-admission
// tests flip it to deferred per-case. Mocked (rather than fail-opening the
// real module) because the real guard would drive runProxmoxHostScript.
jest.mock("@/lib/proxmox/wake-admission", () => ({
  acquireHostWakeSlot: jest.fn(async () => ({ admitted: true, freeMb: 8192, activeWakes: 0 })),
  releaseHostWakeSlot: jest.fn(async () => undefined),
  normalizeWakeRamMb: jest.requireActual("@/lib/proxmox/wake-admission").normalizeWakeRamMb,
}));

// Cloudflare DNS calls are wired into provision/teardown but are
// orthogonal to most route-level concerns, so default to no-op shapes
// (`ok: false, error: "cloudflare_not_configured"` matches what the
// real module returns when env vars are absent — same as the
// production fallback path). Individual tests override
// `removeInstanceDnsBestEffort` when they specifically care about
// cleanup behavior.
jest.mock("@/lib/services/cloudflare-dns", () => ({
  getCloudflareDnsConfig: jest.fn(() => null),
  isCloudflareDnsConfigured: jest.fn(() => false),
  mintInstanceDns: jest.fn().mockResolvedValue({ ok: false, error: "cloudflare_not_configured" }),
  removeInstanceDns: jest.fn().mockResolvedValue({ ok: false, error: "cloudflare_not_configured" }),
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
  deriveDnsDomainFromGatewayUrl: jest.fn(() => null),
}));

jest.mock("@/lib/services/instance-orchestrator", () => ({
  getHonchoSettingsFromInstance: jest.fn(),
  resolveInstanceIpv4: jest.fn(),
  applyLiveUpdate: jest.fn(),
}));

jest.mock("@/lib/services/console-helpers", () => ({
  discoverContainerName: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
  ensureManagedHostFingerprint: jest.fn(),
  SSH_WARMUP_MESSAGE: "Instance is still provisioning SSH access. Try again in a moment.",
  isSshWarmupError: jest.fn((message: string | null | undefined) => {
    const normalized = message?.toLowerCase() ?? "";
    return (
      normalized.includes("timed out capturing ssh host fingerprint") ||
      normalized.includes("ssh fingerprint capture failed:")
    );
  }),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn((value: string) => value),
  encryptApiKey: jest.fn((value: string) => value),
}));

jest.mock("@/lib/codex-oauth", () => ({
  CODEX_DEFAULT_MODEL: "gpt-test",
  formatStoredProviderSecretPreview: jest.fn(),
  resolveCodexDeploymentSecret: jest.fn((secret: string) => ({ apiKey: secret })),
}));

jest.mock("@/lib/nous-oauth", () => ({
  resolveNousDeploymentSecret: jest.fn((secret: string) => ({ apiKey: secret })),
}));

jest.mock("@/lib/instance-settings", () => ({
  getPublicInstanceConfig: jest.fn(),
  getRuntimeAgentSettings: jest.fn(() => ({ enableRootAccess: false })),
  getAutoUpdateConfig: jest.fn(() => ({ enabled: false, time: "06:00" })),
  extractGlobalHermesSettings: jest.fn(() => ({})),
  decryptMemorySystemSecrets: jest.fn(() => undefined),
  buildAdvancedInstanceConfigPayload: jest.fn(),
}));

jest.mock("@/lib/api-response", () => {
  const actual = jest.requireActual("@/lib/api-response");
  return {
    ...actual,
    apiError: jest.fn(actual.apiError),
  };
});

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/webui/instance", () => ({
  resolveWebUIInstanceClient: jest.fn(),
}));

jest.mock("@/lib/billing/pro-tier", () => ({
  isProTierUser: jest.fn(),
}));

jest.mock("@/lib/hivra/lapse-gate", () => ({
  isHostedInstanceStartBlockedForLapse: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/lib/billing/backup-addon-billing", () => ({
  removeBackupAddonBilling: jest.fn(),
}));

// Post-ready SOUL.md seed hook: the route schedules it when a webfree box is
// promoted to running (the deterministic close of the provision seed race).
// Stubbed — the route only depends on the call, not the reconcile itself.
jest.mock("@/lib/recovery/soul-seed-reconcile", () => ({
  scheduleSoulSeedReconcileAfterResponse: jest.fn(),
}));

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  recoverProxmoxInstanceAcrossFleet: jest.fn(),
}));

type InstanceRow = Record<string, unknown> & { id: string; user_id: string };

// In-memory hermes_instances table. Reads, counts and writes filter the rows,
// so a sibling count is what the rows say. The sweep's status/lifecycle `or`
// filter is approximated as "not deleted on either column", which these
// fixtures (non-null status and lifecycle) make exact.
let rows: InstanceRow[] = [];
let deleteUserMock: jest.Mock;

function hermesInstancesTable() {
  return {
    select: jest.fn((_columns: string, options?: { head?: boolean }) => {
      const filters: Array<(row: InstanceRow) => boolean> = [];
      const matching = () => rows.filter((row) => filters.every((keep) => keep(row)));
      const query: Record<string, unknown> = {};
      query.eq = jest.fn((column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      });
      query.neq = jest.fn((column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return query;
      });
      query.or = jest.fn(() => {
        filters.push((row) => row.status !== "deleted" || row.lifecycle_state !== "deleted");
        return query;
      });
      query.returns = jest.fn(async () => ({
        data: matching().map((row) => ({ id: row.id, name: (row.name as string | undefined) ?? null })),
        error: null,
      }));
      query.single = jest.fn(async () => {
        const [row] = matching();
        return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } };
      });
      query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(
          options?.head ? { count: matching().length, error: null } : { data: matching(), error: null },
        ).then(resolve, reject);
      return query;
    }),
    update: jest.fn((patch: Record<string, unknown>) => ({
      eq: jest.fn(async (column: string, value: unknown) => {
        rows.filter((row) => row[column] === value).forEach((row) => Object.assign(row, patch));
        return { error: null };
      }),
    })),
  };
}

function installDb() {
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") return hermesInstancesTable();
    if (table === "hermes_hosts") {
      return { update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }) };
    }
    if (table === "hivra_agents") {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ neq: jest.fn().mockResolvedValue({ data: [], error: null }) }),
        }),
      };
    }
    if (table === "device_tokens") {
      return { delete: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }) };
    }
    return { update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }) };
  });
}

function agentRow(id: string, overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id,
    name: id,
    user_id: "user_123",
    status: "running",
    lifecycle_state: "running",
    provider: "openai",
    hetzner_server_id: 42,
    host_id: "host-456",
    config: {},
    ...overrides,
  };
}

function accountRequest() {
  return new NextRequest("http://localhost/api/mobile/account", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "DELETE_MY_ACCOUNT" }),
  });
}

function webDeleteAgent(id: string) {
  return deleteInstance(
    new NextRequest(`http://localhost/api/instances/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: id }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  deleteUserMock = jest.fn().mockResolvedValue(undefined);
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
  (clerkClient as unknown as jest.Mock).mockResolvedValue({ users: { deleteUser: deleteUserMock } });
  (deleteHetznerServer as jest.Mock).mockResolvedValue(undefined);
  (removeInstanceDnsBestEffort as jest.Mock).mockResolvedValue(undefined);
  installDb();
});

describe("DELETE /api/mobile/account with agents on a shared Hetzner server (F011)", () => {
  it("removes the shared server once, deletes both agents and the Clerk user (200)", async () => {
    // Regression: the sweep called the guarded instance DELETE per agent. Each
    // call counted the other live agent and got 409, so the sweep returned 502
    // and never reached Clerk. The sweep's own agents must not block each other.
    rows = [agentRow("inst-a"), agentRow("inst-b")];

    const response = await deleteAccount(accountRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      accountDeleted: true,
      deletedInstances: ["inst-a", "inst-b"],
      deletedInstanceCount: 2,
    });
    expect(deleteHetznerServer).toHaveBeenCalledTimes(1);
    expect(deleteHetznerServer).toHaveBeenCalledWith(42);
    expect(rows.map((row) => row.status)).toEqual(["deleted", "deleted"]);
    expect(deleteUserMock).toHaveBeenCalledTimes(1);
    expect(deleteUserMock).toHaveBeenCalledWith("user_123");
  });

  it("refuses the sweep when another user's live agent shares the server, and keeps the Clerk user (502)", async () => {
    // A live row that is not part of this sweep still blocks the server delete.
    rows = [agentRow("inst-a"), agentRow("inst-b"), agentRow("inst-other", { user_id: "user_999" })];

    const response = await deleteAccount(accountRequest());

    expect(response.status).toBe(502);
    expect(deleteHetznerServer).not.toHaveBeenCalled();
    expect(deleteUserMock).not.toHaveBeenCalled();
    expect(rows.filter((row) => row.user_id === "user_123").map((row) => row.status)).toEqual([
      "running",
      "running",
    ]);
    expect(rows.find((row) => row.id === "inst-other")?.status).toBe("running");
  });

  it("keeps refusing a web DELETE of one agent on a shared server (409, nothing changed)", async () => {
    rows = [agentRow("inst-a"), agentRow("inst-b")];

    const response = await webDeleteAgent("inst-a");

    expect(response.status).toBe(409);
    expect(deleteHetznerServer).not.toHaveBeenCalled();
    expect(rows.map((row) => row.status)).toEqual(["running", "running"]);
  });
});
