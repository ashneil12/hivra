/** @jest-environment jsdom */

import {
  createAgent,
  findHivraLaunchReceipt,
  HivraLaunchCorrectableError,
  HivraLaunchInProgressError,
  HivraLaunchRejectedError,
  listAgentsResult,
  type HivraAgent,
} from "@/lib/hivra/agent-api";
import { PROFILE_DETAILS, type LaunchDraft, type LaunchModelAccess, type LaunchProfileId } from "../contracts";
import { createLaunchDraft } from "../draft-store";
import {
  LaunchCorrectableError,
  launchResultHref,
  launchResumeMode,
  opensOnAcceptance,
  reconcileLaunchDraft,
  submitLaunchDraft,
} from "../launch-adapter";
import { legacyCodexModelBody, legacyDashboardAgentBody, legacyHermesDeployBody, legacyNativeCliBody } from "./legacy-welcome-requests";

jest.mock("@/lib/hivra/agent-api", () => {
  const actual = jest.requireActual("@/lib/hivra/agent-api");
  return { ...actual, createAgent: jest.fn(), findHivraLaunchReceipt: jest.fn(), listAgentsResult: jest.fn() };
});
jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => "fp-request-1" }));

const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
const MANAGED = { mode: "hivra-managed" } as const;
const SELF_MANAGED = {
  mode: "self-managed",
  connectionId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  expectedConnectionRevision: 3,
} as const;
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const VAULT_KEY_ID = "44444444-4444-4444-8444-444444444444";
const HONCHO_KEY_ID = "55555555-5555-4555-8555-555555555555";
const FUNDED = { state: "known", cardMicroUsd: 4_000_000, hermesosMicroUsd: 0 } as const;
const TOKEN_ONLY = { state: "known", cardMicroUsd: 0, hermesosMicroUsd: 7_000_000 } as const;

function draftFor(profileId: LaunchProfileId, overrides: Partial<LaunchDraft> = {}, access: Partial<LaunchModelAccess> = {}): LaunchDraft {
  const base = createLaunchDraft();
  const details = PROFILE_DETAILS[profileId];
  return {
    ...base,
    stage: "launch",
    launchState: "submitting",
    resourceKind: details.resourceKind,
    profileId,
    name: `${details.name} 1`,
    resources: { ...details.recommended },
    submittedAt: new Date().toISOString(),
    ...overrides,
    modelAccess: { ...base.modelAccess, ...access },
  };
}

function created(type: string, overrides: Partial<HivraAgent> = {}): HivraAgent {
  return { id: AGENT_ID, type, name: "Agent", status: "provisioning", cpu: 1, ram: 2, ...overrides } as HivraAgent;
}

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[];
let fetchRoutes: Array<(url: string, init?: RequestInit) => Response | null>;

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function route(match: (url: string, init?: RequestInit) => boolean, respond: (url: string, init?: RequestInit) => Response) {
  fetchRoutes.push((url, init) => match(url, init) ? respond(url, init) : null);
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchCalls = [];
  fetchRoutes = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    for (const handler of fetchRoutes) {
      const response = handler(url, init);
      if (response) return response;
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

function bodyOf(call: FetchCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? "null"));
}

