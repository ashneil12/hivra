/** @jest-environment node */

// T33: an attached agent's contract shows "Delivered · checked by Hivra" only
// when root read AGENTS.md back on the computer and inside the unit's own mount
// namespace and found the same inode with the expected digest. The chain, from
// the guest to the database:
// - attached-agent.py's contract_readback: host and namespace inode and digest,
//   a root-owned 0444 file (scripts/test-attached-contract-readback.py, in a
//   privileged container; the VM matrix checks it in a real unit);
// - this test: the result line carries only { sha256, checked }, the worker
//   passes it to the database unchanged, and never marks anything delivered;
// - record_hivra_attachment_contract sets delivered_at only when checked is
//   true and the digest equals the file it rendered
//   (scripts/test-hivra-attachment-lifecycle.cjs).

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { parseAttachedAgentResult } from "../attached-agent-host";
import { createAttachmentLifecycleStore } from "../attachment-lifecycle-store";
import { progressAttachmentWork } from "../attachment-worker";

const ID = "00000000-0000-4100-8000-000000000001";
const INSTALLATION = "00000000-0000-4100-8000-000000000004";
const BOOT = "00000000-0000-4100-8000-000000000005";
const ACTIVATION = "00000000-0000-4100-8000-000000000007";
const DIGEST = "e".repeat(64);
const observation = { version: 1, state: "native_protocol_available", journalPhase: "service_started", operationId: ID,
  activationId: ACTIVATION, installationId: INSTALLATION, bootId: BOOT, serviceDefinitionSha256: "d".repeat(64), mainPid: 4242 };
const line = (value: unknown) => `HIVRA_ATTACHED_AGENT_V1 ${JSON.stringify(value)}\n`;

it("reads a read-back that says only its digest and whether root checked it", () => {
  expect(parseAttachedAgentResult("observe", line({ observation, contract: { sha256: DIGEST, checked: true } })))
    .toEqual({ observation, contract: { sha256: DIGEST, checked: true } });
  for (const contract of [
    { sha256: DIGEST, checked: true, delivered: true },
    { sha256: DIGEST, checked: "yes" },
    { sha256: "E".repeat(64), checked: true },
    { sha256: DIGEST },
  ]) expect(parseAttachedAgentResult("observe", line({ observation, contract }))).toBeNull();
});

it("never trusts a second result line, so program output can't add a read-back", () => {
  const good = line({ observation, contract: { sha256: DIGEST, checked: false } });
  expect(parseAttachedAgentResult("observe", good + good.replace("false", "true"))).toBeNull();
});

it("sends the guest's read-back to the database exactly as observed", async () => {
  const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
  const store = createAttachmentLifecycleStore({ rpc } as never);
  await store.recordContract({ ownerId: "owner", attachmentId: ID, revision: 1, content: "x", contentSha256: "a".repeat(64),
    fileSha256: DIGEST, grants: { workspace: true }, readback: { sha256: DIGEST, checked: false } });
  expect(rpc).toHaveBeenCalledWith("record_hivra_attachment_contract", expect.objectContaining({ p_file_sha256: DIGEST,
    p_readback: { sha256: DIGEST, checked: false } }));
});

it.each([
  ["an unchecked read-back", { sha256: DIGEST, checked: false }],
  ["no read-back (no unit process)", null],
])("the worker records %s as it is, and no delivery of its own", async (_label, readback) => {
  const recordContract = jest.fn().mockResolvedValue(true);
  const state = { version: 1, id: ID, ownerId: "owner", phase: "dispatched", sourceId: "00000000-0000-4100-8000-000000000002",
    computerId: "00000000-0000-4100-8000-000000000003", generation: "2", guestAuthority: {}, agentName: "Codex",
    grants: { workspace: true }, reviewSha256: null, dispatchId: null,
    installation: { installationId: INSTALLATION, bindingId: ID, architecture: "x86_64" }, bootId: BOOT,
    staged: { receipt: { uid: 61001, gid: 61001 } }, activation: { activationId: ACTIVATION, serviceDefinitionSha256: "d".repeat(64) },
    readyObservationId: null, contractRevision: 1, desiredState: "running", computerStatus: "running" };
  const store = { readState: jest.fn().mockResolvedValue(state), readInstanceToken: jest.fn().mockResolvedValue("a".repeat(64)), recordContract,
    recordObservation: jest.fn().mockResolvedValue(true), complete: jest.fn().mockResolvedValue(true) };
  const computer = { id: state.sourceId, user_id: "owner", name: "MY_UBUNTU_DESKTOP", type: "linux-desktop", cpu: 2, ram: 4, status: "running",
    vmid: 1201, ip: "192.0.2.10", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
    infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true };
  const execute = jest.fn().mockResolvedValue({ ok: true, result: { observation, contract: readback } });
  await progressAttachmentWork({ kind: "attach", ownerId: "owner", id: ID }, { store: store as never, loadComputer: jest.fn().mockResolvedValue(computer),
    execute, event: jest.fn(), uuid: () => ACTIVATION });
  if (readback) {
    expect(recordContract).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, readback }));
    expect(Object.keys(recordContract.mock.calls[0][0])).not.toContain("deliveredAt");
  } else {
    expect(recordContract).not.toHaveBeenCalled();
  }
});
