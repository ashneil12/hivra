/**
 * POST /api/mobile/launch tests. Locks in:
 *   - paid-only lane: 402 (code subscription_required) for no-sub / free /
 *     stripe-trialing callers — the app's paywall signal
 *   - persona → createInstance parameter mapping is byte-compatible with the
 *     web welcome flow: managed Venice ON, first-listed Venice model, plan-
 *     derived cpu/ram (never client-supplied), soul-seeded systemPrompt,
 *     honcho aiPeer derivation
 *   - createInstance is delegated to UNMODIFIED (spied, not reimplemented)
 *   - firstTask/goal/context persist via the follow-up row write (the web
 *     PATCH equivalent) + the mobile_launch_requested_at ledger stamp
 *   - the polling contract + consumer response shape
 *   - PostHog mobile_launch_requested with $insert_id + flush
 */

import { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  clerkClient: jest.fn(),
  currentUser: jest.fn(),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(),
}));
jest.mock("@/lib/venice/managed-endpoints", () => ({
  getManagedVeniceProxyBaseUrl: jest.fn(() => "https://proxy.hivra.test/api/v1"),
}));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "203.0.113.7"),
}));

const captureMock = jest.fn();
const flushMock = jest.fn();
jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => captureMock(...args),
    flush: (...args: unknown[]) => flushMock(...args),
  },
}));

import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getPersonaSoulPrompt } from "@/lib/persona-souls-accessor";
import { InstanceService } from "@/lib/services/instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const mockedAuth = auth as unknown as jest.Mock;
const mockedResolveSub = resolveEffectiveSubscription as jest.Mock;
const mockedFrom = supabaseAdmin!.from as jest.Mock;

let createInstanceSpy: jest.SpyInstance;

function operatorSub(overrides: Record<string, unknown> = {}) {
  return {
    plan: "operator",
    status: "active",
    instance_limit: 3,
    total_cpu_budget: 2,
    total_ram_budget: 4096,
    source: "stripe",
    canChangePlanInPlace: true,
    ...overrides,
  };
}

function launchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/mobile/launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The follow-up row write: update().eq() resolves clean.
function followUpDb() {
  const eqMock = jest.fn().mockResolvedValue({ error: null });
  const updateMock = jest.fn().mockReturnValue({ eq: eqMock });
  mockedFrom.mockImplementation((table: string) => {
    if (table !== "hermes_instances") throw new Error(`unexpected table ${table}`);
    return { update: updateMock };
  });
  return { updateMock, eqMock };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ userId: "user_123" });
  mockedResolveSub.mockResolvedValue(operatorSub());
  followUpDb();
  createInstanceSpy = jest
    .spyOn(InstanceService, "createInstance")
    .mockResolvedValue({
      success: true,
      data: {
        id: "inst-new",
        name: "Bea",
        subdomain: "abc123",
        status: "provisioning",
        provider: "venice",
        backend: "gateway",
      },
    });
});

afterEach(() => {
  createInstanceSpy.mockRestore();
});

