import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  GvisorComputerReceiptSchema,
  GvisorComputerRequestSchema,
  HIVRA_GVISOR_BUNDLE_SHA256,
  HIVRA_GVISOR_BUNDLE_URL,
  HIVRA_GVISOR_IMAGE,
  isGvisorPendingBoundObservation,
  isGvisorPreflightFresh,
} from "../gvisor-computer-contract";

const ownerHash = "a".repeat(64);
const computerId = "11111111-1111-4111-8111-111111111111";
const sandboxId = "22222222-2222-4222-8222-222222222222";

describe("gVisor Computer contract", () => {
  it("requires full enforced limits for create and a host reserve before start", () => {
    expect(GvisorComputerRequestSchema.safeParse({ operation: "create", ownerHash, computerId, sandboxId,
      cpu: 1, memoryMb: 1024, hostMemoryReserveMb: 2048 }).success).toBe(true);
    expect(GvisorComputerRequestSchema.safeParse({ operation: "create", ownerHash, computerId, sandboxId,
      cpu: 1, memoryMb: 1024 }).success).toBe(false);
    expect(GvisorComputerRequestSchema.safeParse({ operation: "start", ownerHash, computerId, sandboxId }).success).toBe(false);
  });

  it("rejects incomplete running evidence but accepts an exact absence receipt", () => {
    expect(GvisorComputerReceiptSchema.safeParse({ version: 1, computerId, sandboxId, state: "running" }).success).toBe(false);
    expect(GvisorComputerReceiptSchema.safeParse({ version: 1, computerId, sandboxId, state: "absent" }).success).toBe(true);
  });

  it("uses freshness only for new admission evidence", () => {
    const now = Date.parse("2026-09-15T12:30:00.000Z");
    expect(isGvisorPreflightFresh("2026-09-15T12:20:00.000Z", now)).toBe(true);
    expect(isGvisorPreflightFresh("2026-09-15T12:00:00.000Z", now)).toBe(false);
    expect(isGvisorPreflightFresh("2026-09-15T12:31:00.000Z", now)).toBe(false);
  });

  it("allows only status and delete across the exact pending policy rebind", () => {
    const exact = { connectionStatus: "pending", connectionRevision: 8,
      pendingFromRevision: 7, bindingRevision: 7, targetRevision: 7 };
    expect(isGvisorPendingBoundObservation({ ...exact, operation: "status" })).toBe(true);
    expect(isGvisorPendingBoundObservation({ ...exact, operation: "delete" })).toBe(true);
    expect(isGvisorPendingBoundObservation({ ...exact, operation: "exec" })).toBe(false);
    expect(isGvisorPendingBoundObservation({ ...exact, operation: "delete", targetRevision: 6 })).toBe(false);
    expect(isGvisorPendingBoundObservation({ ...exact, operation: "delete", connectionRevision: 9 })).toBe(false);
  });

  it("keeps the provisioner pinned and excludes host authority surfaces", () => {
    const root = path.join(process.cwd(), "provisioner", "gvisor");
    const adapter = readFileSync(path.join(root, "hivra-gvisor-adapter.py"), "utf8");
    const prepare = readFileSync(path.join(root, "prepare-gvisor-host.sh"), "utf8");
    expect(prepare).toContain(HIVRA_GVISOR_BUNDLE_URL);
    expect(prepare).toContain(HIVRA_GVISOR_BUNDLE_SHA256);
    expect(prepare).toContain("systemctl reload docker");
    expect(prepare).not.toContain("systemctl restart docker");
    expect(prepare).toContain("HIVRA_GVISOR_PREPARE_FAILED_V1");
    expect(prepare).toContain("for _attempt in {1..30}");
    expect(prepare).toContain("registered_runsc=\"$(docker info");
    expect(prepare).not.toContain("docker info --format '{{json .Runtimes}}' | grep -q");
    expect(prepare).toContain("command -v python3");
    expect(prepare).toContain("command -v bzip2");
    expect(prepare).toContain("apt-get install -y --no-install-recommends docker.io python3 ca-certificates curl bzip2");
    expect(prepare).toContain('command -v runsc');
    expect(prepare).toContain('configured_runsc="$(docker info');
    expect(prepare).toContain('sha256sum "$tmp_dir/gvisor-bin/$sidecar"');
    expect(prepare).toContain("/usr/local/bin/gvisor-bin/$sidecar");
    for (const sidecar of ["checkpointgofer", "gvisor-sentry-prewarmer", "gvisor_sentry", "runsc-metric-server"]) {
      expect(prepare).toContain(sidecar);
    }
    expect(adapter).toContain(HIVRA_GVISOR_IMAGE);
    expect(adapter).toContain('"--cap-drop=ALL"');
    expect(adapter).toContain('"--read-only"');
    expect(adapter).not.toContain("/var/run/docker.sock");
    expect(adapter).not.toContain("--privileged");
    expect(adapter).not.toContain("--network=host");
    const nextConfig = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
    expect(nextConfig).toContain('"/api/infrastructure/connections/*/gvisor/prepare"');
    expect(nextConfig).toContain('"/api/infrastructure/connections/*/gvisor/preflight"');
  });

  it("keeps recovery, deletion, and preparation on the canonical fenced lifecycle", () => {
    const service = readFileSync(path.join(process.cwd(), "src/lib/hivra/gvisor-computer-service.ts"), "utf8");
    const target = readFileSync(path.join(process.cwd(), "src/lib/infrastructure/gvisor-target.ts"), "utf8");
    expect(service).toContain('receipt.state === "stopped"');
    expect(service).toContain('input.action === "delete" && agent.operation_kind === "provision"');
    expect(service).toContain("beginInfrastructureConnectionPreparation");
    expect(service).toContain("infrastructure_connection_id: null, deployment_target_id: null");
    expect(service).toContain("HIVRA_GVISOR_IDENTITY_MISMATCH");
    expect(service).toContain("sha256sum /usr/local/bin/runsc");
    expect(service).toContain("sha256sum -c /opt/hivra/gvisor-adapter/gvisor-bin.sha256");
    expect(target).toContain("beginInfrastructureConnectionPreflight");
    expect(target).toContain("p_run_id: runId");
  });

  it("passes the executable adapter process and lifecycle boundaries", () => {
    const testPath = path.join(process.cwd(), "provisioner", "gvisor", "test_hivra_gvisor_adapter.py");
    const python = process.env.HIVRA_ADAPTER_TEST_PYTHON
      ?? (process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "python3");
    const result = spawnSync(python, ["-m", "unittest", testPath, "-v"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