describe("Claude Code, OpenClaw, Agent Zero and Aeon launch through the agent API as their forms did", () => {
  it.each([
    ["with its browser on Hivra Cloud", true, MANAGED],
    ["without its browser on the owner's server", false, SELF_MANAGED],
  ] as const)("sends Claude Code %s", async (_label, browser, deployment) => {
    jest.mocked(createAgent).mockResolvedValue(created("claude-code"));
    const draft = draftFor("claude-code", { browser, resources: { cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, source: "recommended" } });

    await expect(submitLaunchDraft(draft, deployment)).resolves.toMatchObject({ id: AGENT_ID });

    expect(wire(jest.mocked(createAgent).mock.calls[0][0])).toEqual(legacyNativeCliBody({
      agentId: "claude-code", agentName: "Claude Code 1", resolvedCpu: 2, resolvedRam: 4,
      effectiveBrowser: browser, deployment, nativeRequestId: null,
    }));
    // Claude Code's lane takes no receipt id and no size maxima.
    expect(jest.mocked(createAgent).mock.calls[0][0]).not.toHaveProperty("launchRequestId");
    expect(jest.mocked(createAgent).mock.calls[0][0]).not.toHaveProperty("maximumCpu");
  });

  it.each([
    ["openclaw", "native", false, { state: "unknown" }, false],
    ["openclaw", "credits", true, FUNDED, true],
    ["openclaw", "credits", false, TOKEN_ONLY, true],
    ["agent-zero", "credits", false, FUNDED, true],
    ["agent-zero", "native", false, FUNDED, false],
    ["aeon", "credits", false, TOKEN_ONLY, true],
    ["aeon", "native", false, FUNDED, false],
  ] as const)("sends %s with %s model access exactly as its form did", async (profileId, mode, browser, balance, wantManaged) => {
    jest.mocked(createAgent).mockResolvedValue(created(profileId));
    const resources = PROFILE_DETAILS[profileId].recommended;
    const draft = draftFor(profileId, { browser }, { mode, source: "custom" });

    await submitLaunchDraft(draft, MANAGED, { balance });

    expect(wire(jest.mocked(createAgent).mock.calls[0][0])).toEqual(legacyDashboardAgentBody({
      agentId: profileId,
      agentName: `${PROFILE_DETAILS[profileId].name} 1`,
      resolvedCpu: resources.cpu,
      resolvedRam: resources.ram,
      effectiveBrowser: browser,
      wantManaged,
      cardMicro: balance.state === "known" ? balance.cardMicroUsd : 0,
      hermesosMicro: balance.state === "known" ? balance.hermesosMicroUsd : 0,
      deployment: MANAGED,
    }));
  });

  it("never sends a browser flag for Agent Zero or Aeon, which bring none", async () => {
    jest.mocked(createAgent).mockResolvedValue(created("agent-zero"));
    await submitLaunchDraft(draftFor("agent-zero", { browser: true }), MANAGED);
    expect(jest.mocked(createAgent).mock.calls[0][0]).toMatchObject({ browser: false });
  });

  it("uses the floors from the agent catalog for their recommended sizes", () => {
    expect(PROFILE_DETAILS.openclaw.recommended).toMatchObject({ cpu: 1, ram: 2 });
    expect(PROFILE_DETAILS.aeon.recommended).toMatchObject({ cpu: 0.5, ram: 1 });
    expect(PROFILE_DETAILS["agent-zero"].recommended).toMatchObject({ cpu: 2, ram: 4 });
  });
});

