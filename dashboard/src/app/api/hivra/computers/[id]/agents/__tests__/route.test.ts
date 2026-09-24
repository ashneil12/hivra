/** @jest-environment node */
import { NextRequest } from "next/server";

// Add an agent to a computer (design 5.6, 5.8; threats T1, T20, T35). The route
// logic runs for real; only auth, the flag, storage and the plan are faked.

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
import { resolvePlanAgentSlots, validateAgentResources } from "@/lib/hivra/resource-gate";
import { supabaseAdmin } from "@/lib/supabase";
import { ATTACH_GRANT_POLICY_SHA256, ATTACHED_SERVICE_POLICY_V2_SHA256, attachReviewSha256 } from "@/lib/agent-computers/attach-review";
import { ATTACH_INSTALLER_SHA256, ATTACH_NOT_AVAILABLE } from "@/lib/agent-computers/attach-plan";
import { GET, POST } from "../route";

const ID = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const OWNER = "authenticated-owner";
let computerRow: Record<string, unknown> | null;
const store = { readTarget: jest.fn(), readAttachments: jest.fn(), claim: jest.fn(), cancel: jest.fn() };
const target = { version: 1, sourceId: ID, computerId: "33333333-3333-4333-8333-333333333333", deploymentMode: "hivra-managed",
  ramGb: 4, cpu: 2, authority: { id: ID, vmid: 1201 }, writeAuthority: "legacy", eligible: true, reason: null, liveAttachmentId: null };
const review = (workspace: boolean, row = computerRow!) => attachReviewSha256({ sourceId: ID, deploymentMode: row.deployment_mode as string,
  cpu: row.cpu as number, ramGb: row.ram as number }, { workspace });

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest(`https://canary.hermesos.cloud/api/hivra/computers/${ID}/agents`, {
    method: "POST", body: JSON.stringify(body),
    headers: { host: "canary.hermesos.cloud", origin: "https://canary.hermesos.cloud", "sec-fetch-site": "same-origin",
      "content-type": "application/json", ...headers },
  }), { params: Promise.resolve({ id: ID }) });
}
function get(id = ID) {
  return GET(new NextRequest(`https://canary.hermesos.cloud/api/hivra/computers/${id}/agents`, { headers: { host: "canary.hermesos.cloud" } }),
    { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  jest.resetAllMocks();
  computerRow = { id: ID, name: "MY_UBUNTU_DESKTOP", type: "linux-desktop", cpu: 2, ram: 4, deployment_mode: "hivra-managed", status: "running",
    computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true, chat_url: "https://box.test" };
  jest.mocked(auth).mockResolvedValue({ userId: OWNER } as Awaited<ReturnType<typeof auth>>);
  jest.mocked(isHivraApiAllowed).mockReturnValue(true);
  jest.mocked(isAgentAttachEnabled).mockReturnValue(true);
  jest.mocked(enforceAuthenticatedRouteRateLimit).mockReturnValue(null);
  jest.mocked(createAttachmentLifecycleStore).mockReturnValue(store as unknown as ReturnType<typeof createAttachmentLifecycleStore>);
  const chain: Record<string, jest.Mock> = {};
  chain.select = jest.fn(() => chain); chain.eq = jest.fn(() => chain); chain.neq = jest.fn(() => chain);
  chain.maybeSingle = jest.fn(async () => ({ data: computerRow, error: null }));
  jest.mocked(supabaseAdmin!.from).mockReturnValue(chain as never);
  store.readTarget.mockResolvedValue(target);
  store.readAttachments.mockResolvedValue([]);
  jest.mocked(validateAgentResources).mockResolvedValue({ ok: true });
  jest.mocked(resolvePlanAgentSlots).mockResolvedValue({ agentLimit: 3, planName: "Pro" });
});

it("is off where attach is not offered: 404 before auth or storage", async () => {
  jest.mocked(isAgentAttachEnabled).mockReturnValue(false);
  expect((await get()).status).toBe(404);
  expect((await post({ grants: { workspace: true }, reviewSha256: "a".repeat(64), requestId: REQUEST })).status).toBe(404);
  expect(auth).not.toHaveBeenCalled();
  expect(store.claim).not.toHaveBeenCalled();
});

it("returns 404 for a foreign or missing computer without any attach call (T1)", async () => {
  computerRow = null;
  expect((await get()).status).toBe(404);
  const response = await post({ grants: { workspace: true }, reviewSha256: "a".repeat(64), requestId: REQUEST });
  expect(response.status).toBe(404);
  expect(store.readTarget).not.toHaveBeenCalled();
  expect(store.claim).not.toHaveBeenCalled();
  expect(jest.mocked(supabaseAdmin!.from).mock.results[0].value.eq).toHaveBeenCalledWith("user_id", OWNER);
});

it("never takes an owner from the body, and refuses cross-site or non-JSON requests", async () => {
  expect((await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST, ownerId: "attacker" })).status).toBe(400);
  expect((await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST }, { "content-type": "text/plain" })).status).toBe(403);
  expect(store.claim).not.toHaveBeenCalled();
});

it("is rate limited per owner", async () => {
  jest.mocked(enforceAuthenticatedRouteRateLimit).mockReturnValue(Response.json({ error: "slow down" }, { status: 429 }) as never);
  expect((await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST })).status).toBe(429);
  expect(enforceAuthenticatedRouteRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: OWNER, routeKey: "hivra:attach:add" }));
});

