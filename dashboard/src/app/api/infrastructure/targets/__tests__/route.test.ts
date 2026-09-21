/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockListTargets = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

jest.mock("@/lib/infrastructure/connection-store", () => ({
  InfrastructureConnectionStoreError: class InfrastructureConnectionStoreError extends Error {
    constructor(public readonly code: string) {
      super(code);
      this.name = "InfrastructureConnectionStoreError";
    }
  },
  listInfrastructureDeploymentTargets: (...args: unknown[]) => mockListTargets(...args),
}));

import {
  InfrastructureConnectionStoreError,
} from "@/lib/infrastructure/connection-store";
import { GET } from "../route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CHECKED_AT = "2026-08-25T17:00:00.000Z";

const target = {
  id: TARGET_ID,
  connectionId: CONNECTION_ID,
  evidenceConnectionRevision: 3,
  externalId: "pve-01",
  displayName: "Home Proxmox / pve-01",
  status: "unavailable",
  capacity: {
    cpu: { totalCores: 8, utilizationRatio: 0.25 },
    memoryBytes: { total: 32_000, available: 24_000 },
    storageBytes: { total: 20_000, available: 15_000 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1",
    launchReady: false,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["vmbr0"],
    selectedBridge: "vmbr0",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: null,
    provisioner: null,
    vmidRange: { start: 200, end: 399, freeCount: 200, firstAvailable: 200 },
    issues: [{
      code: "PROVISIONER_UNAVAILABLE",
      message: "No prepared-target template or assets were configured",
    }],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: CHECKED_AT,
  lastErrorCode: "PROVISIONER_UNAVAILABLE",
  createdAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
};

function request(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/infrastructure/targets${query}`);
}

describe("GET /api/infrastructure/targets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user_a" });
    mockListTargets.mockResolvedValue([target]);
  });

  it("returns only the authenticated owner's sanitized persisted target evidence", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockListTargets).toHaveBeenCalledWith("user_a", {});
    expect(body).toEqual({ success: true, data: { targets: [target] } });
    expect(body.data.targets[0].evidenceConnectionRevision).toBe(3);
    expect(JSON.stringify(body)).not.toContain("user_a");
    expect(JSON.stringify(body)).not.toContain("sshPrivateKey");
    expect(JSON.stringify(body)).not.toContain("encrypted_bundle");
    expect(JSON.stringify(body)).not.toContain("stdout");
  });

  it("allows an owner-scoped connection filter", async () => {
    const response = await GET(request(`?connectionId=${CONNECTION_ID}`));

    expect(response.status).toBe(200);
    expect(mockListTargets).toHaveBeenCalledWith("user_a", {
      connectionId: CONNECTION_ID,
    });
  });

  it.each([
    "?connectionId=not-a-uuid",
    "?unexpected=value",
    `?connectionId=${CONNECTION_ID}&connectionId=${CONNECTION_ID}`,
  ])("rejects an invalid or ambiguous query: %s", async (query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockListTargets).not.toHaveBeenCalled();
  });

  it("requires authentication before target metadata is queried", async () => {
    mockAuth.mockResolvedValue({ userId: null });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockListTargets).not.toHaveBeenCalled();
  });

  it("maps an unavailable database without exposing the store error", async () => {
    mockListTargets.mockRejectedValue(
      new InfrastructureConnectionStoreError("database_unavailable"),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: false,
      error: "Database not configured",
    });
  });

  it("returns a sanitized internal failure for unexpected store errors", async () => {
    mockListTargets.mockRejectedValue(new Error("raw database detail"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: "Failed to list infrastructure targets.",
    });
    expect(JSON.stringify(body)).not.toContain("raw database detail");
  });
});