describe("POST /api/mobile/launch — gates", () => {
  it("requires a Clerk session", async () => {
    mockedAuth.mockResolvedValue({ userId: null });
    const response = await POST(launchRequest({ personaId: "atlas", agentName: "Bea" }));
    expect(response.status).toBe(401);
    expect(createInstanceSpy).not.toHaveBeenCalled();
  });

  it("rate limits", async () => {
    (enforceRateLimit as jest.Mock).mockReturnValueOnce({ success: false });
    const response = await POST(launchRequest({ personaId: "atlas", agentName: "Bea" }));
    expect(response.status).toBe(429);
  });

  it("402s with subscription_required when the user has no subscription", async () => {
    mockedResolveSub.mockResolvedValue(null);
    const response = await POST(launchRequest({ personaId: "atlas", agentName: "Bea" }));
    const json = await response.json();
    expect(response.status).toBe(402);
    expect(json.code).toBe("subscription_required");
    expect(createInstanceSpy).not.toHaveBeenCalled();
  });

  it("402s for the free plan (mobile has no free tier)", async () => {
    mockedResolveSub.mockResolvedValue(
      operatorSub({ plan: "free", source: "free", instance_limit: 1 })
    );
    const response = await POST(launchRequest({ personaId: "atlas", agentName: "Bea" }));
    expect(response.status).toBe(402);
  });

  it("402s for a stripe-trialing sub (mirrors createInstance's own rejection)", async () => {
    mockedResolveSub.mockResolvedValue(operatorSub({ status: "trialing" }));
    const response = await POST(launchRequest({ personaId: "atlas", agentName: "Bea" }));
    expect(response.status).toBe(402);
  });

  it("400s on an unknown personaId", async () => {
    const response = await POST(launchRequest({ personaId: "nope", agentName: "Bea" }));
    expect(response.status).toBe(400);
  });

  it("400s when personaId=custom is sent without the custom object", async () => {
    const response = await POST(launchRequest({ personaId: "custom", agentName: "Ripley" }));
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error).toContain("custom");
  });

  it("400s when neither personaId nor custom is sent", async () => {
    const response = await POST(launchRequest({ agentName: "Bea" }));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/mobile/launch — persona lane", () => {
  it("maps the persona onto the exact web welcome-flow createInstance inputs", async () => {
    const response = await POST(
      launchRequest({
        personaId: "atlas",
        agentName: "Bea",
        whoYouAre: "Founder",
        workingOn: "A small bakery",
        firstTask: "Plan my launch week",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(createInstanceSpy).toHaveBeenCalledTimes(1);
    const [userId, params] = createInstanceSpy.mock.calls[0];
    expect(userId).toBe("user_123");

    // Managed-Venice profile, exactly as the web deploy card submits it.
    expect(params).toMatchObject({
      name: "Bea",
      provider: "venice",
      apiKey: "",
      model: "deepseek-v4-flash",
      managedVenice: { enabled: true, walletType: "hermesos" },
      // Plan-derived sizing (operator = 2 vCPU / 4096 MB) — never client-sent.
      cpuLimit: 2,
      ramLimit: 4096,
    });
    expect(params.honcho).toMatchObject({
      enabled: true,
      peerName: "user",
      aiPeer: "bea",
      memoryMode: "hybrid",
      recallMode: "hybrid",
    });
    // Web-parity agent settings (buildWelcomeAgentSettings managed profile).
    expect(params.agentSettings).toMatchObject({
      runtimeMode: "managed",
      enableRootAccess: false,
      browserProvider: "local",
      customLlmBaseUrl: "https://proxy.hivra.test/api/v1",
    });
    expect(params.agentSettings.fallbackModels).toBe(
      JSON.stringify([{ provider: "venice", model: "deepseek-v4-flash", apiKey: "" }])
    );

    // The authored soul is the base of the system prompt; the firstRun block
    // carries the quiz answers.
    const systemPrompt = params.agentSettings.systemPrompt as string;
    expect(systemPrompt.startsWith(getPersonaSoulPrompt("bea").trim())).toBe(true);
    expect(systemPrompt).toContain("You are Bea.");
    expect(systemPrompt).toContain("The user describes themselves as: Founder.");
    expect(systemPrompt).toContain("Their business / product: A small bakery.");
    expect(systemPrompt).toContain(
      "The first task the user wants demonstrated: Plan my launch week"
    );

    // Consumer response: instance row + agent identity + polling contract.
    expect(json.data.instance).toMatchObject({ id: "inst-new", status: "provisioning" });
    expect(json.data.agent).toEqual({
      name: "Bea",
      emoji: "🤖",
      personaId: "atlas",
      goal: "assist",
    });
    expect(json.data.polling).toEqual({
      statusUrl: "/api/instances?summary=true",
      retryAfterMs: 5000,
    });
  });

  it("persists firstTask/goal/context and stamps the mobile-launch ledger AFTER create", async () => {
    const { updateMock, eqMock } = followUpDb();

    await POST(
      launchRequest({
        personaId: "scout",
        agentName: "Sable",
        goal: "research",
        firstTask: "Compare three CRMs",
      })
    );

    expect(updateMock).toHaveBeenCalledWith({
      goal: "research",
      first_task: "Compare three CRMs",
      context: null,
      notifications_sent: {
        mobile_launch_requested_at: expect.any(String),
      },
    });
    expect(eqMock).toHaveBeenCalledWith("id", "inst-new");
  });

  it("falls back to the persona's preset goal when the sent goal is not a known id", async () => {
    const { updateMock } = followUpDb();
    await POST(
      launchRequest({ personaId: "scout", agentName: "Sable", goal: "world-domination" })
    );
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "research" }) // Sable's preset
    );
  });

  it("captures mobile_launch_requested with $insert_id and flushes before provisioning", async () => {
    await POST(launchRequest({ personaId: "atlas", agentName: "Bea", firstTask: "x" }));

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user_123",
        event: "mobile_launch_requested",
        properties: expect.objectContaining({
          persona: "atlas",
          plan: "operator",
          has_first_task: true,
          $insert_id: expect.stringMatching(/^mobile_launch_requested_/),
        }),
      })
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("propagates createInstance failures with their status and failureType", async () => {
    createInstanceSpy.mockResolvedValue({
      success: false,
      status: 503,
      message: "Managed Venice is not ready for deployment.",
      failureType: "managed_venice_deploy_proxy_key_failed",
    });

    const response = await POST(launchRequest({ personaId: "atlas", agentName: "Bea" }));
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.failureType).toBe("managed_venice_deploy_proxy_key_failed");
    // No follow-up write on failure.
    expect(mockedFrom).not.toHaveBeenCalled();
  });
});

describe("POST /api/mobile/launch — custom lane", () => {
  it("builds a soul-less custom specialist with expertise folded into context", async () => {
    const { updateMock } = followUpDb();

    const response = await POST(
      launchRequest({
        custom: { name: "Ripley", emoji: "🚀", expertise: "Ecommerce operations" },
        agentName: "Ripley",
        firstTask: "Audit my store",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    const [, params] = createInstanceSpy.mock.calls[0];
    const systemPrompt = params.agentSettings.systemPrompt as string;

    // No authored soul: the prompt is just the firstRun block.
    expect(systemPrompt.startsWith("You are Ripley.")).toBe(true);
    expect(systemPrompt).toContain("Your personality: friendly and adaptable.");
    expect(systemPrompt).toContain("Launch context from the user: Ecommerce operations");

    // Expertise persists to the context column (web parity).
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ context: "Ecommerce operations" })
    );
    expect(json.data.agent).toMatchObject({ personaId: "custom", emoji: "🚀" });
  });
});
