import { buildShutdownInstance } from "../orphan-instance-shutdown";
import { shutdownProxmoxInstance } from "@/lib/services/proxmox-instance-service";
import { getServer, shutdownServer, waitForAction } from "@/lib/hetzner/client";
import type { OrphanedInstanceRow } from "../orphaned-instances";
import type { SupabaseClient } from "@supabase/supabase-js";
jest.mock("@/lib/services/proxmox-instance-service", () => ({ shutdownProxmoxInstance: jest.fn() }));
jest.mock("@/lib/hetzner/client", () => ({ getServer: jest.fn(), shutdownServer: jest.fn(), waitForAction: jest.fn() }));
const row = { id: "instance-123", host_id: null, config: null, hetzner_server_id: 123 } as OrphanedInstanceRow;
const supabase = { from: jest.fn() } as unknown as SupabaseClient;
beforeEach(() => { jest.clearAllMocks(); });
it("disables Proxmox autostart while retaining the exact instance identity guard", async () => {
  (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });
  await buildShutdownInstance(supabase)({ ...row, hetzner_server_id: null, infrastructure_provider: "proxmox", proxmox_node: "fixturea", proxmox_vmid: 123 });
  expect(shutdownProxmoxInstance).toHaveBeenCalledWith(expect.objectContaining({ vmid: 123 }), expect.objectContaining({ expectedInstanceId: row.id, setOnboot: 0 }));
});
it("refuses a successful Hetzner action when the server is still running", async () => {
  (getServer as jest.Mock).mockResolvedValue({ server: { status: "running" } });
  (shutdownServer as jest.Mock).mockResolvedValue({ action: { id: 456 } });
  (waitForAction as jest.Mock).mockResolvedValue(undefined);
  const result = await buildShutdownInstance(supabase)(row);
  expect(result.ok).toBe(false);
  expect(waitForAction).toHaveBeenCalledWith(456, 30_000);
});
it("acknowledges Hetzner shutdown only after observing off", async () => {
  (getServer as jest.Mock).mockResolvedValueOnce({ server: { status: "running" } }).mockResolvedValueOnce({ server: { status: "off" } });
  (shutdownServer as jest.Mock).mockResolvedValue({ action: { id: 456 } });
  (waitForAction as jest.Mock).mockResolvedValue(undefined);
  await expect(buildShutdownInstance(supabase)(row)).resolves.toEqual({ ok: true });
});
it("repeated delivery accepts an already off server without another action", async () => {
  (getServer as jest.Mock).mockResolvedValue({ server: { status: "off" } });
  await expect(buildShutdownInstance(supabase)(row)).resolves.toEqual({ ok: true });
  expect(shutdownServer).not.toHaveBeenCalled();
});
it("preserves a shared host with another live tenant", async () => {
  const chain: Record<string, unknown> = {};
  chain.eq = jest.fn(() => chain); chain.neq = jest.fn(() => chain);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ count: 1, error: null }));
  (supabase.from as jest.Mock).mockReturnValue({ select: jest.fn(() => chain) });
  const result = await buildShutdownInstance(supabase)({ ...row, host_id: "shared-host" });
  expect(result).toMatchObject({ ok: false, skipped: true });
  expect(shutdownServer).not.toHaveBeenCalled();
});
