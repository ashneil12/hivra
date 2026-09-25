/** @jest-environment node */
import { NextRequest } from "next/server";

// Change access and Remove (design 5.5, 5.8; threats T1, T20, T23, T31): each
// its own reviewed operation, begun once on the owner's own attachment. The
// route logic runs for real; auth, the flag and storage are faked.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: jest.fn() }));
jest.mock("@/lib/agent-computers/attach-flag", () => ({ isAgentAttachEnabled: jest.fn() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: jest.fn() }));
jest.mock("@/lib/agent-computers/attachment-lifecycle-store", () => ({ createAttachmentLifecycleStore: jest.fn() }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: jest.fn(), resolvePlanAgentSlots: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
  apiError: (error: string, status: number, _details?: unknown, extra?: Record<string, unknown>) =>
    Response.json({ success: false, error, ...(extra ?? {}) }, { status }),
}));

import { auth } from "@clerk/nextjs/server";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { isAgentAttachEnabled } from "@/lib/agent-computers/attach-flag";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { createAttachmentLifecycleStore } from "@/lib/agent-computers/attachment-lifecycle-store";
import { supabaseAdmin } from "@/lib/supabase";
import { accessReviewSha256, removeReviewSha256 } from "@/lib/agent-computers/attach-review";
import { DELETE, PATCH } from "../route";

const ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT = "44444444-4444-4444-8444-444444444444";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const OWNER = "authenticated-owner";
let computerRow: Record<string, unknown> | null;
const store = { readTarget: jest.fn(), readAttachments: jest.fn(), beginOperation: jest.fn() };
const authority = { id: ID, vmid: 1201 };
const attached = { id: ATTACHMENT, phase: "attached", agentName: "Codex", runtimeId: "codex", agentIdentityId: REQUEST,
  grants: { workspace: true }, endReason: null, createdAt: "2026-09-24T10:00:00Z", dispatchedAt: null, completedAt: "2026-09-24T10:02:00Z",
  endedAt: null, deploymentMode: "hivra-managed", installationId: "55555555-5555-4555-8555-555555555555",
  receipts: { accepted: null, staged: null, started: null, chatReady: null }, contract: null, operation: null };

function send(method: "PATCH" | "DELETE", body: unknown, attachmentId = ATTACHMENT, headers: Record<string, string> = {}) {
  const request = new NextRequest(`https://canary.hermesos.cloud/api/hivra/computers/${ID}/agents/${attachmentId}`, {
    method, body: JSON.stringify(body),
    headers: { host: "canary.hermesos.cloud", origin: "https://canary.hermesos.cloud", "sec-fetch-site": "same-origin",
      "content-type": "application/json", ...headers },
  });
  const context = { params: Promise.resolve({ id: ID, attachmentId }) };
  return method === "PATCH" ? PATCH(request, context) : DELETE(request, context);
}
const accessBody = (workspace = false) => ({ grants: { workspace }, reviewSha256: accessReviewSha256(ATTACHMENT, { workspace: true }, { workspace }),
  requestId: REQUEST });
const removeBody = () => ({ reviewSha256: removeReviewSha256(ATTACHMENT, { workspace: true }), requestId: REQUEST });

beforeEach(() => {
  jest.resetAllMocks();
  computerRow = { id: ID, name: "MY_UBUNTU_DESKTOP", type: "linux-desktop", cpu: 2, ram: 4, deployment_mode: "hivra-managed", status: "running",
    computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true };
  jest.mocked(auth).mockResolvedValue({ userId: OWNER } as Awaited<ReturnType<typeof auth>>);
  jest.mocked(isHivraApiAllowed).mockReturnValue(true);
  jest.mocked(isAgentAttachEnabled).mockReturnValue(true);
  jest.mocked(enforceAuthenticatedRouteRateLimit).mockReturnValue(null);
  jest.mocked(createAttachmentLifecycleStore).mockReturnValue(store as unknown as ReturnType<typeof createAttachmentLifecycleStore>);
  const chain: Record<string, jest.Mock> = {};
  chain.select = jest.fn(() => chain); chain.eq = jest.fn(() => chain); chain.neq = jest.fn(() => chain);
  chain.maybeSingle = jest.fn(async () => ({ data: computerRow, error: null }));
  jest.mocked(supabaseAdmin!.from).mockReturnValue(chain as never);
  store.readTarget.mockResolvedValue({ authority, eligible: false, reason: "agent_present" });
  store.readAttachments.mockResolvedValue([attached]);
  store.beginOperation.mockResolvedValue({ status: "claimed", operationId: REQUEST, resumed: false });
});