it("refuses a review that no longer matches the computer with 409 and no claim (T20)", async () => {
  const stale = review(true, { ...computerRow!, ram: 8 });
  const response = await post({ grants: { workspace: true }, reviewSha256: stale, requestId: REQUEST });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("The review changed. Check it again.");
  expect(store.claim).not.toHaveBeenCalled();
});

it("shows the plan copy with no claim when a Hivra Cloud computer's plan is full (T35)", async () => {
  jest.mocked(validateAgentResources).mockResolvedValue({ ok: false, status: 403,
    message: "Your Free plan allows 1 active agent and you already have 1. Upgrade for more slots, or remove an agent first." });
  const response = await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST });
  expect(response.status).toBe(403);
  expect((await response.json()).error).toContain("Your Free plan allows 1 active agent and you already have 1.");
  expect(store.claim).not.toHaveBeenCalled();
  expect(validateAgentResources).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER, mode: "attach" }));
});

it("makes exactly one claim with intent v2, maps the database's plan refusal to 403, and never cancels (T35)", async () => {
  store.claim.mockResolvedValue({ status: "plan_agent_limit", activeCount: 3, limit: 3 });
  const response = await post({ grants: { workspace: false }, reviewSha256: review(false), requestId: REQUEST });
  expect(response.status).toBe(403);
  expect((await response.json()).error).toBe("Your Pro plan allows 3 active agents and you already have 3. Upgrade for more slots, or remove an agent first.");
  expect(store.claim).toHaveBeenCalledTimes(1);
  expect(store.cancel).not.toHaveBeenCalled();
});

it("claims with the reviewed grants and pinned policy, and answers 202 with the operation", async () => {
  store.claim.mockResolvedValue({ status: "claimed", operationId: REQUEST, resumed: false });
  const response = await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST });
  expect(response.status).toBe(202);
  expect((await response.json()).data).toEqual({ operationId: REQUEST, resumed: false });
  const claim = store.claim.mock.calls[0][0];
  expect(claim).toMatchObject({ ownerId: OWNER, sourceId: ID, operationId: REQUEST, authority: target.authority, agentLimit: 3 });
  expect(claim.intent).toMatchObject({ version: 2, runtimeId: "codex", agentName: "Codex", installerSha256: ATTACH_INSTALLER_SHA256,
    grants: { workspace: true }, grantPolicySha256: ATTACH_GRANT_POLICY_SHA256, reviewSha256: review(true), requestId: REQUEST });
  expect(Object.keys(claim.intent).sort()).toEqual(["agentIdentityId", "agentName", "grantPolicySha256", "grants", "installerSha256",
    "requestId", "reviewSha256", "runtimeId", "version"]);
});

it("does not count an agent on My server against the plan", async () => {
  computerRow = { ...computerRow!, deployment_mode: "self-managed" };
  store.readTarget.mockResolvedValue({ ...target, deploymentMode: "self-managed" });
  store.claim.mockResolvedValue({ status: "claimed", operationId: REQUEST, resumed: false });
  expect((await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST })).status).toBe(202);
  expect(validateAgentResources).not.toHaveBeenCalled();
  expect(store.claim.mock.calls[0][0].agentLimit).toBe(100000);
});

it("reads the gate: reviews for an eligible computer, and the plan copy with a Billing link and no Review at the limit", async () => {
  let body = (await (await get()).json()).data;
  expect(body.available).toBe(true);
  expect(body.reviews).toEqual({ workspaceOn: review(true), workspaceOff: review(false) });
  expect(body.policy).toEqual({ grantPolicySha256: ATTACH_GRANT_POLICY_SHA256, servicePolicySha256: ATTACHED_SERVICE_POLICY_V2_SHA256,
    installerSha256: ATTACH_INSTALLER_SHA256 });
  jest.mocked(validateAgentResources).mockResolvedValue({ ok: false, status: 403, message: "Your Free plan allows 1 active agent and you already have 1. Upgrade for more slots, or remove an agent first." });
  body = (await (await get()).json()).data;
  expect(body).toMatchObject({ available: false, reason: "plan_agent_limit", billingHref: "/dashboard/billing", reviews: null });
});

it("says an ineligible computer is not available yet, without reading the attach chain", async () => {
  computerRow = { ...computerRow!, computer_profile: "omarchy" };
  const body = (await (await get()).json()).data;
  expect(body).toMatchObject({ available: false, reason: "unsupported_computer", message: ATTACH_NOT_AVAILABLE, reviews: null });
  expect(store.readTarget).not.toHaveBeenCalled();
});

it("checks the computer is running and ready: the gate says why, and Add is refused before any claim", async () => {
  store.readTarget.mockResolvedValue({ ...target, eligible: false, reason: "computer_not_ready" });
  const gate = await (await get()).json();
  expect(gate.data).toMatchObject({ available: false, reason: "computer_not_ready", reviews: null, billingHref: null,
    message: "This computer isn't ready yet. Add Codex once it has finished starting." });
  const response = await post({ grants: { workspace: true }, reviewSha256: review(true), requestId: REQUEST });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ reason: "computer_not_ready" });
  expect(store.claim).not.toHaveBeenCalled();
});
