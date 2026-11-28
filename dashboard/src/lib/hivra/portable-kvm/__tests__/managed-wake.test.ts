import { createHash, createHmac } from "node:crypto";
import { BACKUP_START_PREFIX } from "../../computer-backups/scripts";
import { shellQuote } from "../../proxmox-target";
import type { PortableKvmDestinationBootProfile } from "../destination-boot";
import {
  buildPortableKvmDestinationDiskScript, serializePortableKvmDestinationReservation, type PortableKvmDestinationReservation,
} from "../destination-disk";
import type { PortableKvmDestinationPrepareInput } from "../destination-prepare";
import type { PortableKvmHandoff } from "../handoff";
import { requestManagedPortableKvmOwnerWake, resumeManagedPortableKvmOwnerWake } from "../managed-wake";

const rpc = jest.fn();
const from = jest.fn();
const run = jest.fn();
const runWithStdin = jest.fn();
const resolveTarget = jest.fn();
const connectors = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => rpc(...args), from: (...args: unknown[]) => from(...args),
} }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => run(...args),
  runProxmoxHostScriptWithStdin: (...args: unknown[]) => runWithStdin(...args),
}));
jest.mock("@/lib/services/cloudflare-tunnel", () => ({
  getTunnelConfig: () => ({}), listTunnelConnections: (...args: unknown[]) => connectors(...args),
}));
jest.mock("../../agent-lifecycle-host", () => ({ resolveHivraLifecycleTarget: (...args: unknown[]) => resolveTarget(...args) }));
jest.mock("../../lapse-gate", () => ({ isStartBlockedForLapse: async () => false }));
jest.mock("../../computer-backups/sweep", () => ({ computerBackupPassword: () => "offline-fixture-root" }));
jest.mock("@/lib/cold-storage-ssh", () => ({ buildColdStorageInstallScriptOrExit: () => "true" }));

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ok = (stdout: string) => ({ ok: true, stdout });
const wire = (prefix: string, data: unknown) => ok(prefix + " " + JSON.stringify(data) + "\n");
const owner = "user_fixture";
const agentId = "11111111-1111-4111-8111-111111111111";
const allocationOperationId = "55555555-5555-4555-8555-555555555555";
const bootId = "22222222-2222-4222-8222-222222222222";
const connectorId = "33333333-3333-4333-8333-333333333333";
const poolId = "44444444-4444-4444-8444-444444444444";
const bindingTag = "hivra-bind-" + "a".repeat(32);
const source = { hostId: "qa-source", vmid: 9343, ip: "10.251.10.44", bindingTag };
const destination = { ...source, hostId: "qa-destination", vmid: 9344 };
const cpu = { vendor: "AuthenticAMD", requiredFlags: ["aes", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] };
const storage = { storageId: "local-lvm", volumeGroup: "pve", thinPool: "data", bridge: "hivra0" };
const configuration = { sha256: sha("current configuration"), snapshotId: sha("configuration snapshot") };
const rawConfigurationSha256 = sha("raw configuration");
const disk = { key: "scsi0" as const, sha256: sha("scsi0 contents"), snapshotId: sha("scsi0 snapshot"), bytes: 1024 ** 3 };
const originalEnv = process.env;

afterEach(() => { process.env = originalEnv; });