describe("a launch without a receipt is only ever looked for again, never resent", () => {
  it("returns the agent the lost request created, found by exact name and runtime", async () => {
    const draft = draftFor("claude-code", { submittedAt: "2026-09-24T10:00:00.000Z" });
    jest.mocked(createAgent).mockRejectedValue(new Error("Failed to fetch"));
    jest.mocked(listAgentsResult).mockResolvedValue({ error: null, agents: [
      // An older agent of the owner with the same name is never taken for it.
      created("claude-code", { id: "old", name: "Claude Code 1", created_at: "2026-09-20T10:00:00.000Z" } as Partial<HivraAgent>),
      created("codex", { id: "other-runtime", name: "Claude Code 1", created_at: "2026-09-24T10:00:05.000Z" } as Partial<HivraAgent>),
      created("claude-code", { id: AGENT_ID, name: "Claude Code 1", created_at: "2026-09-24T10:00:03.000Z" } as Partial<HivraAgent>),
    ] });

    await expect(submitLaunchDraft(draft, MANAGED)).resolves.toMatchObject({ id: AGENT_ID });
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("stays uncertain when it can't see what the request created", async () => {
    jest.mocked(createAgent).mockRejectedValue(new Error("Failed to fetch"));
    jest.mocked(listAgentsResult).mockResolvedValue({ error: null, agents: [] });

    await expect(submitLaunchDraft(draftFor("openclaw"), MANAGED)).rejects.toBeInstanceOf(HivraLaunchInProgressError);
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("reports a computer whose setup stopped as something to open and delete", async () => {
    const draft = draftFor("aeon");
    jest.mocked(listAgentsResult).mockResolvedValue({ error: null, agents: [
      created("aeon", { name: "Aeon 1", status: "error", error: "Install failed", created_at: new Date().toISOString() } as Partial<HivraAgent>),
    ] });

    const error = await reconcileLaunchDraft(draft).catch(caught => caught);
    expect(error).toBeInstanceOf(HivraLaunchCorrectableError);
    expect(error).toMatchObject({ computerId: AGENT_ID, code: "launch_partial" });
  });

  it("passes a server rejection straight through without looking", async () => {
    jest.mocked(createAgent).mockRejectedValue(new HivraLaunchCorrectableError("Your plan has no open agent slots.", 403));
    await expect(submitLaunchDraft(draftFor("agent-zero"), MANAGED)).rejects.toBeInstanceOf(HivraLaunchCorrectableError);
    expect(listAgentsResult).not.toHaveBeenCalled();
  });

  it("checks receipt-bearing launches by their receipt and the rest by what they created", async () => {
    jest.mocked(findHivraLaunchReceipt).mockResolvedValue({ state: "accepted", phase: "accepted", agent: created("codex") });
    await expect(reconcileLaunchDraft(draftFor("codex"))).resolves.toMatchObject({ id: AGENT_ID });
    expect(launchResumeMode("codex")).toBe("resend");
    for (const profileId of ["claude-code", "hermes", "openclaw", "agent-zero", "aeon"] as const) {
      expect(launchResumeMode(profileId)).toBe("observe");
    }
  });
});

describe("Codex with a model key or Hivra credits", () => {
  const shared = { resources: { cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1, source: "recommended" as const }, browser: false };

  function legacyWelcomeBody(llm: { mode: "byok"; model: string } | { mode: "managed"; model: string; walletType: "card" | "hermesos" }, apiKey: string) {
    // The body the retired welcome form's Codex model launch sent.
    return legacyCodexModelBody({
      agentName: "Codex 1", cpu: 0.5, ram: 1, browser: false, deployment: MANAGED,
      llm: llm.mode === "byok" ? { ...llm, apiKey } : llm,
      requestId: "66666666-6666-4666-8666-666666666666",
    });
  }

  it("sends Hivra credits with the model exactly as the welcome form, plus the journey's receipt and size", async () => {
    const legacy = legacyWelcomeBody({ mode: "managed", model: "deepseek-v4-pro", walletType: "hermesos" }, "");
    jest.mocked(createAgent).mockResolvedValue(created("codex"));
    const draft = draftFor("codex", shared, { mode: "credits", source: "custom", model: "deepseek-v4-pro" });

    await submitLaunchDraft(draft, MANAGED, { balance: TOKEN_ONLY });

    const sent = wire(jest.mocked(createAgent).mock.calls[0][0]);
    expect(sent).toEqual({ ...legacy, launchRequestId: draft.launchRequestId, maximumCpu: 0.5, maximumRam: 1 });
  });

  it("sends a pasted key exactly as the welcome form when the owner doesn't save it", async () => {
    const legacy = legacyWelcomeBody({ mode: "byok", model: "deepseek-v4-pro" }, "  synthetic-venice-key  ");
    jest.mocked(createAgent).mockResolvedValue(created("codex"));
    const draft = draftFor("codex", shared, { mode: "api-key", source: "custom", keySource: "paste", saveKey: false });

    await submitLaunchDraft(draft, MANAGED, { apiKey: "  synthetic-venice-key  " });

    expect(wire(jest.mocked(createAgent).mock.calls[0][0])).toEqual({
      ...legacy, launchRequestId: draft.launchRequestId, maximumCpu: 0.5, maximumRam: 1,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it("saves a pasted key in the Vault when asked, then launches with the saved key", async () => {
    route(url => url === "/api/vault", () => json(200, { success: true, data: { id: VAULT_KEY_ID } }));
    jest.mocked(createAgent).mockResolvedValue(created("codex"));
    const onKeySaved = jest.fn();
    const draft = draftFor("codex", shared, { mode: "api-key", source: "custom", keySource: "paste", saveKey: true });

    await submitLaunchDraft(draft, MANAGED, { apiKey: "synthetic-venice-key", onKeySaved });

    expect(bodyOf(fetchCalls[0])).toEqual({ name: "Venice AI", provider: "venice", key: "synthetic-venice-key" });
    expect(onKeySaved).toHaveBeenCalledWith(VAULT_KEY_ID, expect.objectContaining({ id: VAULT_KEY_ID, provider: "venice", key_preview: "synthe...-key" }));
    const input = jest.mocked(createAgent).mock.calls[0][0];
    expect(input.llm).toEqual({ provider: "venice", mode: "byok", model: "deepseek-v4-pro", vaultKeyId: VAULT_KEY_ID });
    expect(JSON.stringify(input)).not.toContain("synthetic-venice-key");
  });

  it("sends a saved key only after the owner confirmed it for this launch", async () => {
    const unconfirmed = draftFor("codex", shared, { mode: "api-key", source: "custom", keySource: "saved", vaultKeyId: VAULT_KEY_ID, sendSavedKey: false });
    await expect(submitLaunchDraft(unconfirmed, MANAGED)).rejects.toMatchObject({ code: "model_key_consent" });
    expect(createAgent).not.toHaveBeenCalled();

    jest.mocked(createAgent).mockResolvedValue(created("codex"));
    await submitLaunchDraft({ ...unconfirmed, modelAccess: { ...unconfirmed.modelAccess, sendSavedKey: true } }, MANAGED);
    expect(jest.mocked(createAgent).mock.calls[0][0].llm).toEqual({
      provider: "venice", mode: "byok", model: "deepseek-v4-pro", vaultKeyId: VAULT_KEY_ID,
    });
  });

  it("asks for a pasted key again rather than launching without one", async () => {
    const draft = draftFor("codex", shared, { mode: "api-key", source: "custom", keySource: "paste" });
    await expect(submitLaunchDraft(draft, MANAGED, { apiKey: "  " })).rejects.toMatchObject({ code: "model_key_missing" });
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("Hermes launches through its instance lane as the welcome deploy form did", () => {
  const legacyBase = {
    agentName: "Hermes 1",
    selectedProviderId: "venice",
    model: "deepseek-v4-flash",
    customBaseUrl: "",
    managedVeniceWalletType: "card" as const,
    apiKey: "",
    honchoApiKey: "",
    fingerprintRequestId: "fp-request-1",
    cpuLimit: 2,
    deployRamGb: 4,
  };
  const hermesResources = { resources: { cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, source: "recommended" as const } };
  const acceptInstance = () => route(
    (url, init) => url === "/api/instances" && init?.method === "POST",
    () => json(200, { success: true, data: { id: AGENT_ID, name: "Hermes 1", status: "provisioning" } }),
  );

  it("sends a Hermes that sets itself up exactly as Managed off did", async () => {
    acceptInstance();
    await expect(submitLaunchDraft(draftFor("hermes", hermesResources), MANAGED)).resolves.toEqual({ id: AGENT_ID, name: "Hermes 1", status: "provisioning" });
    expect(bodyOf(fetchCalls[0])).toEqual(legacyHermesDeployBody({ ...legacyBase, cleanSlateDeploy: true, managedVeniceDeploy: false }));
  });

  it("bills the funded wallet with Hivra credits exactly as managed Venice did", async () => {
    acceptInstance();
    const draft = draftFor("hermes", hermesResources, { mode: "credits", source: "recommended" });
    await submitLaunchDraft(draft, MANAGED, { balance: TOKEN_ONLY });
    expect(bodyOf(fetchCalls[0])).toEqual(legacyHermesDeployBody({
      ...legacyBase, cleanSlateDeploy: false, managedVeniceDeploy: true, managedVeniceWalletType: "hermesos",
    }));
  });

  it("sends a saved provider key and the saved memory key only with the owner's consent", async () => {
    acceptInstance();
    const savedKeys = [
      { id: VAULT_KEY_ID, provider: "openrouter", name: "OpenRouter", key_preview: "sk-or-...3f2a" },
      { id: HONCHO_KEY_ID, provider: "honcho", name: "Honcho", key_preview: "honcho...9d1c" },
    ];
    const access = { mode: "api-key" as const, source: "custom" as const, provider: "openrouter", keySource: "saved" as const, vaultKeyId: VAULT_KEY_ID, sendSavedKey: true };

    await submitLaunchDraft(draftFor("hermes", { ...hermesResources, sendMemoryKey: true }, access), MANAGED, { savedKeys });
    expect(bodyOf(fetchCalls[0])).toEqual(legacyHermesDeployBody({
      ...legacyBase, cleanSlateDeploy: false, managedVeniceDeploy: false, selectedProviderId: "openrouter",
      model: "openai/gpt-5.4-pro", resolvedVaultKeyId: VAULT_KEY_ID, resolvedHonchoVaultKeyId: HONCHO_KEY_ID,
    }));

    await submitLaunchDraft(draftFor("hermes", { ...hermesResources, sendMemoryKey: false }, access), MANAGED, { savedKeys });
    expect(bodyOf(fetchCalls[1])).not.toHaveProperty("honchoVaultKeyId");
  });

  it("offers the card check when Hivra asks for a card", async () => {
    route(() => true, () => json(402, { success: false, error: "Add a card to launch on Free.", reason: "card_required" }));
    const error = await submitLaunchDraft(draftFor("hermes", hermesResources), MANAGED).catch(caught => caught);
    expect(error).toBeInstanceOf(LaunchCorrectableError);
    expect(error.action).toEqual({ kind: "verify-card" });
    expect(error.message).toBe("Add a card to launch on Free.");
  });

  it("offers the owner's existing agent when the plan holds only one", async () => {
    route(() => true, () => json(403, {
      success: false, error: "Your Free plan includes one agent.", code: "FREE_INSTANCE_LIMIT_REACHED", existingInstanceId: "77777777-7777-4777-8777-777777777777",
    }));
    const error = await submitLaunchDraft(draftFor("hermes", hermesResources), MANAGED).catch(caught => caught);
    expect(error).toBeInstanceOf(LaunchCorrectableError);
    expect(error.action).toEqual({ kind: "open", label: "Open your agent", href: "/dashboard/instances/77777777-7777-4777-8777-777777777777" });
  });

  it("finds the agent a lost connection created instead of reporting a failure", async () => {
    const submittedAt = "2026-09-24T10:00:00.000Z";
    route((url, init) => url === "/api/instances" && init?.method === "POST", () => { throw new TypeError("Failed to fetch"); });
    route(url => url === "/api/instances", () => json(200, { success: true, data: [
      { id: "failed", name: "Hermes 1", status: "failed", created_at: "2026-09-24T10:00:02.000Z" },
      { id: "older", name: "Hermes 1", status: "running", created_at: "2026-09-01T10:00:00.000Z" },
      { id: AGENT_ID, name: "Hermes 1", status: "provisioning", created_at: "2026-09-24T10:00:03.000Z" },
    ] }));

    await expect(submitLaunchDraft(draftFor("hermes", { ...hermesResources, submittedAt }), MANAGED))
      .resolves.toEqual({ id: AGENT_ID, name: "Hermes 1", status: "provisioning" });
    expect(fetchCalls.filter(call => call.init?.method === "POST")).toHaveLength(1);
  });

  it("stays uncertain when a lost connection left nothing visible yet", async () => {
    route((url, init) => url === "/api/instances" && init?.method === "POST", () => { throw new TypeError("Failed to fetch"); });
    route(url => url === "/api/instances", () => json(200, { success: true, data: [] }));
    await expect(submitLaunchDraft(draftFor("hermes", hermesResources), MANAGED)).rejects.toBeInstanceOf(HivraLaunchInProgressError);
  });

  it("reports a server failure that created nothing as a stopped launch", async () => {
    route((url, init) => url === "/api/instances" && init?.method === "POST", () => json(500, { success: false, error: "No capacity right now.", failureType: "provision_host_failure" }));
    route(url => url === "/api/instances", () => json(200, { success: true, data: [] }));
    await expect(submitLaunchDraft(draftFor("hermes", hermesResources), MANAGED)).rejects.toBeInstanceOf(HivraLaunchRejectedError);
  });

  it("never sends Hermes to a server the owner connected", async () => {
    await expect(submitLaunchDraft(draftFor("hermes", hermesResources), SELF_MANAGED)).rejects.toMatchObject({ code: "hermes_managed_only" });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("a launch started from a saved template", () => {
  const TEMPLATE = { id: "77777777-7777-4777-8777-777777777777", name: "Research Bot" };

  it.each(["claude-code", "codex", "openclaw", "agent-zero", "aeon"] as const)(
    "names the template in the %s launch so the server forks it", async (profileId) => {
      jest.mocked(createAgent).mockResolvedValue(created(PROFILE_DETAILS[profileId].runtimeId));
      await submitLaunchDraft(draftFor(profileId, { template: TEMPLATE }), MANAGED);
      expect(jest.mocked(createAgent).mock.calls[0][0]).toMatchObject({ templateId: TEMPLATE.id });
    },
  );

  it("names the template in a Codex launch on Hivra credits too", async () => {
    jest.mocked(createAgent).mockResolvedValue(created("codex"));
    await submitLaunchDraft(
      draftFor("codex", { template: TEMPLATE }, { mode: "credits", source: "custom" }),
      MANAGED,
      { balance: { state: "known", cardMicroUsd: 5_000_000, hermesosMicroUsd: 0 } },
    );
    expect(jest.mocked(createAgent).mock.calls[0][0]).toMatchObject({ templateId: TEMPLATE.id, llm: { mode: "managed" } });
  });

  it("sends no template field at all for a launch that isn't from one", async () => {
    jest.mocked(createAgent).mockResolvedValue(created("claude-code"));
    await submitLaunchDraft(draftFor("claude-code"), MANAGED);
    expect(jest.mocked(createAgent).mock.calls[0][0]).not.toHaveProperty("templateId");
  });
});

describe("each runtime opens its own surface", () => {
  it.each([
    ["claude-code", "native", `/dashboard/agent/${AGENT_ID}?welcome=1&tab=terminal`],
    ["codex", "native", `/dashboard/agent/${AGENT_ID}?welcome=1&tab=terminal`],
    ["codex", "credits", `/dashboard/agent/${AGENT_ID}?welcome=1&tab=manage#model-settings`],
    ["openclaw", "credits", `/dashboard/agent/${AGENT_ID}?welcome=1&tab=aeon`],
    ["agent-zero", "native", `/dashboard/agent/${AGENT_ID}?welcome=1&tab=aeon`],
    ["aeon", "native", `/dashboard/agent/${AGENT_ID}?welcome=1&tab=aeon`],
    ["hermes", "native", `/dashboard/instances/${AGENT_ID}?surface=chat&welcome=1`],
    ["hermes", "credits", `/dashboard/instances/${AGENT_ID}?surface=chat&welcome=1`],
  ] as const)("opens %s (%s) where its form did", (profileId, mode, href) => {
    expect(launchResultHref(draftFor(profileId, {}, { mode }), AGENT_ID)).toBe(href);
  });

  it("sends a Hermes on a Nous sign-in to its tool gateway setup", () => {
    expect(launchResultHref(draftFor("hermes", {}, { mode: "api-key", provider: "nous" }), AGENT_ID))
      .toBe(`/dashboard/instances/${AGENT_ID}?focus=nous-tool-gateway&surface=chat&welcome=1`);
  });

  it("keeps Hermes in the journey until its workspace answers", () => {
    expect(opensOnAcceptance("hermes")).toBe(false);
    expect(opensOnAcceptance("claude-code")).toBe(true);
  });
});
