import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isHetznerCreationReceipt,
  provisionedHetznerServerId,
  recordHetznerCreationReceipt,
} from "../creation-receipt";

const GATEWAY = "https://agent-1.example.com";

describe("provisionedHetznerServerId", () => {
  it("returns the server id once the provisioning metadata has landed", () => {
    expect(
      provisionedHetznerServerId({ hetzner_server_id: 42, status: "provisioning", gateway_url: GATEWAY })
    ).toBe(42);
  });

  it("treats a provisioning row with a server id and no gateway as a creation receipt", () => {
    const receipt = { hetzner_server_id: 42, status: "provisioning", gateway_url: null };
    expect(isHetznerCreationReceipt(receipt)).toBe(true);
    expect(provisionedHetznerServerId(receipt)).toBeNull();
    expect(provisionedHetznerServerId({ hetzner_server_id: 42, status: "provisioning" })).toBeNull();
  });

  it("keeps a running row's server id live even without a gateway (existing rows are unchanged)", () => {
    const running = { hetzner_server_id: 42, status: "running", gateway_url: null };
    expect(isHetznerCreationReceipt(running)).toBe(false);
    expect(provisionedHetznerServerId(running)).toBe(42);
  });

  it("keeps a rollback-marker row's server id visible to its existing paths", () => {
    expect(
      provisionedHetznerServerId({ hetzner_server_id: 42, status: "error", gateway_url: null })
    ).toBe(42);
  });

  it("returns null when no server id is recorded", () => {
    expect(provisionedHetznerServerId({ hetzner_server_id: null, status: "provisioning", gateway_url: GATEWAY })).toBeNull();
    expect(provisionedHetznerServerId({})).toBeNull();
  });
});

describe("recordHetznerCreationReceipt", () => {
  function fakeDb(error: { message: string } | null) {
    const eq = jest.fn().mockResolvedValue({ error });
    const update = jest.fn().mockReturnValue({ eq });
    const from = jest.fn(() => ({ update }));
    return { db: { from } as unknown as SupabaseClient, from, update, eq };
  }

  it("writes the server id onto the instance row", async () => {
    const { db, from, update, eq } = fakeDb(null);

    await recordHetznerCreationReceipt(db, { instanceId: "inst-1", serverId: 42 });

    expect(from).toHaveBeenCalledWith("hermes_instances");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ hetzner_server_id: 42 }));
    expect(update.mock.calls[0][0]).not.toHaveProperty("status");
    expect(eq).toHaveBeenCalledWith("id", "inst-1");
  });

  it("throws when the write fails so the caller rolls the server back", async () => {
    const { db } = fakeDb({ message: "db unavailable" });

    await expect(
      recordHetznerCreationReceipt(db, { instanceId: "inst-1", serverId: 42 })
    ).rejects.toThrow(/db unavailable/);
  });
});
