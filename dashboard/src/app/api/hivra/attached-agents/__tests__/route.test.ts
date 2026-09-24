/** @jest-environment node */
import { NextRequest } from "next/server";

// The Agents list's rows for agents added to a computer (design 5.1, 5.8).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: jest.fn() }));
jest.mock("@/lib/agent-computers/attach-flag", () => ({ isAgentAttachEnabled: jest.fn() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: jest.fn() }));
jest.mock("@/lib/agent-computers/attachment-lifecycle-store", () => ({ createAttachmentLifecycleStore: jest.fn() }));
const computerRows = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => {
  const chain = { select: () => chain, eq: () => chain, neq: () => chain, limit: () => computerRows() };
  return chain;
} } }));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
  apiError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));

import { auth } from "@clerk/nextjs/server";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { isAgentAttachEnabled } from "@/lib/agent-computers/attach-flag";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { createAttachmentLifecycleStore } from "@/lib/agent-computers/attachment-lifecycle-store";
import { GET } from "../route";

const readOwnerAttached = jest.fn();
const get = () => GET(new NextRequest("https://canary.hermesos.cloud/api/hivra/attached-agents", { headers: { host: "canary.hermesos.cloud" } }));

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(auth).mockResolvedValue({ userId: "owner-1" } as Awaited<ReturnType<typeof auth>>);
  jest.mocked(isHivraApiAllowed).mockReturnValue(true);
  jest.mocked(isAgentAttachEnabled).mockReturnValue(true);
  jest.mocked(enforceAuthenticatedRouteRateLimit).mockReturnValue(null);
  jest.mocked(createAttachmentLifecycleStore).mockReturnValue({ readOwnerAttached } as unknown as ReturnType<typeof createAttachmentLifecycleStore>);
});

it("is empty where attach is not offered, without reading storage", async () => {
  jest.mocked(isAgentAttachEnabled).mockReturnValue(false);
  expect((await (await get()).json()).data).toEqual({ enabled: false, agents: [], eligibleComputerIds: [] });
  expect(readOwnerAttached).not.toHaveBeenCalled();
});

it("needs a signed-in owner and reads only that owner's rows", async () => {
  jest.mocked(auth).mockResolvedValueOnce({ userId: null } as unknown as Awaited<ReturnType<typeof auth>>);
  expect((await get()).status).toBe(401);
  readOwnerAttached.mockResolvedValue([{ id: "44444444-4444-4444-8444-444444444444", phase: "attached", agentName: "Codex", runtimeId: "codex",
    sourceId: "11111111-1111-4111-8111-111111111111", computerName: "MY_UBUNTU_DESKTOP", computerStatus: "running", deploymentMode: "hivra-managed",
    installationId: "55555555-5555-4555-8555-555555555555", createdAt: "2026-09-24T10:00:00Z", completedAt: "2026-09-24T10:02:00Z" }]);
  const body = (await (await get()).json()).data;
  expect(readOwnerAttached).toHaveBeenCalledWith("owner-1");
  expect(body.enabled).toBe(true);
  expect(body.agents).toEqual([expect.objectContaining({ agentName: "Codex", computerId: "11111111-1111-4111-8111-111111111111",
    computerName: "MY_UBUNTU_DESKTOP", phase: "attached" })]);
  // The browser never gets the installation id: the chat path is the computer's own.
  expect(body.agents[0]).not.toHaveProperty("installationId");
});

it("names the computers that can take Codex, with the binding column the browser never sees", async () => {
  readOwnerAttached.mockResolvedValue([]);
  const desk = { id: "11111111-1111-4111-8111-111111111111", type: "linux-desktop", computer_profile: "ubuntu-desktop",
    computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true, deployment_mode: "hivra-managed" };
  computerRows.mockResolvedValue({ data: [desk, { ...desk, id: "22222222-2222-4222-8222-222222222222", infrastructure_binding_token_enforced: null },
    { ...desk, id: "33333333-3333-4333-8333-333333333333", computer_profile: "windows" }], error: null });
  expect((await (await get()).json()).data.eligibleComputerIds).toEqual([desk.id]);
  computerRows.mockResolvedValue({ data: null, error: { message: "down" } });
  expect((await (await get()).json()).data.eligibleComputerIds).toEqual([]);
});

it("says the list could not be loaded when storage fails", async () => {
  readOwnerAttached.mockRejectedValue(new Error("down"));
  const response = await get();
  expect(response.status).toBe(503);
  expect((await response.json()).error).toBe("Agents added to your computers couldn't be loaded.");
});
