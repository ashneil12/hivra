/** @jest-environment node */
// What kit an agent should have, with the local bridge in the picture.
jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/hivra/pinned-guest-seed", () => ({ buildPinnedGuestHostScript: jest.fn(), resolvePinnedGuestTarget: jest.fn() }));
jest.mock("@/lib/hivra/provider-guest-seed", () => ({ runProviderAgentGuestScript: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/local-bridge/flag", () => ({ isLocalBridgeEnabled: jest.fn() }));
jest.mock("@/lib/local-bridge/store", () => ({ loadComputers: jest.fn() }));
jest.mock("../store", () => ({
  db: jest.fn(), loadKeyRecord: jest.fn(), loadLinks: jest.fn(), loadOwnedRow: jest.fn(), loadOwnedRows: jest.fn(), markKitDirty: jest.fn(),
  sha256Hex: (value: string) => createHash("sha256").update(value).digest("hex"),
}));

import { createHash } from "node:crypto";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { loadComputers } from "@/lib/local-bridge/store";
import { desiredKit, resyncOwnerKitsForBridge } from "../kit-delivery";
import { loadKeyRecord, loadLinks, loadOwnedRow, loadOwnedRows, markKitDirty } from "../store";

const AGENT = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: "u", name: "Claude", type: "hermes", status: "running" } as never;
const MAC = { id: "33333333-3333-4333-8333-333333333333", label: "Owner Mac", revoked_at: null };
const ENDPOINT = "https://canary.example.test/api/agent-link";

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isLocalBridgeEnabled).mockReturnValue(true);
  jest.mocked(loadLinks).mockResolvedValue([]);
  jest.mocked(loadOwnedRows).mockResolvedValue([AGENT]);
  jest.mocked(loadComputers).mockResolvedValue([MAC] as never);
});

describe("desiredKit with the local bridge", () => {
  it("installs for an owner with only a bridge computer, and names it", async () => {
    const kit = await desiredKit("u", AGENT, ENDPOINT);
    expect(kit.mode).toBe("install");
    expect(kit.bridgeComputers).toEqual([{ id: MAC.id, name: "Owner Mac" }]);
    expect(kit.note).toContain("hivra-computers bridge run");
    expect(kit.skill).toContain("name: hivra-computers");
  });

  it("removes the kit when the last bridge computer is revoked", async () => {
    jest.mocked(loadComputers).mockResolvedValue([{ ...MAC, revoked_at: "2026-11-01T00:00:00Z" }] as never);
    expect((await desiredKit("u", AGENT, ENDPOINT)).mode).toBe("remove");
  });

  it("removes the kit when the flag is off, without reading the bridge", async () => {
    jest.mocked(isLocalBridgeEnabled).mockReturnValue(false);
    expect((await desiredKit("u", AGENT, ENDPOINT)).mode).toBe("remove");
    expect(loadComputers).not.toHaveBeenCalled();
  });

  it("changes the digest when the bridge list changes", async () => {
    const one = (await desiredKit("u", AGENT, ENDPOINT)).digest;
    expect((await desiredKit("u", AGENT, ENDPOINT)).digest).toBe(one);
    jest.mocked(loadComputers).mockResolvedValue([MAC, { ...MAC, id: "44444444-4444-4444-8444-444444444444", label: "Second" }] as never);
    const two = (await desiredKit("u", AGENT, ENDPOINT)).digest;
    expect(two).not.toBe(one);
    jest.mocked(loadComputers).mockResolvedValue([{ ...MAC, label: "Renamed" }] as never);
    expect((await desiredKit("u", AGENT, ENDPOINT)).digest).not.toBe(one);
  });

  it("keeps the linked-computer text when there are links too", async () => {
    jest.mocked(loadLinks).mockResolvedValue([{ computer_id: "c1" }] as never);
    jest.mocked(loadOwnedRows).mockResolvedValue([AGENT, { id: "c1", name: "Studio", type: "linux-desktop", computer_profile: "ubuntu-desktop" }] as never);
    const kit = await desiredKit("u", AGENT, ENDPOINT);
    expect(kit.note).toContain("Studio");
    expect(kit.note).toContain("hivra-computers run <computer>");
    expect(kit.note).toContain("hivra-computers bridge run");
  });
});

describe("resyncOwnerKitsForBridge", () => {
  it("marks the owner's agents out of date, skipping computers", async () => {
    jest.mocked(loadOwnedRows).mockResolvedValue([AGENT, { id: "c1", name: "Studio", type: "linux-desktop", computer_profile: "ubuntu-desktop", status: "running" }] as never);
    jest.mocked(loadOwnedRow).mockResolvedValue(null);
    jest.mocked(loadKeyRecord).mockResolvedValue(null);
    await resyncOwnerKitsForBridge("u", ENDPOINT);
    expect(markKitDirty).toHaveBeenCalledWith("u", [(AGENT as { id: string }).id]);
  });
});
