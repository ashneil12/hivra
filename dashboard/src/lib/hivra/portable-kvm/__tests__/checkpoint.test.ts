const rpc = jest.fn();
const run = jest.fn();
const runWithStdin = jest.fn();
const resolve = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => rpc(...args) } }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => run(...args),
  runProxmoxHostScriptWithStdin: (...args: unknown[]) => runWithStdin(...args),
}));
jest.mock("../../agent-lifecycle-host", () => ({ resolveHivraLifecycleTarget: (...args: unknown[]) => resolve(...args) }));
jest.mock("../../computer-backups/sweep", () => ({ computerBackupPassword: () => "test-fixture-root" }));
jest.mock("@/lib/cold-storage-ssh", () => ({ buildColdStorageInstallScriptOrExit: () => "true" }));

import { advancePortableKvmSourceCheckpoint } from "../checkpoint";

const owner = "user_fixture";
const agentId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const source = { hostId: "qa-source", vmid: 9343, ip: "192.0.2.4", bindingTag: `hivra-bind-${"a".repeat(32)}` };
const destination = { ...source, hostId: "qa-destination", vmid: 9393, ip: "192.0.2.5" };
const agent = { id: agentId, user_id: owner, vmid: source.vmid, ip: source.ip, proxmox_host: source.hostId,
  infrastructure_binding_token_hash: "a".repeat(64), infrastructure_binding_token_enforced: true };
const configurationSha256 = "b".repeat(64);
const fence = { agentId, operationId, generation: 2, hostId: source.hostId, vmid: source.vmid,
  bindingTag: source.bindingTag, configurationSha256, state: "fenced" };
const saved = process.env;

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...saved, VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
    VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
    HIVRA_KVM_PORTABLE_QA_ENABLED: "true", HIVRA_KVM_PORTABLE_QA_OWNER_ID: owner, HIVRA_KVM_PORTABLE_QA_AGENT_ID: agentId,
    HIVRA_KVM_PORTABLE_QA_PLACEMENTS: JSON.stringify([source, destination].map(target => ({
      hostId: target.hostId, vmid: target.vmid, ip: target.ip,
    }))),
  };
  rpc.mockResolvedValue({ data: { agent_id: agentId, owner_id: owner, operation_id: operationId, generation: 2,
    phase: "checkpointing", expires_at: new Date(Date.now() + 60_000).toISOString(), source, destination }, error: null });
  resolve.mockResolvedValue({ ok: true, target: { executionContext: { kind: "managed", host: source.hostId },
    bindingTag: source.bindingTag, vmid: source.vmid, env: {} } });
});

afterEach(() => { process.env = saved; });

it("does not look up or mutate a checkpoint for a different owner or deployment", async () => {
  await expect(advancePortableKvmSourceCheckpoint("user_other", agent)).resolves.toBeNull();
  process.env.VERCEL_GIT_COMMIT_REF = "main";
  await expect(advancePortableKvmSourceCheckpoint(owner, agent)).resolves.toBeNull();
  expect(rpc).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("fails closed before SSH when the leased physical placement differs", async () => {
  await expect(advancePortableKvmSourceCheckpoint(owner, { ...agent, ip: "192.0.2.9" }))
    .rejects.toThrow("not on an exact configured placement");
  expect(run).not.toHaveBeenCalled();
});

it("accepts only the config and disk readback under the existing exact source fence", async () => {
  run.mockResolvedValueOnce({ ok: true, stdout: `HIVRA_KVM_PORTABLE_FENCE_V1 ${JSON.stringify(fence)}\n` })
    .mockResolvedValueOnce({ ok: true, stdout: `HIVRA_BACKUP_JOB ${operationId} ${JSON.stringify({
      job: operationId, state: "finished", status: "succeeded", reason: "portable_checkpointed",
      configuration: { sha256: configurationSha256, snapshotId: "c".repeat(64) },
      disks: [{ key: "scsi0", sha256: "d".repeat(64), bytes: 4096, snapshotId: "e".repeat(64) }],
    })}\n` });
  await expect(advancePortableKvmSourceCheckpoint(owner, agent)).resolves.toMatchObject({
    state: "checkpoint_verified", checkpointSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    configuration: { sha256: configurationSha256 }, disk: { key: "scsi0" },
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(runWithStdin).not.toHaveBeenCalled();
});
