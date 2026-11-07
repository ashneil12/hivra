import type { SupabaseClient } from "@supabase/supabase-js";
import { blocksInstanceLiveMutation, readInstanceLiveMutationBlock } from "../instance-live-mutation";

function db(data: unknown, error: unknown = null) {
  return { from: jest.fn(() => ({ select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(async () => ({ data, error })) })) })) })) } as unknown as SupabaseClient;
}

describe("live mutation lifecycle authority", () => {
  it.each(["cold_archived", "pending_deletion", "archiving", "restoring", "deleting", "deleted"])(
    "blocks %s even when legacy status still says running", async (lifecycle_state) => {
      expect(await readInstanceLiveMutationBlock(db({ lifecycle_state, status: "running" }), "i1")).toBeTruthy();
    },
  );
  it("blocks a failed computer with an archive and no live VM", () => {
    expect(blocksInstanceLiveMutation({ lifecycle_state: "failed", archive_uri: "free/i/data", archive_sha256: "sha", proxmox_vmid: null })).toBe(true);
  });
  it("permits a restored/live computer even when archive retention metadata remains", async () => {
    expect(await readInstanceLiveMutationBlock(db({ lifecycle_state: "active", proxmox_vmid: 201, archive_uri: "free/i/data", archive_sha256: "sha" }), "i1")).toBeNull();
  });
  it("permits recovery of a failed computer that still owns a VM", () => {
    expect(blocksInstanceLiveMutation({ lifecycle_state: "failed", archive_uri: "free/i/data", archive_sha256: "sha", proxmox_vmid: 201 })).toBe(false);
  });
  it.each([
    { proxmox_vmid: 202 },
    { proxmox_node: "new-host" },
    { ipv4_address: "10.250.0.2" },
    { config: { infrastructure: { provider: "proxmox", vmid: 202, node: "old-host", hostSlug: "old-host", privateIpv4: "10.250.0.1" } } },
    { config: { infrastructure: { provider: "proxmox", vmid: 201, node: "new-host", hostSlug: "new-host", privateIpv4: "10.250.0.1" } } },
    { config: { infrastructure: { provider: "proxmox", vmid: 201, node: "old-host", hostSlug: "old-host", privateIpv4: "10.250.0.2" } } },
  ])("refuses an active computer whose coordinates changed after its snapshot: %j", async (change) => {
    const expected = {
      proxmox_vmid: 201, proxmox_node: "old-host", ipv4_address: "10.250.0.1",
      config: { infrastructure: { provider: "proxmox", vmid: 201, node: "old-host", hostSlug: "old-host", privateIpv4: "10.250.0.1" } },
    };
    const current = { ...expected, lifecycle_state: "active", status: "running", ...change };
    expect(await readInstanceLiveMutationBlock(db(current), "i1", expected)).toMatch(/moved or was restored/);
  });
  it("allows matching live coordinates after a fresh read", async () => {
    const coordinates = { proxmox_vmid: 201, config: { infrastructure: { provider: "proxmox", vmid: 201, node: "host-a", privateIpv4: "10.250.0.1" } } };
    expect(await readInstanceLiveMutationBlock(db({ ...coordinates, lifecycle_state: "active" }), "i1", coordinates)).toBeNull();
  });
  it.each([[null, null], [null, { message: "offline" }]])("fails closed when lifecycle cannot be read", async (data, error) => {
    expect(await readInstanceLiveMutationBlock(db(data, error), "i1")).toMatch(/Could not confirm/);
  });
  it("fails closed when the lifecycle query throws", async () => {
    const broken = { from: () => { throw new Error("offline"); } } as unknown as SupabaseClient;
    expect(await readInstanceLiveMutationBlock(broken, "i1")).toMatch(/Could not confirm/);
  });
});