it("is off where attach is not offered", async () => {
  jest.mocked(isAgentAttachEnabled).mockReturnValue(false);
  expect((await send("PATCH", accessBody())).status).toBe(404);
  expect((await send("DELETE", removeBody())).status).toBe(404);
  expect(auth).not.toHaveBeenCalled();
});

it("refuses anonymous, cross-site and non-JSON requests before reading anything", async () => {
  jest.mocked(auth).mockResolvedValueOnce({ userId: null } as unknown as Awaited<ReturnType<typeof auth>>);
  expect((await send("PATCH", accessBody())).status).toBe(401);
  expect((await send("PATCH", accessBody(), ATTACHMENT, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await send("DELETE", removeBody(), ATTACHMENT, { "content-type": "text/plain" })).status).toBe(403);
  expect(store.readAttachments).not.toHaveBeenCalled();
});

it("answers 404 for someone else's computer or an attachment that is not on it (T1)", async () => {
  expect((await send("PATCH", accessBody(), "66666666-6666-4666-8666-666666666666")).status).toBe(404);
  computerRow = null;
  expect((await send("DELETE", removeBody())).status).toBe(404);
  expect(store.beginOperation).not.toHaveBeenCalled();
});

it("refuses a review that does not match what the owner saw (T20, T31)", async () => {
  const wrongDirection = { ...accessBody(false), grants: { workspace: true } };
  const response = await send("PATCH", wrongDirection);
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("The review changed. Check it again.");
  expect((await send("DELETE", { ...removeBody(), reviewSha256: accessBody(false).reviewSha256 })).status).toBe(409);
  expect(store.beginOperation).not.toHaveBeenCalled();
});

it("refuses a step on an agent that is still being added", async () => {
  store.readAttachments.mockResolvedValue([{ ...attached, phase: "dispatched" }]);
  const response = await send("DELETE", removeBody());
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("Codex is not ready on this computer yet.");
});

it("begins Change access once with the reviewed grants and answers 202", async () => {
  const response = await send("PATCH", accessBody(false));
  expect(response.status).toBe(202);
  expect(store.beginOperation).toHaveBeenCalledTimes(1);
  expect(store.beginOperation).toHaveBeenCalledWith({ ownerId: OWNER, attachmentId: ATTACHMENT, operationId: REQUEST, kind: "access_change",
    authority, grants: { workspace: false }, reviewSha256: accessBody(false).reviewSha256 });
});

it("begins Remove with the grants it had, as its own step (T23)", async () => {
  expect((await send("DELETE", removeBody())).status).toBe(202);
  expect(store.beginOperation).toHaveBeenCalledWith(expect.objectContaining({ kind: "detach", grants: { workspace: true } }));
});

it("maps the database's refusals to plain copy", async () => {
  store.beginOperation.mockResolvedValue({ status: "computer_busy" });
  let response = await send("PATCH", accessBody(false));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "This computer is busy with another step. Try again in a minute.", reason: "computer_busy" });
  store.beginOperation.mockResolvedValue({ status: "computer_not_running" });
  response = await send("DELETE", removeBody());
  expect((await response.json()).error).toBe("Start the computer to change what Codex can use or to remove it.");
});

it("never accepts extra fields such as an owner or a runtime", async () => {
  expect((await send("PATCH", { ...accessBody(false), ownerId: "attacker" })).status).toBe(400);
  expect((await send("DELETE", { ...removeBody(), deleteFiles: true })).status).toBe(400);
  expect(store.beginOperation).not.toHaveBeenCalled();
});