it("carries the paid idle checkpoint into the verified destination only after the owner requests wake", async () => {
  process.env = { ...originalEnv, VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
    VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra" };
  const pilot = { ownerId: owner, agentId, placements: [source, destination], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    profile: { machine: "pc-i440fx-9.2", machineId: "d".repeat(32), macAddress: "BC:24:11:12:34:56",
      attachment: { discard: true, ssd: false, ioThread: true }, hosts: { [source.hostId]: storage, [destination.hostId]: storage },
      managed: { cpu, cpuLimit: 1.5, cloudInit: { instanceId: "e".repeat(40), gateway: "10.251.10.1", nameservers: ["10.251.10.1"] } },
    },
  };
  const row = { id: agentId, user_id: owner, proxmox_host: source.hostId, vmid: source.vmid, ip: source.ip,
    infrastructure_binding_token_hash: "a".repeat(64), infrastructure_binding_token_enforced: true,
    seat_funding: "paid", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
    status: "running", desired_state: "running", sleep_policy: "full", always_on: false,
    sleep_tier_changed_at: "2026-11-27T18:00:00.000Z", sleep_memory_dropped_at: "2026-11-27T18:01:00.000Z",
    sleep_generation: 3, sleep_state: "hibernated", operation_id: null as string | null,
    operation_kind: null as string | null, operation_payload: null as { portable_kvm: true } | null,
    pool_id: poolId, cpu: 2, cpu_max: 1.5, ram: 3, ram_max: 3, allocation_operation_id: allocationOperationId, cf_tunnel_id: connectorId,
  };
  let lease: PortableKvmHandoff;
  let prepared: PortableKvmDestinationReservation | undefined;
  let checkpointDispatched = false;
  let restoreDispatched = false;
  let connectorEnabled = false;
  const events: string[] = [];
  const resources = { balloonMb: 3072, cpuUnits: 200 };
  const expectedManaged = { ...pilot.profile.managed, allocationOperationId, resources };
  const fence = () => ({ agentId, operationId: lease.operation_id, generation: lease.generation, hostId: source.hostId,
    vmid: source.vmid, bindingTag, configurationSha256: configuration.sha256, rawConfigurationSha256, state: "fenced" });
  const expectedCheckpoint = () => sha(JSON.stringify({ fence: fence(), configuration, disk }));
  const reservationWire = () => serializePortableKvmDestinationReservation(prepared!);
  const job = (state: string, receipt?: string) => wire("HIVRA_KVM_PORTABLE_DESTINATION_JOB_V1", {
    state, operationId: lease.operation_id, reservationSha256: sha(reservationWire()), receipt,
  });

  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      maybeSingle: async () => {
        if (table === "pools") {
          expect(filters).toEqual({ id: poolId });
          return { data: { priority: 2 }, error: null };
        }
        expect(table).toBe("hivra_agents");
        expect(filters).toEqual({ id: agentId, user_id: owner });
        return { data: { ...row }, error: null };
      },
    };
    return query;
  });
  rpc.mockImplementation(async (name: string, p: Record<string, unknown>) => {
    if (name === "read_hivra_kvm_portable_pilot") return { data: pilot };
    expect(p).toMatchObject({ p_owner_id: owner, p_agent_id: agentId });
    if (name === "read_hivra_kvm_portable_handoff") return { data: lease };
    if (name === "check_hivra_kvm_portable_host") {
      expect([source, destination]).toContainEqual(p.p_placement);
      return { data: true };
    }
    if (name === "begin_hivra_kvm_portable_handoff") {
      expect(p).toMatchObject({ p_expected_generation: 3, p_source: source, p_destination: destination });
      lease = { owner_id: owner, agent_id: agentId, operation_id: String(p.p_operation_id), generation: 4, source, destination,
        expires_at: String(p.p_expires_at), wake_requested_at: null, phase: "checkpointing", checkpoint_sha256: null, storage_evidence: null };
      Object.assign(row, { sleep_generation: 4, sleep_state: "waking", operation_id: lease.operation_id, operation_kind: "wake",
        operation_payload: { portable_kvm: true } });
      events.push("begin");
      return { data: lease };
    }
    expect(p).toMatchObject({ p_operation_id: lease.operation_id, p_generation: lease.generation });
    if (name === "request_hivra_kvm_portable_wake") {
      events.push("owner request");
      lease.wake_requested_at = new Date().toISOString();
      return { data: lease };
    }
    expect(name).toBe("advance_hivra_kvm_portable_handoff");
    events.push(String(p.p_action));
    switch (p.p_action) {
      case "verify_storage": {
        expect(p.p_evidence).toMatchObject({ source, sourceFenced: true, storageReadbackVerified: true,
          checkpointSha256: expectedCheckpoint(), configuration, disk });
        const proof = p.p_evidence as NonNullable<PortableKvmHandoff["storage_evidence"]> & { checkpointSha256: string };
        Object.assign(lease, { phase: "storage_verified", checkpoint_sha256: proof.checkpointSha256,
          storage_evidence: { configuration: proof.configuration, disk: proof.disk } });
        break;
      }
      case "claim_restore":
        expect(lease.wake_requested_at).not.toBeNull();
        lease.phase = "restore_claimed";
        break;
      case "verify_destination":
        expect(p.p_evidence).toEqual({ destination, checkpointSha256: expectedCheckpoint(), coldBootVerified: true,
          destinationConnectorBlocked: true, bootId, reservationSha256: sha(reservationWire()) });
        Object.assign(lease, { phase: "destination_verified", destination_evidence: p.p_evidence });
        break;
      case "commit_placement":
        lease.phase = "placement_committed";
        Object.assign(row, { proxmox_host: destination.hostId, vmid: destination.vmid });
        break;
      case "confirm_connector":
        expect(p.p_evidence).toMatchObject({ bootId, connectorId, destinationConnectorReady: true });
        Object.assign(lease, { phase: "connector_verified", connector_evidence: p.p_evidence });
        break;
      case "finish_wake":
        expect(p.p_evidence).toMatchObject({ bootId, connectorId, destinationLockReleased: true });
        lease.phase = "finished";
        Object.assign(row, { sleep_state: "awake", operation_id: null, operation_kind: null, operation_payload: null });
        break;
      default: throw new Error("Unexpected journal action");
    }
    return { data: lease };
  });
  resolveTarget.mockImplementation(async ({ agent }: { agent: typeof row }) => ({ ok: true, target: {
    executionContext: { kind: "managed", host: agent.proxmox_host }, vmid: agent.vmid, bindingTag,
    subnetPrefix: "10.251.10", octet: 44, env: { host: agent.proxmox_host },
  } }));
  connectors.mockImplementation(async () => connectorEnabled ? [{ clientId: connectorId, connections: 1 }] : []);
  run.mockImplementation(async (script: string, { host }: { host: string }) => {
    if (script.includes("wrong_cpu_probe_host")) return ok(JSON.stringify(cpu));
    if (script.includes("HIVRA_KVM_PORTABLE_SOURCE_PROFILE_V1")) {
      expect(host).toBe(source.hostId);
      events.push("source preflight");
      return ok("HIVRA_KVM_PORTABLE_SOURCE_PROFILE_V1 eligible");
    }
    if (script.includes("HIVRA_PORTABLE_SLOT_V1")) {
      expect(host).toBe(destination.hostId);
      events.push("destination preflight");
      return ok("HIVRA_PORTABLE_SLOT_V1 verify");
    }
    if (script.includes("HIVRA_KVM_PORTABLE_FENCE_V1")) return wire("HIVRA_KVM_PORTABLE_FENCE_V1", fence());
    if (script.includes("HIVRA_BACKUP_JOB")) {
      const prefix = "HIVRA_BACKUP_JOB " + lease.operation_id;
      return checkpointDispatched ? wire(prefix, { job: lease.operation_id, status: "succeeded",
        reason: "portable_checkpointed", rawConfigurationSha256, configuration, disks: [disk] }) : ok(prefix + " missing\n");
    }
    expect(host).toBe(destination.hostId);
    expect(lease.wake_requested_at).not.toBeNull();
    if (script.startsWith("set -eu\n")) return prepared ? wire("HIVRA_KVM_PORTABLE_PREPARE_V1", prepared) : { ok: false, stdout: "" };
    if (script.includes("HIVRA_KVM_PORTABLE_PREPARE_V1")) {
      events.push("prepare");
      const plan: PortableKvmDestinationPrepareInput = JSON.parse(script.match(/'(\{"agentId":[^']+\n)'/)![1]);
      expect(plan).toMatchObject({ hostId: destination.hostId, vmid: destination.vmid, bindingTag,
        checkpointSha256: expectedCheckpoint(), disk, abortScope: { ownerId: owner },
        profile: { cores: 2, memoryMb: 3072, managed: expectedManaged } });
      prepared = { agentId, operationId: lease.operation_id, generation: lease.generation,
        checkpointSha256: lease.checkpoint_sha256!, hostId: destination.hostId, vmid: destination.vmid, bindingTag,
        configurationSha256: sha("destination current"), rawConfigurationSha256: sha("destination raw"),
        storageId: storage.storageId, volumeName: "vm-9344-disk-0", volumeGroup: storage.volumeGroup,
        deviceMapperUuid: "LVM-" + "X".repeat(64), disk, resources };
      return wire("HIVRA_KVM_PORTABLE_PREPARE_V1", prepared);
    }
    if (script.includes("HIVRA_KVM_PORTABLE_DESTINATION_JOB_V1")) {
      expect(script).toContain(shellQuote(reservationWire()));
      return restoreDispatched ? job("succeeded", wire("HIVRA_KVM_PORTABLE_DESTINATION_V1", {
        state: "disk_restored_verified", reservation: prepared, readback: { bytes: disk.bytes, sha256: disk.sha256 },
      }).stdout) : job("missing");
    }
    const [, profileWire, mode] = script.match(/'(\{"reservation":[^']+\n)' '\{"agentId":[^']+\n' '(boot|verify|enable|release)'/)!;
    const profile: PortableKvmDestinationBootProfile = JSON.parse(profileWire);
    expect(profile).toEqual({ reservation: prepared, ip: destination.ip, machineId: pilot.profile.machineId, managed: expectedManaged });
    events.push(mode);
    if (mode === "enable") connectorEnabled = true;
    return wire("HIVRA_KVM_PORTABLE_BOOT_V1", { state: mode === "enable" ? "destination_network_enabled"
      : mode === "release" ? "destination_lock_released" : "destination_quarantined",
      profileSha256: sha(profileWire), bootId, ...(connectorEnabled ? { connectorId } : {}) });
  });
  runWithStdin.mockImplementation(async (script: string, stdin: string, { host }: { host: string }) => {
    expect(stdin).toBe(createHmac("sha256", "offline-fixture-root").update("hivra-kvm-portable-v1:" + lease.operation_id).digest("hex") + "\n");
    if (host === source.hostId) {
      events.push("checkpoint");
      expect(script).toContain(configuration.sha256);
      expect(script).toContain(rawConfigurationSha256);
      checkpointDispatched = true;
      return wire(BACKUP_START_PREFIX.trimEnd(), { ok: true, reason: "started", job: lease.operation_id });
    }
    expect(host).toBe(destination.hostId);
    expect(lease.wake_requested_at).not.toBeNull();
    expect(script).toContain(shellQuote(reservationWire()));
    expect(script).toContain(shellQuote(buildPortableKvmDestinationDiskScript(prepared!)));
    events.push("restore");
    restoreDispatched = true;
    return job("running");
  });

  row.seat_funding = "free";
  await resumeManagedPortableKvmOwnerWake();
  expect(run).not.toHaveBeenCalled();
  row.seat_funding = "paid";

  await resumeManagedPortableKvmOwnerWake();
  await resumeManagedPortableKvmOwnerWake();
  await resumeManagedPortableKvmOwnerWake({ ownerId: owner });
  await expect(requestManagedPortableKvmOwnerWake("user_other", row)).resolves.toBeNull();
  const idleStages = ["source preflight", "destination preflight", "begin", "checkpoint", "verify_storage"];
  expect(events).toEqual(idleStages);
  expect(lease!).toMatchObject({ phase: "storage_verified", wake_requested_at: null, checkpoint_sha256: expectedCheckpoint() });
  expect(prepared).toBeUndefined();

  await expect(requestManagedPortableKvmOwnerWake(owner, row)).resolves.toMatchObject({ state: "waking" });
  for (let step = 0; step < 3; step++) await resumeManagedPortableKvmOwnerWake({ ownerId: owner });
  expect(events).toEqual([...idleStages, "owner request", "claim_restore", "prepare", "restore",
    "boot", "verify_destination", "verify", "commit_placement", "enable", "confirm_connector", "release", "finish_wake"]);
  expect(lease!).toMatchObject({ phase: "finished", destination, checkpoint_sha256: prepared?.checkpointSha256 });
  expect(row).toMatchObject({ proxmox_host: destination.hostId, vmid: destination.vmid, sleep_state: "awake" });
});
