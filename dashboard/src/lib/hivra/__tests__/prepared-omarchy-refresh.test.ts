import { advancePreparedOmarchyRefresh, cancelPreparedOmarchyRefresh, preparedRefreshAuthority } from "../prepared-omarchy-refresh";
import { type OmarchyRefreshRequest, type OmarchyRefreshReceipt, OmarchyRefreshReceiptSchema, PREPARED_OMARCHY_REFRESH_MARKER, PREPARED_OMARCHY_REFRESH_STAGE } from "../prepared-omarchy-refresh-contract";

const operation = "018f6d3c-1d91-7c65-9d86-37fc915b8377";
const release = { release: "v4.0.6", releaseCommit: "a".repeat(40), isoFilename: "omarchy-4.0.6.iso", isoUrl: "https://iso.omarchy.org/omarchy-4.0.6.iso", isoSha256: "b".repeat(64) };
const slot = { host: "node-b", node: "node-b", vmid: 2099, ip: "10.240.20.99", claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1" };
const base = { id: "44444444-4444-4444-8444-444444444444", user_id: "owner", computer_profile: "omarchy" as const,
  proxmox_host: "node-b", vmid: 2099, ip: slot.ip, computer_substrate: "proxmox-kvm", type: "linux-desktop", deployment_mode: "hivra-managed",
  managed_provisioner_channel: "canary", chat_url: null, allocation_operation_id: operation, operation_id: operation, operation_kind: "provision",
  operation_payload: { stage: PREPARED_OMARCHY_REFRESH_STAGE, refreshId: operation }, desired_state: "running", status: "provisioning",
  infrastructure_binding_token_hash: "c".repeat(64), infrastructure_binding_token_enforced: true };
const observed = { packageVersion: "4.0.6-1", osVersion: "4.0.6", kernelRelease: "7.2.15-1-omarchy", selectedKernel: "7.2.15-1-omarchy",
  bootIdBefore: "33333333-3333-4333-8333-333333333333", bootIdAfter: "55555555-5555-4555-8555-555555555555", desktopReady: true, migrationsComplete: true, observedAt: "2026-11-03T01:00:00Z" };
const complete = { version: 1, operationId: operation, computerId: base.id, vmid: slot.vmid, bindingTag: "hivra-bind-" + "c".repeat(32),
  requestedRelease: release, guestUpdaterStopped: true, state: "complete", observed };
const marker = (value: unknown) => PREPARED_OMARCHY_REFRESH_MARKER + JSON.stringify(value) + "\n";
function fixture() {
  let row: Omit<typeof base, "operation_id"> & { operation_id: string | null } = { ...base };
  const job = { id: operation, agent_id: row.id, user_id: row.user_id, authority: preparedRefreshAuthority(row), requested_release: release, slot, phase: "reserved", terminal_receipt: null };
  const deps = {
    loadJob: jest.fn(async () => job), reload: jest.fn(async (): Promise<typeof row | null> => row),
    ensureBinding: jest.fn(async () => (row = { ...row, infrastructure_binding_token_enforced: true })),
    dispatch: jest.fn(async () => true),
    cancel: jest.fn(async () => { row = { ...row, desired_state: "deleted" }; return true; }),
    finish: jest.fn(async (_owner: string, _op: string, receipt: unknown) => { const value = receipt as typeof complete; row = { ...row, status: value.state === "complete" ? "running" : "deleted", operation_id: null }; return true; }),
    host: jest.fn(async (_request: OmarchyRefreshRequest, _cancel: boolean) => { void _request; void _cancel; return marker({ state: "running", phase: "updating" }); }),
  };
  return { deps, job, get row() { return row; }, setRow: (value: Partial<typeof row>) => { row = { ...row, ...value }; } };
}

it("returns the real pending owner row while the durable host updater runs", async () => {
  const f = fixture(); const result = await advancePreparedOmarchyRefresh("owner", f.row, f.deps);
  expect(result.status).toBe("provisioning"); expect(result.prepared_update_stage).toBe("updating");
  expect(f.deps.finish).not.toHaveBeenCalled();
  expect(f.deps.host).toHaveBeenCalledWith(expect.objectContaining({ operationId: operation, release }), false);
});

it("admits the owner only after exact release, changed boot, selected kernel, migrations and desktop receipt", async () => {
  const f = fixture(); f.deps.host.mockResolvedValue(marker({ state: "terminal", receipt: complete }));
  const result = await advancePreparedOmarchyRefresh("owner", f.row, f.deps);
  expect(result.status).toBe("running"); expect(f.deps.finish).toHaveBeenCalledWith("owner", operation, complete);
});

it.each([
  { ...complete, observed: { ...observed, packageVersion: "4.0.2-1", osVersion: "4.0.2" } },
  { ...complete, observed: { ...observed, bootIdAfter: observed.bootIdBefore } },
  { ...complete, observed: { ...observed, kernelRelease: "7.2.8-9-omarchy" } },
  { ...complete, observed: { ...observed, migrationsComplete: false } },
  { ...complete, observed: { ...observed, desktopReady: false } },
  { ...complete, guestUpdaterStopped: false },
])("rejects stale or incomplete terminal evidence before completion", async receipt => {
  const f = fixture(); f.deps.host.mockResolvedValue(marker({ state: "terminal", receipt }));
  await expect(advancePreparedOmarchyRefresh("owner", f.row, f.deps)).rejects.toThrow();
  expect(f.deps.finish).not.toHaveBeenCalled();
});

it("rejects a valid receipt replayed from another reservation", async () => {
  const f = fixture(); f.deps.host.mockResolvedValue(marker({ state: "terminal", receipt: { ...complete, computerId: "66666666-6666-4666-8666-666666666666" } }));
  await expect(advancePreparedOmarchyRefresh("owner", f.row, f.deps)).rejects.toThrow("prepared_refresh_receipt_mismatch");
  expect(f.deps.finish).not.toHaveBeenCalled();
});

it("serializes retries into the same immutable operation rather than selecting a new release", async () => {
  const f = fixture();
  await advancePreparedOmarchyRefresh("owner", f.row, f.deps);
  await advancePreparedOmarchyRefresh("owner", f.row, f.deps);
  expect(f.deps.host.mock.calls.map(([request]) => request.operationId)).toEqual([operation, operation]);
});

it("does not dispatch after its row disappears or authority changes", async () => {
  const f = fixture(); f.deps.reload.mockResolvedValue(null);
  await expect(advancePreparedOmarchyRefresh("owner", f.row, f.deps)).rejects.toThrow("prepared_refresh_authority_changed");
  expect(f.deps.host).not.toHaveBeenCalled();
});

it("retains a failed reservation without blindly running its updater again", async () => {
  const f = fixture(); f.job.phase = "failed"; f.setRow({ status: "error" });
  const result = await advancePreparedOmarchyRefresh("owner", f.row, f.deps);
  expect(result.status).toBe("error"); expect(f.deps.host).not.toHaveBeenCalled();
});

it("records cancellation before asking the host to fence the same updater", async () => {
  const f = fixture();
  const result = await cancelPreparedOmarchyRefresh("owner", f.row, f.deps);
  expect(result.desired_state).toBe("deleted"); expect(result.status).toBe("provisioning");
  expect(f.deps.host).toHaveBeenCalledWith(expect.objectContaining({ operationId: operation }), true);
  expect(f.deps.finish).not.toHaveBeenCalled();
});

it("releases a cancelled reservation only with stopped-updater and released-binding proof", async () => {
  const f = fixture(); const { observed: _observed, ...receiptBase } = complete; void _observed;
  const receipt: OmarchyRefreshReceipt = { ...receiptBase, version: 1, state: "cancelled", guestUpdaterStopped: true, bindingReleased: true };
  f.deps.host.mockResolvedValue(marker({ state: "terminal", receipt }));
  expect((await cancelPreparedOmarchyRefresh("owner", f.row, f.deps)).status).toBe("deleted");
  expect(f.deps.finish).toHaveBeenCalledWith("owner", operation, receipt);
  expect(() => OmarchyRefreshReceiptSchema.parse({ ...receipt, bindingReleased: false })).toThrow();
});
