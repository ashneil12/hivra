/** @jest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { WelcomeFlow, TierPickerCards } from "../WelcomeFlow";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";
import { redirectToCheckoutUrl } from "@/lib/billing/client";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
} from "@/lib/infrastructure/portable-provisioner-contract";
import { resolvePersonaSoulFromSystemPrompt } from "@/lib/persona-souls-accessor";
import posthog from "posthog-js";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockGet = jest.fn();
const mockGetFingerprintRequestId = jest.fn();
const mockClientLogWarn = jest.fn();
const mockClientLogError = jest.fn();
let mockUserId: string | null = "user_model_launch";
jest.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: mockUserId, isLoaded: true }) }));

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  useSearchParams: () => ({
    get: mockGet,
    getAll: (key: string) => { const value = mockGet(key); return value === null ? [] : [value]; },
    toString: () => {
      const params = new URLSearchParams();
      for (const key of ['step', 'agentType', 'subscription', 'targetId']) { const value = mockGet(key); if (value !== null) params.set(key, value); }
      return params.toString();
    },
  }),
}));

jest.mock("framer-motion", () => {
  const passthrough = (Tag: string) => {
    const Comp = React.forwardRef<HTMLElement, Record<string, unknown>>(
      ({ children, ...rest }, ref) => {
        // Drop framer-only props so they don't hit the DOM.
        const { initial, animate, exit, variants, transition, whileInView, viewport, ...domProps } =
          rest as Record<string, unknown>;
        void initial; void animate; void exit; void variants; void transition; void whileInView; void viewport;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(Tag, { ref, ...domProps } as any, children as React.ReactNode);
      }
    );
    Comp.displayName = `Motion(${Tag})`;
    return Comp;
  };

  return {
    motion: {
      div: passthrough("div"),
      section: passthrough("section"),
      span: passthrough("span"),
      h2: passthrough("h2"),
      p: passthrough("p"),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
  };
});

jest.mock("@/components/InteractiveBackground", () => {
  function MockInteractiveBackground() {
    return <div data-testid="interactive-background" />;
  }

  return MockInteractiveBackground;
});

jest.mock("@/components/billing/FreeTierCardVerification", () => ({
  FreeTierCardVerification: () => null,
}));

jest.mock("@/components/ui/animate-in", () => ({
  AnimateIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/lib/billing/client", () => {
  const actual = jest.requireActual("@/lib/billing/client");
  return {
    ...actual,
    redirectToCheckoutUrl: jest.fn(() => ({ ok: true })),
  };
});

jest.mock("@/lib/hooks/usePreferredProviderModels", () => ({
  usePreferredProviderModels: ({ staticModels }: { staticModels: Array<{ value: string; label: string }> }) => ({
    modelOptions: staticModels,
    hasLiveModels: false,
    isLoading: false,
    error: "",
  }),
}));

jest.mock("@/lib/abuse/client-fingerprint", () => ({
  getFingerprintRequestId: () => mockGetFingerprintRequestId(),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockClientLogWarn(...args),
    error: (...args: unknown[]) => mockClientLogError(...args),
  },
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

describe("WelcomeFlow", () => {
  const fetchMock = jest.fn();
  const fundedManagedVeniceSummary = {
    wallets: {
      hermesos: {
        tokenDisplay: "1,039,502 Hivra",
        lockedValueMicroUsd: 12_000_000,
        availableMicroUsd: 12_000_000,
        reservedMicroUsd: 0,
        lots: [],
      },
      card: {
        balanceMicroUsd: 0,
        availableMicroUsd: 0,
        reservedMicroUsd: 0,
      },
    },
    discount: {
      rate: "launch_20",
      discountBps: 2000,
      launchSubsidyUsedMicroUsd: 2_000_000,
      launchSubsidyCapMicroUsd: 250_000_000,
    },
    killSwitch: {
      active: false,
      weeklySubsidyUsedMicroUsd: 2_000_000,
      thresholdMicroUsd: 1_000_000_000,
    },
    keys: [],
  };

  // A confirmed-$0 balance. A failed/unparseable summary reads as "balance
  // unknown", which intentionally does NOT show the funding wall — tests that
  // exercise the wall must mock a known zero.
  const zeroManagedVeniceSummary = {
    ...fundedManagedVeniceSummary,
    wallets: {
      hermesos: {
        ...fundedManagedVeniceSummary.wallets.hermesos,
        tokenDisplay: "0",
        lockedValueMicroUsd: 0,
        availableMicroUsd: 0,
      },
      card: { ...fundedManagedVeniceSummary.wallets.card },
    },
  };

  function jsonResponse(data: Record<string, unknown>) {
    return {
      ok: true,
      status: 200,
      json: async () => data,
    } as Response;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: jest.fn(() => "11111111-1111-4111-8111-111111111111") });
    mockUserId = "user_model_launch";
    mockGet.mockImplementation((key: string) => {
      if (key === "step") return "deploy";
      return null;
    });
    mockGetFingerprintRequestId.mockResolvedValue("fp_req_123");
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/vault") {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              subscribed: true,
              usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
              plan: { totalCpu: 2, totalRam: 4096 },
            },
          })
        );
      }
      if (url === "/api/instances") {
        return Promise.resolve(jsonResponse({ success: true, data: { id: "inst-nous" } }));
      }
      if (url === "/api/instances/inst-nous") {
        return Promise.resolve(jsonResponse({ success: true, data: { id: "inst-nous" } }));
      }
      if (url === "/api/infrastructure/targets") {
        return Promise.resolve(jsonResponse({ success: true, data: { targets: [] } }));
      }
      if (url === "/api/hivra/agents") {
        const launchRequestId = init?.method === "POST" && typeof init.body === "string"
          ? JSON.parse(init.body).launchRequestId as string | undefined
          : undefined;
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            ...(launchRequestId ? {
              launchRequestId,
              launch: { state: "accepted", phase: "accepted" },
            } : {}),
            agent: {
              id: "agent-claude",
              type: "claude-code",
              name: "CLAUDE_CODE_AGENT",
              status: "provisioning",
              cpu: 2,
              ram: 4,
            },
            agents: [],
          },
        }));
      }
      if (url === "/api/hivra/agents/agent-claude/action") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            agent: {
              id: "agent-claude",
              type: "claude-code",
              name: "CLAUDE_CODE_AGENT",
              status: "provisioning",
              cpu: 2,
              ram: 4,
              goal: "build",
            },
          },
        }));
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/billing/managed-venice/card/top-up") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: { url: "https://checkout.stripe.test/managed-venice-card" },
        }));
      }
      if (url === "/api/billing/managed-venice/hermesos/quote") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            id: "mvq_1",
            tokenAmountRaw: "1000000000000000000000",
            tokenSymbol: "Hivra",
            tokenDecimals: 18,
            snapshotPriceUsd: "0.05",
            paidValueMicroUsd: 50_000_000,
            creditValueMicroUsd: 60_000_000,
            bonusValueMicroUsd: 10_000_000,
            depositAddress: "0x000000000000000000000000000000000000feed",
            expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
            status: "active",
          },
        }));
      }
      if (url === "/api/billing/managed-venice/hermesos/check") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            status: "no_match",
            quote: {
              id: "mvq_1",
              tokenAmountRaw: "1000000000000000000000",
              tokenSymbol: "Hivra",
              tokenDecimals: 18,
              snapshotPriceUsd: "0.05",
              paidValueMicroUsd: 50_000_000,
              creditValueMicroUsd: 60_000_000,
              bonusValueMicroUsd: 10_000_000,
              depositAddress: "0x000000000000000000000000000000000000feed",
              expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
              status: "active",
            },
          },
        }));
      }

      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });
  });

  // The real multi-agent catalog is the default onboarding surface. Specialists
  // remain a secondary tab over the same deploy lanes. These helpers explicitly
  // select the lane they need so tests remain clear when they navigate back.
  async function chooseHermesAgent() {
    // "Bea — Assistant" maps to the general (Hermes Agent) lane.
    const specialistsTab = await screen.findByRole("tab", { name: /^specialists$/i });
    if (specialistsTab.getAttribute("aria-selected") !== "true") {
      fireEvent.click(specialistsTab);
    }
    fireEvent.click(await screen.findByRole("button", { name: /^bea — assistant/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue to (plan|deploy)/i }));
  }

  async function chooseAdvancedAgent(name: RegExp) {
    const agentsTab = await screen.findByRole("tab", { name: /^agents$/i });
    if (agentsTab.getAttribute("aria-selected") !== "true") {
      fireEvent.click(agentsTab);
    }
    fireEvent.click(await screen.findByRole("button", { name: name }));
  }

  async function chooseClaudeCodeAgent() {
    // Claude Code is a first-class card in the default Agents catalog.
    await chooseAdvancedAgent(/^claude code — coding agent/i);
  }

  it("launches Codex with a Venice key on the original computer, without persisting or logging the key", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    const agentId = "22222222-2222-4222-8222-222222222222";
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/hivra/agents" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(jsonResponse({ success: true, data: { launchRequestId: body.launchRequestId,
          agent: { id: agentId, type: "codex", name: body.name, cpu: 2, ram: 4, status: "provisioning" } } }));
      }
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    await chooseAdvancedAgent(/^codex — coding agent/i);
    fireEvent.click(await screen.findByRole("button", { name: /^my venice api key/i }));
    expect(screen.getByRole("button", { name: /^launch ·/i })).toBeDisabled();
    const secret = "synthetic-venice-ui-key";
    fireEvent.change(screen.getByLabelText(/^venice api key/i), { target: { value: secret } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^launch ·/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^launch ·/i }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/dashboard/agent/${agentId}?welcome=1&tab=manage#model-settings`));
    const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST");
    expect(JSON.parse(post![1].body)).toMatchObject({ type: "codex", llm: { provider: "venice", mode: "byok", apiKey: secret }, launchRequestId: expect.any(String) });
    expect(JSON.stringify(window.sessionStorage)).not.toContain(secret);
    expect(JSON.stringify(window.localStorage)).not.toContain(secret);
    expect(JSON.stringify(jest.mocked(posthog.capture).mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mockClientLogError.mock.calls)).not.toContain(secret);
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });

  it.each([false, true])("retains a lost model launch across handoff changes=%s without sending the key again", async withHandoff => {
    const baseFetch = fetchMock.getMockImplementation();
    const agentId = "22222222-2222-4222-8222-222222222222";
    const target = providerVmTarget(); target.status = 'ready'; target.lastErrorCode = null;
    target.capabilities.launchReady = true; target.capabilities.provisioner.ready = true;
    let targetHint = target.id;
    if (withHandoff) mockGet.mockImplementation(key => key === 'step' ? 'agent-type' : key === 'targetId' ? targetHint : null);
    let requestId = "";
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (withHandoff && String(input) === '/api/infrastructure/targets') return Promise.resolve(jsonResponse({ success: true, data: { targets: [target] } }));
      if (String(input) === "/api/hivra/agents" && init?.method === "POST") {
        requestId = JSON.parse(String(init.body)).launchRequestId;
        return Promise.reject(new Error("synthetic-secret-echo"));
      }
      if (String(input).startsWith("/api/hivra/agent-launches/")) return Promise.resolve(jsonResponse({ success: true,
        data: { launchRequestId: requestId, agent: { id: agentId, type: "codex", name: "ORIGINAL", status: "provisioning", cpu: 2, ram: 4 } } }));
      return baseFetch!(input, init);
    });
    const view = render(<WelcomeFlow />);
    await chooseAdvancedAgent(/^codex — coding agent/i);
    fireEvent.click(await screen.findByRole("button", { name: /^my venice api key/i }));
    fireEvent.change(screen.getByLabelText(/^venice api key/i), { target: { value: "synthetic-secret-echo" } });
    const launchName = withHandoff ? /^Launch on this computer$/i : /^launch ·/i;
    await waitFor(() => expect(screen.getByRole("button", { name: launchName })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: launchName }));
    await screen.findByText(/Launch could not be confirmed/);
    if (withHandoff) {
      targetHint = '99999999-9999-4999-8999-999999999999';
      view.rerender(<WelcomeFlow />);
      const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/hivra/agents' && init?.method === 'POST');
      expect(JSON.parse(String(post![1].body)).deployment.targetId).toBe(target.id);
    }
    expect(screen.queryByText(/synthetic-secret-echo/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/re-enter your venice/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: /retry saved launch/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /native sign-in/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /check saved launch/i }));
    fireEvent.click(await screen.findByRole("button", { name: /open original computer/i }));
    expect(mockPush).toHaveBeenCalledWith(`/dashboard/agent/${agentId}?tab=manage#model-settings`);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST")).toHaveLength(1);
  });

  it("keeps model credits distinct from hosting and never forwards a discarded BYOK draft", async () => {
    render(<WelcomeFlow />);
    await chooseAdvancedAgent(/^codex — coding agent/i);
    fireEvent.click(await screen.findByRole("button", { name: /^my venice api key/i }));
    fireEvent.change(screen.getByLabelText(/^venice api key/i), { target: { value: "discarded-synthetic-key" } });
    fireEvent.click(screen.getByRole("button", { name: /^hivra model credits/i }));
    expect(screen.queryByDisplayValue("discarded-synthetic-key")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/model usage wallet/i)).toHaveValue("card");
    expect(screen.getByText(/does not purchase credits/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /^launch ·/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^launch ·/i }));
    await screen.findByText(/Launch could not be confirmed/);
    const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST");
    expect(JSON.parse(post![1].body).llm).toEqual({ provider: "venice", mode: "managed", model: "deepseek-v4-pro", walletType: "card" });
    expect(post![1].body).not.toContain("discarded-synthetic-key");
  });

  it("does not make native Codex launch depend on session storage", async () => {
    const broken = jest.spyOn(Storage.prototype, "getItem");
    const original = Storage.prototype.getItem;
    broken.mockImplementation(function (this: Storage, name: string) {
      if (name.startsWith("hivra:codex-model-launch:")) throw new Error("Storage blocked");
      // Other welcome drafts can still be read by the legacy flow.
      return null;
    });
    void original;
    try {
      render(<WelcomeFlow />);
      await chooseAdvancedAgent(/^codex — coding agent/i);
      await waitFor(() => expect(screen.getByRole("button", { name: /^launch ·/i })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: /^launch ·/i }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST")).toBe(true));
      const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST");
      expect(JSON.parse(post![1].body)).not.toHaveProperty("llm");
      expect(JSON.parse(post![1].body)).toHaveProperty("launchRequestId", "11111111-1111-4111-8111-111111111111");
    } finally { broken.mockRestore(); }
  });

  it("reuses the same receipt when the native Codex acknowledgement is lost", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    const requestIds: string[] = [];
    let attempts = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/hivra/agents" && init?.method === "POST") {
        attempts += 1;
        const body = JSON.parse(String(init.body));
        requestIds.push(body.launchRequestId);
        if (attempts === 1) return Promise.reject(new Error("lost acknowledgement"));
        return Promise.resolve(jsonResponse({ success: true, data: {
          launchRequestId: body.launchRequestId,
          launch: { state: "accepted", phase: "accepted" },
          agent: { id: "agent-native-replay", type: "codex", name: body.name, cpu: body.cpu, ram: body.ram, status: "provisioning" },
        } }));
      }
      return baseFetch!(input, init);
    });

    const firstView = render(<WelcomeFlow />);
    await chooseAdvancedAgent(/^codex — coding agent/i);
    const launch = await screen.findByRole("button", { name: /^launch ·/i });
    await waitFor(() => expect(launch).toBeEnabled());
    fireEvent.click(launch);
    await waitFor(() => expect(requestIds).toHaveLength(1));
    firstView.unmount();

    render(<WelcomeFlow />);
    const resumedLaunch = await screen.findByRole("button", { name: /^launch ·/i });
    await waitFor(() => expect(resumedLaunch).toBeEnabled());
    fireEvent.click(resumedLaunch);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(
      "/dashboard/agent/agent-native-replay?welcome=1&tab=terminal",
    ));
    expect(requestIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("allows explicit same-ID revisions but requires reconfirming hosting and excludes native bypass", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/hivra/agents" && init?.method === "POST") return Promise.reject(new Error("Lost response"));
      if (String(input).startsWith("/api/hivra/agent-launches/")) return Promise.resolve({ ok: false, status: 404 } as Response);
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    await chooseAdvancedAgent(/^codex — coding agent/i);
    fireEvent.click(await screen.findByRole("button", { name: /^my venice api key/i }));
    fireEvent.change(screen.getByLabelText(/^venice api key/i), { target: { value: "synthetic-model-key" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^launch ·/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^launch ·/i }));
    await screen.findByText(/Launch could not be confirmed/);
    fireEvent.click(screen.getByRole("button", { name: /review launch choices/i }));
    expect(screen.getByRole("button", { name: /native sign-in/i })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Codex Name" }), { target: { value: "REVISED_CODEX" } });
    fireEvent.change(screen.getByLabelText(/re-enter your venice/i), { target: { value: "synthetic-reentered-key" } });
    expect(screen.getByRole("button", { name: /retry saved launch/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Use the hosting, resources and model/i }));
    expect(screen.getByRole("button", { name: /retry saved launch/i })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Codex Name" }), { target: { value: "REVISED_AGAIN" } });
    expect(screen.getByRole("checkbox", { name: /Use the hosting, resources and model/i })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /Use the hosting, resources and model/i }));
    fireEvent.click(screen.getByRole("button", { name: /retry saved launch/i }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST")).toHaveLength(2));
    const bodies = fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST").map(([, init]) => JSON.parse(init.body));
    expect(bodies[0].launchRequestId).toBe(bodies[1].launchRequestId);
    expect(bodies[1].name).toBe("REVISED_AGAIN");
  });

  it("discards a late model launch on account change and clears the secret draft", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    let finish!: (response: Response) => void;
    let requestId = "";
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/hivra/agents" && init?.method === "POST") {
        requestId = JSON.parse(String(init.body)).launchRequestId;
        return new Promise(resolve => { finish = resolve; });
      }
      return baseFetch!(input, init);
    });
    const { rerender } = render(<WelcomeFlow />);
    await chooseAdvancedAgent(/^codex — coding agent/i);
    fireEvent.click(await screen.findByRole("button", { name: /^my venice api key/i }));
    fireEvent.change(screen.getByLabelText(/^venice api key/i), { target: { value: "synthetic-secret-key" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^launch ·/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^launch ·/i }));
    mockUserId = "different_user"; rerender(<WelcomeFlow />);
    expect(screen.queryByDisplayValue("synthetic-secret-key")).not.toBeInTheDocument();
    finish(jsonResponse({ success: true, data: { launchRequestId: requestId,
      agent: { id: "22222222-2222-4222-8222-222222222222", type: "codex", name: "OLD_OWNER", status: "provisioning", cpu: 2, ram: 4 } } }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^launch ·/i })).toBeEnabled());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("keeps the default Agents catalog untouched until Specialists is deliberately opened", async () => {
    render(<WelcomeFlow />);

    // A hidden persona must not silently select/persist Hermes in the catalog.
    await screen.findByRole("button", { name: /^claude code — coding agent/i });
    const agentCards = screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-pressed"));
    expect(agentCards.length).toBeGreaterThan(0);
    for (const card of agentCards) expect(card).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem("hermes:welcome_agent_type")).toBeNull();
    expect(posthog.capture).not.toHaveBeenCalledWith(
      "welcome_persona_selected",
      expect.objectContaining({ preselected: true }),
    );

    // Deliberately opening Specialists activates the zero-reading Bea default.
    fireEvent.click(await screen.findByRole("tab", { name: /^specialists$/i }));
    const bea = await screen.findByRole("button", { name: /^bea — assistant/i });
    await waitFor(() => expect(bea).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByRole("button", { name: /continue to (plan|deploy)/i })).toBeInTheDocument();

    // Funnel hygiene: the auto-pick is flagged so pick-rate analyses can
    // exclude it — only human clicks count as persona choices.
    expect(posthog.capture).toHaveBeenCalledWith(
      "welcome_persona_selected",
      expect.objectContaining({ persona: "atlas", preselected: true }),
    );

    // A preselected default is not a user choice — it must never persist.
    expect(window.localStorage.getItem("hermes:welcome_persona")).toBeNull();
  });

  it("does not pre-select a persona when a stored persona pick already exists", async () => {
    // A prior explicit choice (persisted by a real click) wins over the default.
    window.localStorage.setItem("hermes:welcome_persona", "dev");
    render(<WelcomeFlow />);

    fireEvent.click(await screen.findByRole("tab", { name: /^specialists$/i }));
    const bea = await screen.findByRole("button", { name: /^bea — assistant/i });
    expect(bea).toHaveAttribute("aria-pressed", "false");
    expect(posthog.capture).not.toHaveBeenCalledWith(
      "welcome_persona_selected",
      expect.objectContaining({ preselected: true }),
    );
  });

  it("defaults to the Agents tab and keeps Specialists available as a secondary path", async () => {
    render(<WelcomeFlow />);

    const agentsTab = await screen.findByRole("tab", { name: /^agents$/i });
    const specialistsTab = screen.getByRole("tab", { name: /^specialists$/i });
    expect(agentsTab).toHaveAttribute("aria-selected", "true");
    expect(specialistsTab).toHaveAttribute("aria-selected", "false");

    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();
    const hermesAgent = screen.getByRole("button", { name: /^hermes agent — general operator/i });
    expect(hermesAgent).toBeInTheDocument();
    expect(hermesAgent).toHaveAttribute("data-agent-type", "general");
    expect(hermesAgent).toHaveAttribute("data-testid", "welcome-agent-card");
    expect(screen.getByRole("button", { name: /^codex — coding agent/i })).toHaveAttribute(
      "data-agent-type",
      "codex",
    );
    expect(screen.getByRole("button", { name: /^codex — coding agent/i })).toHaveAttribute(
      "data-testid",
      "welcome-agent-card",
    );
    expect(screen.queryByTestId("hivra-preview-catalog")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /buzz/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /omarchy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^bea — assistant/i })).not.toBeInTheDocument();
  });

  it("advances an agent card into its identity-bound deploy form and CTA", async () => {
    render(<WelcomeFlow />);

    await chooseAdvancedAgent(/^codex — coding agent/i);

    expect(await screen.findByTestId("welcome-deploy-form")).toHaveAttribute(
      "data-agent-type",
      "codex",
    );
    const deployCta = screen.getByTestId("deploy-primary-cta");
    expect(deployCta).toHaveAccessibleName(/^launch ·/i);
    await waitFor(() => expect(deployCta).toBeEnabled());
  });

  it("bypasses hosted plans for a self-hosted operator and goes straight to computer setup", async () => {
    const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    mockGet.mockImplementation((key: string) => key === "step" ? "agent-type" : null);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/infrastructure/targets") {
        return Promise.resolve(jsonResponse({ success: true, data: { targets: [] } }));
      }
      if (url.startsWith("/api/billing/")) {
        return Promise.reject(new Error("hosted billing must not run in self-host mode"));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    try {
      render(<WelcomeFlow />);
      await chooseAdvancedAgent(/^codex — coding agent/i);

      expect(await screen.findByTestId("welcome-deploy-form")).toHaveAttribute(
        "data-agent-type",
        "codex",
      );
      expect(screen.queryByText(/pick your path/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /start free tier/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Hivra Cloud/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Connected host/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Hivra model credits/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/0 CPU \/ 0 GB measured/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Connect and prepare a host first/i)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith("/api/billing/usage");
      expect(fetchMock).not.toHaveBeenCalledWith("/api/billing/wallet/eligibility");
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previousMode;
    }
  });

  it("switches to Specialists and back, preserving the default specialist selection", async () => {
    render(<WelcomeFlow />);

    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^specialists$/i }));
    await screen.findByRole("button", { name: /^bea — assistant/i });
    expect(await screen.findByRole("button", { name: /continue to (plan|deploy)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^specialists$/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: /^agents$/i }));
    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^hermes agent — general operator/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^bea — assistant/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue to (plan|deploy)/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^agents$/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: /^specialists$/i }));
    const bea = await screen.findByRole("button", { name: /^bea — assistant/i });
    await waitFor(() => expect(bea).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByRole("button", { name: /continue to (plan|deploy)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^claude code — coding agent/i })).not.toBeInTheDocument();
  });

  // ── Persona-soul containment ──────────────────────────────────────────────
  // Bea is preselected for zero-reading first-runners, which seeds her authored
  // soul into the personalization draft. Picking an agent-type card clears the
  // persona SELECTION but used to leave that draft intact, so every card in the
  // catalog shipped Bea's soul as the BASE of its system prompt / SOUL.md — a
  // A catalog deploy booted as Bea in production.
  function hermesDeployPayload() {
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/instances" && init?.method === "POST"
    );
    return JSON.parse(String(createCall?.[1]?.body ?? "{}"));
  }

  async function deployHermesLane() {
    fireEvent.click(
      await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i })
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances",
        expect.objectContaining({ method: "POST" })
      );
    });
  }

  it("keeps the preselected persona's soul out of an agent-type-card deploy", async () => {
    render(<WelcomeFlow />);

    fireEvent.click(await screen.findByRole("tab", { name: /^specialists$/i }));
    // Bea auto-selects — seeding her soul — before we switch back to Agents.
    const bea = await screen.findByRole("button", { name: /^bea — assistant/i });
    await waitFor(() => expect(bea).toHaveAttribute("aria-pressed", "true"));

    await chooseAdvancedAgent(/^hermes agent — general operator/i);
    expect(screen.queryByText("Where it runs")).not.toBeInTheDocument();
    await deployHermesLane();

    const systemPrompt = String(hermesDeployPayload().agentSettings?.systemPrompt ?? "");
    // The same recognizer the server-side strip uses: a blank Hermes Agent must
    // carry no authored persona soul at all.
    expect(resolvePersonaSoulFromSystemPrompt(systemPrompt)).toBeNull();
    expect(systemPrompt).not.toMatch(/you are bea/i);
    expect(hermesDeployPayload().name).toBe("MY_FIRST_AGENT");
    expect(hermesDeployPayload().agentSettings?.enableRootAccess).toBe(false);
  });

  it("keeps the preselected persona's soul out of a Claude Code box launch", async () => {
    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("tab", { name: /^specialists$/i }));
    await screen.findByRole("button", { name: /^bea — assistant/i });

    await chooseClaudeCodeAgent();
    const launchButton = await screen.findByRole("button", { name: /launch · 2 CPU \/ 4 GB/i });
    await waitFor(() => expect(launchButton).toBeEnabled());
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/hivra/agents/agent-claude/action",
        expect.objectContaining({ method: "POST" })
      );
    });

    // The box lane seeds SOUL.md from soulPromptId/personality/emoji — none of
    // which belong to a box picked out of the agent-type catalog.
    const actionCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/hivra/agents/agent-claude/action" && init?.method === "POST"
    );
    const actionPayload = JSON.parse(String(actionCall?.[1]?.body ?? "{}"));
    expect(actionPayload.soulPromptId).toBeUndefined();
    expect(actionPayload.personality).toBeUndefined();
    expect(actionPayload.emoji).toBeUndefined();
    // The launch answers the user DID give still ride along.
    expect(actionPayload.goal).toBe("build");
  });

  it("still ships the persona's soul when the specialist itself is the pick", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await deployHermesLane();

    const systemPrompt = String(hermesDeployPayload().agentSettings?.systemPrompt ?? "");
    expect(resolvePersonaSoulFromSystemPrompt(systemPrompt)?.id).toBe("bea");
  });

  it("restores the persona soul when the user backs out of an agent-type card and picks a specialist", async () => {
    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("tab", { name: /^specialists$/i }));
    await screen.findByRole("button", { name: /^bea — assistant/i });

    // Into the catalog lane — the persona identity is dropped from the draft…
    await chooseAdvancedAgent(/^hermes agent — general operator/i);
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });

    // …then back out and make an EXPLICIT persona choice, which must re-seed it.
    fireEvent.click(screen.getByRole("button", { name: /back to agent choices/i }));
    await chooseHermesAgent();
    await deployHermesLane();

    const systemPrompt = String(hermesDeployPayload().agentSettings?.systemPrompt ?? "");
    expect(resolvePersonaSoulFromSystemPrompt(systemPrompt)?.id).toBe("bea");
  });

  it("asks for a deployable agent type before showing the card and keeps operator packs out of the starter catalog", async () => {
    render(<WelcomeFlow />);

    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^hermes agent — general operator/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^bea — assistant/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Plan active\. Choose the first agent you want to launch\./i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /crypto radar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /local website scout/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^deploy /i })).not.toBeInTheDocument();

    await chooseClaudeCodeAgent();

    // Advanced path seeds the catalog default box name for Claude Code.
    expect(await screen.findByDisplayValue("CLAUDE_CODE_AGENT")).toBeInTheDocument();
    expect(screen.getByLabelText("Claude Code Name")).toHaveValue("CLAUDE_CODE_AGENT");
    expect(screen.queryByText(/claude code selected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pro recommended/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/free recommended/i)).not.toBeInTheDocument();
    expect(screen.getByText(/official claude code cli from anthropic/i)).toBeInTheDocument();
    expect(screen.getByText(/sign in with your own anthropic account inside the CLI/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: /browser automation/i })).toHaveAttribute("aria-checked", "true");
    });
    expect(screen.getByRole("button", { name: /launch · 2 CPU \/ 4 GB/i })).toBeInTheDocument();
    expect(screen.queryByText(/chatgpt/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/codex/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hermes:welcome_agent_type")).toBe("claude-code");

    fireEvent.click(screen.getByRole("button", { name: /back to agent choices/i }));

    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^bea — assistant/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/choose a different first agent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^deploy /i })).not.toBeInTheDocument();

    // Re-advance to Claude Code through the default Agents catalog.
    await chooseClaudeCodeAgent();

    fireEvent.click(await screen.findByRole("button", { name: /launch · 2 CPU \/ 4 GB/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/hivra/agents",
        expect.objectContaining({ method: "POST" })
      );
    });

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/hivra/agents" && init?.method === "POST"
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload.type).toBe("claude-code");
    expect(payload.name).toBe("CLAUDE_CODE_AGENT");
    expect(payload.cpu).toBe(2);
    expect(payload.ram).toBe(4);
    expect(payload.browser).toBe(true);
    expect(payload.deployment).toEqual({ mode: "hivra-managed" });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/instances",
      expect.objectContaining({ method: "POST" })
    );
    expect(mockPush).toHaveBeenCalledWith("/dashboard/agent/agent-claude?welcome=1&tab=terminal");
  });

  it("defaults a large paid Hivra box plan to the recommended 2 CPU / 4 GB", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      if (url === "/api/billing/usage") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            subscribed: true,
            usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
            plan: {
              key: "command",
              name: "Command",
              maxAgents: 10,
              maxCpuPerAgent: 8,
              maxRamPerAgent: 16384,
              totalCpu: 8,
              totalRam: 16384,
            },
          },
        }));
      }
      if (url === "/api/infrastructure/targets") {
        return Promise.resolve(jsonResponse({ success: true, data: { targets: [] } }));
      }
      if (url === "/api/hivra/agents") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({
            success: true,
            data: {
              agent: {
                id: "agent-large-plan",
                type: "claude-code",
                name: "CLAUDE_CODE_AGENT",
                status: "provisioning",
                cpu: 2,
                ram: 4,
              },
            },
          }));
        }
        return Promise.resolve(jsonResponse({ success: true, data: { agents: [] } }));
      }
      if (url === "/api/hivra/agents/agent-large-plan/action") {
        return Promise.resolve(jsonResponse({ success: true, data: {} }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();

    const launchButton = await screen.findByRole("button", { name: /launch · 2 CPU \/ 4 GB/i });
    await waitFor(() => expect(launchButton).toBeEnabled());
    expect(screen.queryByRole("button", { name: /launch · 8 CPU \/ 16 GB/i })).not.toBeInTheDocument();
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/hivra/agents",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/hivra/agents" && init?.method === "POST",
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload).toEqual(expect.objectContaining({ cpu: 2, ram: 4 }));
  });

  it("keeps an explicit managed size when browser requirements temporarily clamp it", async () => {
    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();

    const browserSwitch = await screen.findByRole("switch", { name: /browser automation/i });
    await waitFor(() => expect(browserSwitch).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(browserSwitch);
    fireEvent.click(screen.getByRole("button", { name: "Use 1 CPU" }));
    fireEvent.click(screen.getByRole("button", { name: "Use 2 GB RAM" }));
    expect(screen.getByRole("button", { name: /launch · 1 CPU \/ 2 GB/i })).toBeInTheDocument();

    // Browser-on raises the effective floor, but must not overwrite the user's
    // underlying 1/2 choice. Turning it back off restores that exact selection.
    fireEvent.click(browserSwitch);
    expect(screen.getByRole("button", { name: /launch · 1\.5 CPU \/ 3 GB/i })).toBeInTheDocument();
    fireEvent.click(browserSwitch);
    expect(screen.getByRole("button", { name: /launch · 1 CPU \/ 2 GB/i })).toBeInTheDocument();
  });

  it("uses account-wide managed CPU/RAM including Hermes, not the Hivra-only agent list", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/billing/usage") return Promise.resolve(jsonResponse({ success: true, data: {
        subscribed: true,
        usage: { agentCount: 2, usedCpu: 4, usedRam: 8192 },
        plan: { key: "command", name: "Command", maxAgents: 999, maxCpuPerAgent: 8, maxRamPerAgent: 16384, totalCpu: 24, totalRam: 131072 },
      } }));
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();
    expect(await screen.findByText("20 CPU / 120 GB free")).toBeInTheDocument();
    expect(screen.getByText(/18 CPU \/ 116 GB left for more agents/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/hivra/agents" && init?.method !== "POST")).toBe(false);
  });

  it.each([
    [/^claude code — coding agent/i, /^launch ·/i],
    [/^openclaw/i, /^launch openclaw$/i],
  ])("pauses managed launch if its shared pool is already full: %s", async (agentCard, launchName) => {
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/billing/usage") return Promise.resolve(jsonResponse({ success: true, data: {
        subscribed: true,
        usage: { agentCount: 1, usedCpu: 2, usedRam: 4096 },
        plan: { key: "operator", name: "Operator", maxAgents: 4, maxCpuPerAgent: 2, maxRamPerAgent: 4096, totalCpu: 2, totalRam: 4096 },
      } }));
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    await chooseAdvancedAgent(agentCard);
    await waitFor(() => expect(screen.getByText(/Resize an existing computer or increase your plan/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: launchName })).toBeDisabled();
  });

  it("pauses managed launch when usage is unknown instead of showing the whole pool free", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/billing/usage") return Promise.resolve(jsonResponse({ success: true, data: {
        subscribed: true, usage: null,
        plan: { key: "command", name: "Command", maxAgents: 999, totalCpu: 24, totalRam: 131072 },
      } }));
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();
    expect(await screen.findByText("Capacity unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^launch ·/i })).toBeDisabled();
    expect(screen.queryByText("24 CPU / 128 GB free")).not.toBeInTheDocument();
  });

  it("keeps pool-exempt Aeon launchable with a full compute pool and a spare slot", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/billing/usage") return Promise.resolve(jsonResponse({ success: true, data: {
        subscribed: true,
        usage: { agentCount: 1, usedCpu: 2, usedRam: 4096 },
        plan: { key: "operator", name: "Operator", maxAgents: 4, maxCpuPerAgent: 2, maxRamPerAgent: 4096, totalCpu: 2, totalRam: 4096 },
      } }));
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    await chooseAdvancedAgent(/^aeon/i);
    await waitFor(() => expect(screen.getByRole("button", { name: /^launch aeon$/i })).toBeEnabled());
    expect(screen.queryByText(/managed pool does not have/)).not.toBeInTheDocument();
  });

  it.each([
    ["Claude Code", /^claude code — coding agent/i],
    ["Codex", /^codex — coding agent/i],
  ])("freezes %s launch choices until the original request resolves", async (name, agentCard) => {
    const baseFetch = fetchMock.getMockImplementation();
    let finishLaunch!: (response: Response) => void;
    const pendingLaunch = new Promise<Response>(resolve => { finishLaunch = resolve; });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/hivra/agents" && init?.method === "POST") return pendingLaunch;
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    await chooseAdvancedAgent(agentCard);
    const launch = await screen.findByRole("button", { name: /^launch ·/i });
    await waitFor(() => expect(launch).toBeEnabled());
    if (name === "Codex") {
      expect(screen.getByText("ChatGPT or API key after launch")).toBeInTheDocument();
      expect(screen.getByText(/choose ChatGPT sign-in or provide your own OpenAI API key/)).toBeInTheDocument();
    }
    fireEvent.click(launch);
    for (const control of [
      screen.getByRole("textbox", { name: `${name} Name` }),
      screen.getByRole("button", { name: /back to agent choices/i }),
      screen.getByRole("switch", { name: /browser automation/i }),
      screen.getByRole("button", { name: "Use 2 CPU" }),
      screen.getByRole("button", { name: "Use 4 GB RAM" }),
    ]) expect(control).toBeDisabled();
    fireEvent.click(launch);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST")).toHaveLength(1);
    finishLaunch(jsonResponse({ success: false, error: "Launch test failure" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^launch ·/i })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: `${name} Name` })).toBeEnabled();
    expect(screen.getByRole("button", { name: /back to agent choices/i })).toBeEnabled();
    expect(screen.getByRole("switch", { name: /browser automation/i })).toBeEnabled();
  });

  it.each([
    ["Claude Code", /^claude code — coding agent/i],
    ["Codex", /^codex — coding agent/i],
  ])("pauses a managed %s launch when the plan probe fails, then retries", async (_name, agentCard) => {
    const baseFetch = fetchMock.getMockImplementation();
    let usageCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/billing/usage") {
        usageCalls += 1;
        // The first request is the welcome entitlement check. Fail the box
        // form's limits request with an HTTP error: fetchPlan() used to hide
        // this as FREE_PLAN, whereas the strict probe must pause the launch.
        if (usageCalls === 2) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: async () => ({ success: false, error: "billing unavailable" }),
          } as Response);
        }
      }
      return baseFetch!(input, init);
    });

    render(<WelcomeFlow />);
    await chooseAdvancedAgent(agentCard);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load your plan limits/i);
    const launchButton = screen.getByRole("button", { name: /^launch ·/i });
    expect(launchButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /retry plan check/i }));
    await waitFor(() => expect(launchButton).toBeEnabled());
    expect(screen.queryByText(/plan limits are temporarily unavailable/i)).not.toBeInTheDocument();
    expect(usageCalls).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the smallest real size when a constrained paid plan cannot fit browser automation", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            subscribed: true,
            usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
            plan: {
              key: "starter",
              name: "Starter",
              maxAgents: 2,
              maxCpuPerAgent: 1,
              maxRamPerAgent: 2048,
              totalCpu: 1,
              totalRam: 2048,
            },
          },
        }));
      }
      if (url === "/api/infrastructure/targets") {
        return Promise.resolve(jsonResponse({ success: true, data: { targets: [] } }));
      }
      if (url === "/api/hivra/agents") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({
            success: true,
            data: {
              agent: {
                id: "agent-small-plan",
                type: "claude-code",
                name: "CLAUDE_CODE_AGENT",
                status: "provisioning",
                cpu: 0.5,
                ram: 1,
              },
            },
          }));
        }
        return Promise.resolve(jsonResponse({ success: true, data: { agents: [] } }));
      }
      if (url === "/api/hivra/agents/agent-small-plan/action") {
        return Promise.resolve(jsonResponse({ success: true, data: {} }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();

    const browserSwitch = await screen.findByRole("switch", { name: /browser automation/i });
    await waitFor(() => expect(browserSwitch).toBeDisabled());
    expect(browserSwitch).toHaveAttribute("aria-checked", "false");
    const launchButton = screen.getByRole("button", { name: /launch · 0\.5 CPU \/ 1 GB/i });
    expect(launchButton).toBeEnabled();
    fireEvent.click(launchButton);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(
      "/dashboard/agent/agent-small-plan?welcome=1&tab=terminal",
    ));
    const createCall = fetchMock.mock.calls.find(
      ([url, request]) => url === "/api/hivra/agents" && request?.method === "POST",
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload).toEqual(expect.objectContaining({ cpu: 0.5, ram: 1, browser: false }));
  });

  it("records launch acceptance without claiming a provisioning box is ready", async () => {
    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();

    const launchButton = await screen.findByRole("button", { name: /launch · 2 CPU \/ 4 GB/i });
    await waitFor(() => expect(launchButton).toBeEnabled());
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(posthog.capture).toHaveBeenCalledWith(
        "launch_request_accepted",
        expect.objectContaining({
          agentType: "claude-code",
          agentId: "agent-claude",
          acceptedStatus: "provisioning",
        }),
      );
    });
    expect(posthog.capture).not.toHaveBeenCalledWith("activation_instance_ready", expect.anything());
    expect(posthog.capture).not.toHaveBeenCalledWith("welcome_box_launch_succeeded", expect.anything());
  });

  it("routes an accepted launch even when optional personalization never resolves", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/hivra/agents/agent-claude/action" && init?.method === "POST") {
        return new Promise<Response>(() => undefined);
      }
      return baseFetch!(input, init);
    });

    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();
    const launchButton = await screen.findByRole("button", { name: /launch · 2 CPU \/ 4 GB/i });
    await waitFor(() => expect(launchButton).toBeEnabled());
    fireEvent.click(launchButton);

    // Acceptance is truthful and immediate; navigation is bounded even though
    // the optional onboarding PATCH never settles.
    await waitFor(() => expect(posthog.capture).toHaveBeenCalledWith(
      "launch_request_accepted",
      expect.objectContaining({ agentId: "agent-claude", acceptedStatus: "provisioning" }),
    ));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(
      "/dashboard/agent/agent-claude?welcome=1&tab=terminal",
    ), { timeout: 2_000 });
    expect(mockClientLogWarn).toHaveBeenCalledWith(
      "Welcome Claude Code personalization save timed out; continuing to agent",
      expect.objectContaining({
        failureType: "welcome_claude_code_personalization_save_timed_out",
        agentId: "agent-claude",
      }),
    );
  });

  it.each([
    { runtime: "claude-code", managedCapacity: "available" },
    { runtime: "claude-code", managedCapacity: "unavailable" },
    { runtime: "claude-code", managedCapacity: "full" },
    { runtime: "agent-zero", managedCapacity: "full" },
  ])("launches $runtime on the exact self-managed target with $managedCapacity managed capacity", async ({ runtime, managedCapacity }) => {
    const baseFetch = fetchMock.getMockImplementation();
    let usageRequests = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/billing/usage") {
        usageRequests += 1;
        if (managedCapacity === "unavailable" && usageRequests > 1) return Promise.resolve({ ok: false, status: 503, json: async () => ({ success: false, error: "Usage unavailable" }) } as Response);
        if (managedCapacity === "full") return Promise.resolve(jsonResponse({ success: true, data: {
          subscribed: true,
          usage: { agentCount: 1, usedCpu: 2, usedRam: 4096 },
          plan: { key: "operator", name: "Operator", maxAgents: 1, maxCpuPerAgent: 2, maxRamPerAgent: 4096, totalCpu: 2, totalRam: 4096 },
        } }));
      }
      if (url === "/api/infrastructure/targets") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            targets: [{
              id: "22222222-2222-4222-8222-222222222222",
              connectionId: "11111111-1111-4111-8111-111111111111",
              evidenceConnectionRevision: 9,
              externalId: "pve-01",
              displayName: "Studio Proxmox / pve-01",
              status: "ready",
              capacity: {
                cpu: { totalCores: 4, utilizationRatio: 0.25 },
                memoryBytes: { total: 8 * 1024 ** 3, available: 6 * 1024 ** 3 },
                storageBytes: { total: 500 * 1024 ** 3, available: 350 * 1024 ** 3 },
              },
              capabilities: {
                proxmoxVersion: "pve-manager/8.4.1",
                launchReady: true,
                directRootAccess: true,
                kvmAvailable: true,
                bridges: ["vmbr1"],
                selectedBridge: "vmbr1",
                storages: ["local-lvm"],
                selectedStorage: "local-lvm",
                template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true, ready: true },
                provisioner: {
                  configured: true,
                  ready: true,
                  version: PORTABLE_HIVRA_PROVISIONER_VERSION,
                },
                runtimeCompatibility: {
                  ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
                  supportedCatalogRuntimeIds: [
                    ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY.supportedCatalogRuntimeIds,
                  ],
                },
                vmidRange: { start: 200, end: 399, freeCount: 190, firstAvailable: 200 },
                issues: [],
              },
              supportedIsolationDrivers: ["proxmox-kvm"],
              isolationClass: "hardware-vm",
              lastPreflightAt: "2026-08-26T12:00:00.000Z",
              lastErrorCode: null,
              createdAt: "2026-08-26T12:00:00.000Z",
              updatedAt: "2026-08-26T12:00:00.000Z",
            }],
          },
        }));
      }
      return baseFetch!(input, init);
    });

    render(<WelcomeFlow />);
    if (runtime === "agent-zero") await chooseAdvancedAgent(/^agent zero/i);
    else await chooseClaudeCodeAgent();
    const selfManaged = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toBeEnabled());
    fireEvent.click(selfManaged);
    expect(screen.queryByRole("button", { name: "Recommended: 2 CPU / 4 GB" })).not.toBeInTheDocument();
    expect(screen.getByText(/verified host you selected/i)).toBeInTheDocument();
    expect(screen.queryByText(/verified Proxmox target/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use 4 CPU" }));
    fireEvent.click(screen.getByRole("button", { name: "Use 4 GB RAM" }));

    fireEvent.click(screen.getByRole("button", { name: runtime === "agent-zero" ? /^launch agent zero · 4 CPU \/ 4 GB$/i : /launch · 4 CPU \/ 4 GB/i }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(
      runtime === "agent-zero" ? "/dashboard/agent/agent-claude?welcome=1&tab=aeon" : "/dashboard/agent/agent-claude?welcome=1&tab=terminal",
    ));

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/hivra/agents" && init?.method === "POST",
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload).toEqual(expect.objectContaining({
      cpu: 4,
      ram: 4,
      deployment: {
        mode: "self-managed",
        connectionId: "11111111-1111-4111-8111-111111111111",
        targetId: "22222222-2222-4222-8222-222222222222",
        expectedConnectionRevision: 9,
      },
    }));
  });

  it.each(["codex", "claude-code", "openclaw"])("hands the prepared computer to %s without a managed plan or fictitious partitions", async runtime => {
    const target = providerVmTarget(); target.status = "ready"; target.lastErrorCode = null;
    target.capabilities.launchReady = true; target.capabilities.provisioner.ready = true;
    const other = { ...target, id: "99999999-9999-4999-8999-999999999999" };
    mockGet.mockImplementation(key => key === 'step' ? 'agent-type' : key === 'targetId' ? target.id : null);
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/infrastructure/targets") return Promise.resolve(jsonResponse({ success: true, data: { targets: [other, target] } }));
      if (String(input) === "/api/billing/usage") return Promise.resolve(jsonResponse({ success: true, data: { subscribed: false, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 } } }));
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    if (runtime === "claude-code") await chooseClaudeCodeAgent();
    else if (runtime === "codex") await chooseAdvancedAgent(/^codex/i);
    else await chooseAdvancedAgent(/^openclaw/i);
    const own = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(own).toBeEnabled());
    expect(own).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Ready host')).toHaveValue(target.id);
    expect(screen.queryByRole("button", { name: "Use 4 CPU" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use 4 GB RAM" })).not.toBeInTheDocument();
    expect(screen.getByText(/uses the entire prepared cloud computer/)).toBeInTheDocument();
    if (runtime === "openclaw") expect(screen.queryByText(/Control UI on a managed box/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch on this computer" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(runtime === "openclaw"
      ? "/dashboard/agent/agent-claude?welcome=1&tab=aeon" : "/dashboard/agent/agent-claude?welcome=1&tab=terminal"));
    const request = fetchMock.mock.calls.find(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ deployment: { mode: "self-managed", targetId: target.id } });
  });

  it.each([[true, 'agent-type'], [false, 'agent-type'], [true, 'deploy'], [false, 'deploy']] as const)("requires an explicit Cloud switch and preserves subscribed=%s on step=%s", async (subscribed, step) => {
    mockGet.mockImplementation(key => key === 'step' ? step : key === 'targetId' ? '99999999-9999-4999-8999-999999999999' : key === 'agentType' && step === 'deploy' ? 'general' : null);
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/billing/usage') return Promise.resolve(jsonResponse({ success: true, data: { subscribed, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 } } }));
      return baseFetch!(input, init);
    });
    render(<WelcomeFlow />);
    if (step === 'agent-type') await chooseHermesAgent();
    expect(await screen.findByRole('region', { name: 'Selected computer compatibility' })).toBeInTheDocument();
    expect(screen.queryByText('Managed (Venice)?')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/instances' && init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Use Hivra Cloud for this agent' }));
    expect(screen.queryByRole('region', { name: 'Selected computer compatibility' })).not.toBeInTheDocument();
    if (subscribed) expect(screen.getByTestId('deploy-primary-cta')).toBeInTheDocument();
    else expect(screen.queryByTestId('deploy-primary-cta')).not.toBeInTheDocument();
  });

  it("shows a retry when a dashboard agent's plan probe fails, then recovers", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    let usageCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/billing/usage") {
        usageCalls += 1;
        // First call is the welcome entitlement probe; fail the dashboard
        // launch form's own strict limits read, then let its retry succeed.
        if (usageCalls === 2) return Promise.reject(new Error("limits offline"));
      }
      return baseFetch!(input, init);
    });

    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("button", { name: /^aeon/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load your plan limits/i);
    const launchButton = screen.getByRole("button", { name: /^launch aeon$/i });
    expect(launchButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /retry plan check/i }));
    await waitFor(() => expect(launchButton).toBeEnabled());
    expect(screen.queryByText(/limits offline/i)).not.toBeInTheDocument();
    expect(usageCalls).toBeGreaterThanOrEqual(3);
  });

  it.each(["Agent Zero", "OpenClaw", "Aeon"])("explains %s model setup at its actual connection boundary", async (name) => {
    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`, "i") }));
    const optIn = await screen.findByRole("checkbox", { name: /power it with my managed Venice credits/i });
    expect(optIn).not.toBeChecked();
    if (name === "Aeon") {
      expect(optIn).toHaveAccessibleName(/when you connect GitHub.*during connection/i);
      expect(optIn).not.toHaveAccessibleName(/at launch/i);
    } else {
      expect(optIn).toHaveAccessibleName(new RegExp(`at launch, Hivra configures ${name}`, "i"));
      expect(optIn).toHaveAccessibleName(/leave this unchecked.*own model provider.*before running a task/i);
      expect(optIn).not.toHaveAccessibleName(/your fork|on connect|when you connect/i);
    }
    expect(optIn).toHaveAccessibleName(/model usage is charged.*when using managed Venice/i);
  });

  it.each([false, true])("launches Agent Zero with the reviewed managed size (minimum=%s)", async (minimum) => {
    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("button", { name: /^agent zero/i }));
    const recommended = await screen.findByRole("button", { name: "Recommended: 2 CPU / 4 GB" });
    await waitFor(() => expect(recommended).toBeEnabled());
    expect(recommended).toHaveAttribute("aria-pressed", "true");
    if (minimum) fireEvent.click(screen.getByRole("button", { name: "Minimum: 1 CPU / 2 GB" }));
    expect(screen.getByText(`Runs on ${minimum ? '1 CPU / 2 GB' : '2 CPU / 4 GB'} from your plan's compute pool, plus one agent slot.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^launch agent zero$/i }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("/dashboard/agent/")));
    const launches = fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST");
    expect(launches).toHaveLength(1);
    expect(JSON.parse(launches[0][1].body)).toMatchObject({ type: "agent-zero", cpu: minimum ? 1 : 2, ram: minimum ? 2 : 4, managedVenice: false });
  });

  it.each([
    { reason: "remaining CPU", usedCpu: 1, usedRam: 0, maxCpuPerAgent: 2, maxRamPerAgent: 4096 },
    { reason: "remaining RAM", usedCpu: 0, usedRam: 2048, maxCpuPerAgent: 2, maxRamPerAgent: 4096 },
    { reason: "per-agent CPU", usedCpu: 0, usedRam: 0, maxCpuPerAgent: 1, maxRamPerAgent: 4096 },
    { reason: "per-agent RAM", usedCpu: 0, usedRam: 0, maxCpuPerAgent: 2, maxRamPerAgent: 2048 },
  ])("requires an explicit minimum choice when Agent Zero cannot fit $reason", async ({ usedCpu, usedRam, maxCpuPerAgent, maxRamPerAgent }) => {
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/billing/usage" ? Promise.resolve(jsonResponse({ success: true, data: {
        subscribed: true, usage: { agentCount: 0, usedCpu, usedRam },
        plan: { totalCpu: 2, totalRam: 4096, maxCpuPerAgent, maxRamPerAgent },
      } })) : baseFetch!(input, init));
    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("button", { name: /^agent zero/i }));
    const minimum = await screen.findByRole("button", { name: "Minimum: 1 CPU / 2 GB" });
    await waitFor(() => expect(minimum).toBeEnabled());
    expect(screen.getByRole("button", { name: "Recommended: 2 CPU / 4 GB" })).toBeDisabled();
    const launch = screen.getByRole("button", { name: /^launch agent zero$/i });
    expect(launch).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/2 CPU \/ 4 GB/);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST")).toHaveLength(0);
    fireEvent.click(minimum);
    expect(launch).toBeEnabled();
    fireEvent.click(launch);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("/dashboard/agent/")));
    const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST");
    expect(JSON.parse(post![1].body)).toMatchObject({ cpu: 1, ram: 2 });
  });

  it.each(["Claude Code", "Codex"])("announces the pending native %s launch and clears feedback on rejection", async (name) => {
    const baseFetch = fetchMock.getMockImplementation();
    let respond!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { respond = resolve; });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/hivra/agents" && init?.method === "POST" ? pending : baseFetch!(input, init));
    render(<WelcomeFlow />);
    await chooseAdvancedAgent(new RegExp(`^${name} — coding agent`, "i"));
    const button = await screen.findByTestId("deploy-primary-cta");
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole("status", { name: "Launch confirmation" })).not.toBeInTheDocument();
    fireEvent.click(button);
    const status = await screen.findByRole("status", { name: "Launch confirmation" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/pending request, not installation progress/i);
    expect(status).not.toHaveTextContent(/\d+%|installing|allocated/i);
    expect(button).toHaveAttribute("aria-describedby", status.id);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST")).toHaveLength(1);
    await act(async () => respond({ ok: false, status: 503, json: async () => ({ error: "Capacity unavailable" }) } as Response));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Launch confirmation" })).not.toBeInTheDocument());
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(button).toBeEnabled();
    expect(mockPush).not.toHaveBeenCalledWith(expect.stringContaining("/dashboard/agent/"));
  });

  it.each(["Agent Zero", "OpenClaw", "Aeon"])("announces the pending %s request without duplicate submission or invented progress", async (name) => {
    const baseFetch = fetchMock.getMockImplementation();
    let respond!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { respond = resolve; });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/hivra/agents" && init?.method === "POST" ? pending : baseFetch!(input, init));
    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`, "i") }));
    const button = await screen.findByRole("button", { name: new RegExp(`^launch ${name}$`, "i") });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole("status", { name: "Launch confirmation" })).not.toBeInTheDocument();
    fireEvent.click(button);
    const status = await screen.findByRole("status", { name: "Launch confirmation" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/pending request, not installation progress/i);
    expect(status).not.toHaveTextContent(/\d+%|installing|allocated/i);
    expect(button).toBeDisabled();
    if (name === "Agent Zero") {
      expect(screen.getByRole("button", { name: "Minimum: 1 CPU / 2 GB" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Recommended: 2 CPU / 4 GB" })).toBeDisabled();
    } else {
      expect(screen.queryByRole("button", { name: "Recommended: 2 CPU / 4 GB" })).not.toBeInTheDocument();
    }
    expect(button).toHaveAttribute("aria-describedby", status.id);
    fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/hivra/agents" && init?.method === "POST")).toHaveLength(1);
    await act(async () => respond(jsonResponse({ success: true, data: { agent: {
      id: "agent-pending", type: name.toLowerCase().replace(" ", "-"), status: "provisioning",
    } } })));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("/dashboard/agent/agent-pending")));
  });

  it("removes pending launch feedback when the server rejects the request", async () => {
    const baseFetch = fetchMock.getMockImplementation();
    let respond!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { respond = resolve; });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/hivra/agents" && init?.method === "POST" ? pending : baseFetch!(input, init));
    render(<WelcomeFlow />);
    fireEvent.click(await screen.findByRole("button", { name: /^openclaw/i }));
    const button = await screen.findByRole("button", { name: /^launch openclaw$/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("status", { name: "Launch confirmation" })).toBeInTheDocument();
    await act(async () => respond({ ok: false, status: 503, json: async () => ({ error: "Capacity unavailable" }) } as Response));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Launch confirmation" })).not.toBeInTheDocument());
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(button).toBeEnabled();
    expect(mockPush).not.toHaveBeenCalledWith(expect.stringContaining("/dashboard/agent/"));
  });

  it("records Aeon launch acceptance and lands on its native dashboard", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/hivra/agents") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({
            success: true,
            data: {
              agent: { id: "agent-aeon", type: "aeon", name: "AEON_AGENT", status: "provisioning", cpu: 1, ram: 1 },
              agents: [],
            },
          }));
        }
        return Promise.resolve(jsonResponse({ success: true, data: { agents: [] } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    // Aeon lives in the default Agents catalog.
    fireEvent.click(await screen.findByRole("button", { name: /^aeon/i }));
    expect(await screen.findByLabelText("Aeon Name")).toHaveValue("AEON_AGENT");

    // The launch CTA is disabled until the plan probe resolves.
    const launchButton = await screen.findByRole("button", { name: /^launch aeon$/i });
    await waitFor(() => expect(launchButton).toBeEnabled());
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(posthog.capture).toHaveBeenCalledWith(
        "launch_request_accepted",
        expect.objectContaining({
          agentType: "aeon",
          agentId: "agent-aeon",
          acceptedStatus: "provisioning",
        }),
      );
    });
    expect(posthog.capture).not.toHaveBeenCalledWith("activation_instance_ready", expect.anything());
    expect(mockPush).toHaveBeenCalledWith("/dashboard/agent/agent-aeon?welcome=1&tab=aeon");
  });

  it("forces the first-agent picker after plan activation even with a stored choice", async () => {
    window.localStorage.setItem("hermes:welcome_agent_type", "claude-code");
    mockGet.mockImplementation((key: string) => {
      if (key === "step") return "agent-type";
      return null;
    });

    render(<WelcomeFlow />);

    // A stored choice must not skip the picker. The default catalog is shown
    // and no deploy card is pre-rendered.
    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^hermes agent — general operator/i })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("CLAUDE_CODE_AGENT")).not.toBeInTheDocument();
  });

  it("shows the first-agent picker on a generic welcome visit even with a stored choice", async () => {
    window.localStorage.setItem("hermes:welcome_agent_type", "claude-code");
    mockGet.mockReturnValue(null);

    render(<WelcomeFlow />);

    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^hermes agent — general operator/i })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("CLAUDE_CODE_AGENT")).not.toBeInTheDocument();
  });

  it("keeps every header title variant in a single element wrapper so DOM translators can't strand React's text anchors", async () => {
    // Google Translate (and similar extensions) replace loose text nodes with
    // <font> wrappers. If the <h1> swapped bare text+<em> fragments between
    // steps, React's removeChild/insertBefore would throw NotFoundError and
    // trip the dashboard error boundary (seen live on ?step=agent-type).
    const expectSingleElementChild = (heading: HTMLElement) => {
      const looseText = Array.from(heading.childNodes).filter(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== ""
      );
      expect(looseText).toHaveLength(0);
      expect(heading.childElementCount).toBe(1);
    };

    mockGet.mockReturnValue(null);

    render(<WelcomeFlow />);

    expect(await screen.findByRole("button", { name: /^claude code — coding agent/i })).toBeInTheDocument();
    expectSingleElementChild(screen.getByRole("heading", { level: 1, name: /choose your agent/i }));

    await chooseClaudeCodeAgent();
    expect(await screen.findByDisplayValue("CLAUDE_CODE_AGENT")).toBeInTheDocument();
    expectSingleElementChild(screen.getByRole("heading", { level: 1, name: /^deploy/i }));
  });

  it("lets unpaid hosted users use ready self-managed capacity while keeping Hivra Cloud plan-gated", async () => {
    mockGet.mockReturnValue(null);
    const target = providerVmTarget();
    target.status = "ready";
    target.lastErrorCode = null;
    target.capabilities.launchReady = true;
    target.capabilities.provisioner.ready = true;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/vault") {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      if (url === "/api/billing/usage") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            subscribed: false,
            usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
            plan: { totalCpu: 0, totalRam: 0 },
          },
        }));
      }
      if (url === "/api/billing/wallet/eligibility") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            tiers: {
              pro: { currentlyEligible: false },
              power: { currentlyEligible: false },
            },
          },
        }));
      }
      if (url === "/api/billing/subscribe") {
        return Promise.resolve(jsonResponse({ success: true, data: { activated: true } }));
      }
      if (url === "/api/infrastructure/targets") {
        return Promise.resolve(jsonResponse({ success: true, data: { targets: [target] } }));
      }

      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);

    await chooseClaudeCodeAgent();

    expect(await screen.findByDisplayValue("CLAUDE_CODE_AGENT")).toBeInTheDocument();
    const selfManaged = screen.getByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(selfManaged).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByLabelText("Ready host")).toHaveValue(target.id);
    expect(screen.getByRole("button", { name: /Launch on this computer/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Hivra Cloud/i }));
    expect(screen.getByText(/Hivra Cloud needs an active managed plan/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Launch ·/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Choose Hivra Cloud plan/i }));
    expect(await screen.findByText("Paying with Card")).toBeInTheDocument();

    expect(window.localStorage.getItem("hermes:welcome_agent_type")).toBe("claude-code");
  });

  it("does not invent a managed plan when a portable-agent entitlement probe times out", async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockImplementation((key: string) => {
        if (key === "step") return "deploy";
        if (key === "agentType") return "codex";
        return null;
      });
      const baseFetch = fetchMock.getMockImplementation();
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/billing/usage" || url === "/api/billing/wallet/eligibility") {
          return new Promise<Response>(() => undefined);
        }
        return baseFetch!(input, init);
      });

      render(<WelcomeFlow />);
      await act(async () => {
        jest.advanceTimersByTime(3_001);
        await Promise.resolve();
      });

      expect(screen.getByDisplayValue("CODEX_AGENT")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Hivra Cloud/i }));
      expect(screen.getByText(/Hivra Cloud needs an active managed plan/i)).toBeInTheDocument();
      expect(screen.queryByText(/^Plan active$/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Launch ·/i })).toBeDisabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("recovers to the boot screen when the deploy POST reports failure but the VM was actually created", async () => {
    // Simulates the cold-host case: POST /api/instances returns success:false
    // (client-visible failure) while the row was actually created and is
    // booting. The flow must route to the boot screen, NOT show "Deployment
    // failed".
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({ success: false, error: "Deployment failed" }));
        }
        // GET list — the row the "failed" POST actually created, still booting.
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: [
              {
                id: "inst-recovered",
                // Recovery matches by exact agent name: the Bea persona seeds the
                // box name on the general lane, so the recovered row must be "Bea".
                name: "Bea",
                status: "provisioning",
                lifecycle_state: "provisioning",
                provider: "nous",
                created_at: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/instances/inst-recovered"),
      );
    });
    expect(posthog.capture).toHaveBeenCalledWith("activation_instance_ready", expect.objectContaining({
      source: "welcome-flow",
      route: "/dashboard/welcome",
      outcome: "recovered_existing_instance",
      hasInstanceId: true,
    }));
    expect(screen.queryByText(/Deployment failed/i)).not.toBeInTheDocument();
  });

  it.skip("[obsolete: on-card provider/key config removed — now configured in the agent webchat] blocks the deploy preflight when an OpenRouter key is malformed (no API call)", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });

    fireEvent.click(screen.getByRole("button", { name: /^openrouter$/i }));
    fireEvent.change(screen.getByPlaceholderText("sk-..."), {
      target: { value: "sk-wrongprefix-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    const shapeAlerts = await screen.findAllByRole("alert");
    expect(
      shapeAlerts.some((el) => /must start with sk-or-/i.test(el.textContent ?? ""))
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/instances",
      expect.objectContaining({ method: "POST" })
    );
    expect(posthog.capture).toHaveBeenCalledWith("welcome_dead_click_candidate", expect.objectContaining({
      control: "deploy_agent",
      reason: "provider_key_invalid_shape",
      provider: "openrouter",
    }));
    expect(posthog.capture).not.toHaveBeenCalledWith(
      "activation_instance_requested",
      expect.anything()
    );
    expect(mockClientLogWarn).toHaveBeenCalledWith(
      "Welcome deploy validation blocked",
      expect.objectContaining({
        failureType: "welcome_deploy_validation_failed",
        reason: "provider_key_invalid_shape",
        provider: "openrouter",
      })
    );
  });

  it("maps capacity errors to a humane retry message and a fully-diagnosed activation_failed", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({
            success: false,
            error: "No free Proxmox VMID in range 1300-1349",
          }));
        }
        return Promise.resolve(jsonResponse({ success: true, data: [] })); // no recoverable row
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    // Friendly capacity headline, without leaking provider-specific host internals.
    expect(await screen.findByText(/temporarily at capacity/i)).toBeInTheDocument();
    expect(screen.queryByText(/No free Proxmox VMID in range 1300-1349/i)).not.toBeInTheDocument();

    expect(posthog.capture).toHaveBeenCalledWith("activation_failed", expect.objectContaining({
      source: "welcome-flow",
      route: "/dashboard/welcome",
      stage: "create_instance",
      errorCategory: "capacity",
      errorMessage: expect.stringContaining("No free Proxmox VMID"),
      failureType: "deploy_failed_no_recoverable_instance",
      recoverable: true,
    }));
  });

  it("offers 'Open your agent' (primary) when the one-base-agent 403 hits and the existing agent is live", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances?summary=true") {
        // The existing base agent — live, so the CTA reads "Open your agent".
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: [
              {
                id: "inst-existing",
                name: "OLD_AGENT",
                status: "running",
                lifecycle_state: "active",
                paused_reason: null,
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: async () => ({
              success: false,
              error: "You already have one active base-tier agent. Upgrade to deploy more.",
              failureType: "deploy_rejected_403",
              code: "FREE_INSTANCE_LIMIT_REACHED",
              existingInstanceId: "inst-existing",
            }),
          } as Response);
        }
        return Promise.resolve(jsonResponse({ success: true, data: [] })); // no recoverable row
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    // The limit message renders with the existing-agent CTA as PRIMARY and
    // Upgrade demoted to the secondary slot — not a dead-end upgrade wall.
    expect(
      await screen.findByText(/already have one active base-tier agent/i),
    ).toBeInTheDocument();
    const openButton = await screen.findByTestId("welcome-open-existing-agent");
    expect(openButton).toHaveTextContent(/open your agent/i);
    expect(screen.getByRole("button", { name: /upgrade plan/i })).toBeInTheDocument();

    fireEvent.click(openButton);
    expect(mockPush).toHaveBeenCalledWith("/dashboard/instances/inst-existing");

    expect(posthog.capture).toHaveBeenCalledWith("activation_failed", expect.objectContaining({
      source: "welcome-flow",
      stage: "create_instance",
      errorCategory: "plan_limit",
      failureType: "deploy_failed_no_recoverable_instance",
    }));
  });

  it("offers 'Restore your agent' when the one-base-agent 403 hits and the existing agent is cold-archived", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances?summary=true") {
        // Reclaimed base agent: lifecycle 'paused' with paused_reason
        // 'cold_archived' — the shape that still occupies the free slot but
        // needs a restore, not an upgrade.
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: [
              {
                id: "inst-archived",
                name: "OLD_AGENT",
                status: "stopped",
                lifecycle_state: "paused",
                paused_reason: "cold_archived",
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: async () => ({
              success: false,
              error: "You already have one active base-tier agent. Upgrade to deploy more.",
              failureType: "deploy_rejected_403",
              code: "FREE_INSTANCE_LIMIT_REACHED",
              existingInstanceId: "inst-archived",
            }),
          } as Response);
        }
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    const restoreButton = await screen.findByTestId("welcome-open-existing-agent");
    expect(restoreButton).toHaveTextContent(/restore your agent/i);

    // Routes to the existing instance page, where the real restore banner
    // lives — the welcome flow builds no restore UI of its own.
    fireEvent.click(restoreButton);
    expect(mockPush).toHaveBeenCalledWith("/dashboard/instances/inst-archived");
  });

  // ---- Moment #4: second-agent upgrade wall ----

  function mockSecondAgentBlock() {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances?summary=true") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: [
              {
                id: "inst-existing",
                name: "OLD_AGENT",
                status: "running",
                lifecycle_state: "active",
                paused_reason: null,
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: async () => ({
              success: false,
              error: "You already have one active base-tier agent. Upgrade to deploy more.",
              failureType: "deploy_rejected_403",
              code: "FREE_INSTANCE_LIMIT_REACHED",
              existingInstanceId: "inst-existing",
            }),
          } as Response);
        }
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });
  }

  it("fires free_limit_hit on the 2nd-agent block, and (flag OFF) keeps the plain billing redirect", async () => {
    mockSecondAgentBlock();

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    // Measurement event fires regardless of the copy flag.
    await waitFor(() =>
      expect(posthog.capture).toHaveBeenCalledWith(
        "free_limit_hit",
        expect.objectContaining({
          surface: "second_agent",
          limit_type: "agents",
          existing_instance_id: "inst-existing",
          from_plan: "free",
          to_plan: "operator",
        }),
      ),
    );

    // #520 primary CTA is intact.
    const openButton = await screen.findByTestId("welcome-open-existing-agent");
    expect(openButton).toHaveTextContent(/open your agent/i);

    // Flag OFF (default): Upgrade plan still just redirects — no modal.
    fireEvent.click(screen.getByTestId("welcome-second-agent-upgrade"));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/billing?from=welcome");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the second-agent upgrade paywall (surface second_agent) when the flag is on, keeping Open/Restore", async () => {
    process.env.NEXT_PUBLIC_HERMES_SECOND_AGENT_UPGRADE_ENABLED = "true";
    try {
      mockSecondAgentBlock();

      render(<WelcomeFlow />);
      await chooseHermesAgent();
      await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
      fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

      // Primary Open/Restore CTA must still be there (not regressed).
      const openButton = await screen.findByTestId("welcome-open-existing-agent");
      expect(openButton).toHaveTextContent(/open your agent/i);

      // Upgrade plan now opens the shared paywall instead of redirecting.
      fireEvent.click(screen.getByTestId("welcome-second-agent-upgrade"));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText(/run a fleet of agents/i)).toBeInTheDocument();
      expect(mockPush).not.toHaveBeenCalledWith("/dashboard/billing?from=welcome");

      // The modal's CTA fires upgrade_clicked with the second_agent surface.
      fireEvent.click(screen.getByRole("link", { name: /upgrade to pro/i }));
      expect(posthog.capture).toHaveBeenCalledWith("upgrade_clicked", {
        surface: "second_agent",
        feature: "agents",
        plan: "free",
        from_plan: "free",
        to_plan: "operator",
      });
    } finally {
      delete process.env.NEXT_PUBLIC_HERMES_SECOND_AGENT_UPGRADE_ENABLED;
    }
  });

  it("turns the free-plan launch limit into an upgrade CTA with diagnosed telemetry (Claude Code)", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/hivra/agents") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({
            success: false,
            error: "Your Free plan allows 1 active agent.",
          }));
        }
        return Promise.resolve(jsonResponse({ success: true, data: { agents: [] } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();
    fireEvent.click(await screen.findByRole("button", { name: /launch · 2 CPU \/ 4 GB/i }));

    expect(await screen.findByText(/Your Free plan allows 1 active agent\./i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /upgrade plan/i }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/billing?from=welcome");

    expect(posthog.capture).toHaveBeenCalledWith("activation_failed", expect.objectContaining({
      source: "welcome-flow",
      stage: "hivra_box_launch",
      agentType: "claude-code",
      failureType: "welcome_claude_code_launch_failed",
      errorCategory: "plan_limit",
      errorMessage: "Your Free plan allows 1 active agent.",
    }));
    // The launch CTA recovers (not stuck in a launching state).
    expect(screen.getByRole("button", { name: /launch · 2 CPU \/ 4 GB/i })).toBeEnabled();
  });

  it("preflights the agent-slot limit before launch instead of letting the deploy fail", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 1, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/hivra/agents" && init?.method !== "POST") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            agents: [
              { id: "a1", type: "claude-code", name: "EXISTING", status: "running", cpu: 2, ram: 4 },
            ],
          },
        }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });
    mockGet.mockImplementation((key: string) => (key === "step" ? "deploy" : null));

    render(<WelcomeFlow />);
    await chooseClaudeCodeAgent();

    expect(await screen.findByText(/allows 1 active agent/i)).toBeInTheDocument();
    expect(screen.getByText(/already have 1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upgrade plan/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^launch ·/i })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/hivra/agents",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("still shows the error when the deploy fails AND no instance row was created", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({ success: false, error: "Quota exceeded" }));
        }
        return Promise.resolve(jsonResponse({ success: true, data: [] })); // no rows
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    await screen.findByText(/Quota exceeded/i);
    expect(posthog.capture).toHaveBeenCalledWith("activation_failed", expect.objectContaining({
      source: "welcome-flow",
      route: "/dashboard/welcome",
      failureType: "deploy_failed_no_recoverable_instance",
      recoverable: false,
    }));
    expect(mockPush).not.toHaveBeenCalledWith(
      expect.stringContaining("/dashboard/instances/"),
    );
  });

  it.skip("[obsolete: on-card provider/key config removed — now configured in the agent webchat] shows an actionable API-key error instead of leaving the Deploy Agent click inert", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    // Deploy-card redesign: the old in-card "Bring Venice API key" control is
    // gone — Managed=OFF is now clean-slate. To exercise the key-required gate
    // we pick a non-Venice, key-requiring provider (OpenRouter) and leave the
    // key empty while Managed stays ON.
    fireEvent.click(screen.getByRole("button", { name: /^openrouter$/i }));
    const keyInput = screen.getByPlaceholderText("sk-...");
    fireEvent.change(keyInput, { target: { value: "" } });

    const deployButton = await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    expect(deployButton).toBeEnabled();

    fireEvent.click(deployButton);

    // Same wording as the server's createInstance 400, shown both in the
    // flow-level banner and inline under the key input.
    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.filter((el) =>
        /Provider API key is required\. Provide it manually or select a Vault key that contains an encrypted credential\./.test(
          el.textContent ?? ""
        )
      ).length
    ).toBeGreaterThanOrEqual(2);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/instances",
      expect.objectContaining({ method: "POST" })
    );
    expect(mockClientLogWarn).toHaveBeenCalledWith(
      "Welcome deploy validation blocked",
      expect.objectContaining({
        source: "welcome-flow",
        failureType: "welcome_deploy_validation_failed",
        reason: "missing_provider_api_key",
        provider: "openrouter",
      })
    );
    expect(posthog.capture).toHaveBeenCalledWith("welcome_dead_click_candidate", {
      source: "welcome-flow",
      route: "/dashboard/welcome",
      control: "deploy_agent",
      reason: "missing_provider_api_key",
      provider: "openrouter",
      repairCopy:
        "Provider API key is required. Provide it manually or select a Vault key that contains an encrypted credential.",
    });
  });

  it.skip("[obsolete: on-card provider/key config removed — now configured in the agent webchat] blocks an OpenRouter key missing the sk-or- prefix inline before deploy", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^openrouter$/i }));

    const keyInput = screen.getByPlaceholderText("sk-...");
    fireEvent.change(keyInput, { target: { value: "sk-wrongprefix123" } });
    fireEvent.blur(keyInput);

    // Inline, on blur — same wording as the server's shape validator.
    expect(
      await screen.findByText("OpenRouter API keys must start with sk-or-.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((el) => el.textContent?.includes("OpenRouter API keys must start with sk-or-."))
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/instances",
      expect.objectContaining({ method: "POST" })
    );
    expect(mockClientLogWarn).toHaveBeenCalledWith(
      "Welcome deploy validation blocked",
      expect.objectContaining({
        source: "welcome-flow",
        failureType: "welcome_deploy_validation_failed",
        reason: "provider_key_invalid_shape",
        provider: "openrouter",
      })
    );
  });

  it.skip("[obsolete: on-card provider/key config removed — now configured in the agent webchat] blocks deploy for custom_llm with no key using the server's required-key wording", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });

    // custom_llm lives in the "More providers..." overflow dropdown.
    fireEvent.click(screen.getByRole("button", { name: /more providers/i }));
    fireEvent.click(await screen.findByRole("button", { name: /custom llm provider/i }));

    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((el) =>
        el.textContent?.includes(
          "Provider API key is required. Provide it manually or select a Vault key that contains an encrypted credential."
        )
      )
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/instances",
      expect.objectContaining({ method: "POST" })
    );
    expect(mockClientLogWarn).toHaveBeenCalledWith(
      "Welcome deploy validation blocked",
      expect.objectContaining({
        reason: "missing_provider_api_key",
        provider: "custom_llm",
      })
    );
  });

  it.skip("[obsolete: on-card provider/key config removed — now configured in the agent webchat] does not require a manual key when a matching vault key is selected", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/vault") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: [
            {
              id: "vault_openrouter_123",
              provider: "openrouter",
              key_preview: "sk-or...5678",
              name: "OpenRouter",
            },
          ],
        }));
      }
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              subscribed: true,
              usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
              plan: { totalCpu: 2, totalRam: 4096 },
            },
          })
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        return Promise.resolve(jsonResponse({ success: true, data: { id: "inst-or-vault" } }));
      }

      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^openrouter$/i }));

    expect(await screen.findByText(/vault key loaded/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances",
        expect.objectContaining({ method: "POST" })
      );
    });

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/instances" && init?.method === "POST"
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload.provider).toBe("openrouter");
    expect(payload.vaultKeyId).toBe("vault_openrouter_123");
    expect(payload).not.toHaveProperty("apiKey");
    expect(mockClientLogWarn).not.toHaveBeenCalledWith(
      "Welcome deploy validation blocked",
      expect.anything()
    );
  });

  it.skip("[obsolete: on-card provider/key config removed — now configured in the agent webchat] deploys when the OpenRouter key has the expected sk-or- shape", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^openrouter$/i }));

    const keyInput = screen.getByPlaceholderText("sk-...");
    fireEvent.change(keyInput, { target: { value: "sk-or-v1-abc123" } });
    fireEvent.blur(keyInput);

    expect(
      screen.queryByText("OpenRouter API keys must start with sk-or-.")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances",
        expect.objectContaining({ method: "POST" })
      );
    });

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/instances" && init?.method === "POST"
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload.provider).toBe("openrouter");
    expect(payload.apiKey).toBe("sk-or-v1-abc123");
  });

  it("uses a saved Venice vault key instead of defaulting the user into managed credits", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/vault") {
        return Promise.resolve(jsonResponse({
          success: true,
          data: [
            {
              id: "vault_venice_123",
              provider: "venice",
              key_preview: "sk-ven...1234",
              name: "Venice",
            },
          ],
        }));
      }
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              subscribed: true,
              usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
              plan: { totalCpu: 2, totalRam: 4096 },
            },
          })
        );
      }
      if (url === "/api/instances") {
        return Promise.resolve(jsonResponse({ success: true, data: { id: "inst-venice-byok" } }));
      }

      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByText(/vault key loaded/i);
    expect(screen.getByText(/sk-ven\.\.\.1234/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue to managed credits/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances",
        expect.objectContaining({ method: "POST" })
      );
    });

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/instances" && init?.method === "POST"
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload.provider).toBe("venice");
    expect(payload.vaultKeyId).toBe("vault_venice_123");
    expect(payload).not.toHaveProperty("managedVenice");
    expect(payload).not.toHaveProperty("apiKey");

    // Deploy success now lands an honest "Deployed — booting now" beat (no
    // auto-redirect); the route fires only when the user clicks "Open agent now".
    fireEvent.click(await screen.findByRole("button", { name: /skip for now/i }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/instances/inst-venice-byok?surface=chat&welcome=1");
  });

  it("creates a managed Venice Hivra quote inline before deployment", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    expect(screen.queryByPlaceholderText(/sk-/i)).not.toBeInTheDocument();

    // Funding is now a secondary path — the primary CTA stays "Deploy Agent".
    fireEvent.click(screen.getByRole("button", { name: /add credit first/i }));
    fireEvent.click(screen.getByText("Optional token top-up"));
    fireEvent.click(screen.getByRole("button", { name: /pay with \$HermesOS/i }));
    fireEvent.click(screen.getByRole("button", { name: /start \$HermesOS top-up/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/billing/managed-venice/hermesos/quote",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ targetPaidMicroUsd: 50_000_000 }),
        })
      );
    });
    expect(await screen.findByText(/rate locked/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /top up managed Venice credits/i })).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalledWith(
      "/dashboard/billing?managedVenice=deposit&wallet=hermesos&amountUsd=50"
    );

    const instanceCreateCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/instances" && init?.method === "POST"
    );
    expect(instanceCreateCall).toBeUndefined();
  });

  it("deploys managed Venice without a top-up when credits already exist", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/vault") {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              subscribed: true,
              usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
              plan: { totalCpu: 2, totalRam: 4096 },
            },
          })
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: fundedManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        return Promise.resolve(jsonResponse({ success: true, data: { id: "inst-funded-venice" } }));
      }

      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);

    await chooseHermesAgent();
    // Track W: the balance panel moved out of the (now Advanced-gated) Venice
    // block to the always-visible credit-status section, in consumer words.
    expect(await screen.findByText(/credit ready/i)).toBeInTheDocument();
    expect(screen.getByText(/\$12\.0000 available/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue to managed credits/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances",
        expect.objectContaining({ method: "POST" })
      );
    });

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/instances" && init?.method === "POST"
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload.managedVenice).toEqual({
      enabled: true,
      walletType: "hermesos",
    });

    // Deploy success now lands an honest "Deployed — booting now" beat (no
    // auto-redirect); the route fires only when the user clicks "Open agent now".
    fireEvent.click(await screen.findByRole("button", { name: /skip for now/i }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/instances/inst-funded-venice?surface=chat&welcome=1");
  });

  it("derives the hidden deploy size from the activated plan instead of the 2/4 hardcode", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        // Power (fleet): 4 CPU / 8 GB per agent and in the pool.
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              subscribed: true,
              usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
              plan: {
                key: "fleet",
                name: "Power",
                maxAgents: 5,
                maxCpuPerAgent: 4,
                maxRamPerAgent: 8192,
                totalCpu: 4,
                totalRam: 8192,
              },
            },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        return Promise.resolve(jsonResponse({ success: true, data: { id: "inst-power" } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });

    // The size pickers live behind Advanced setup; the plan-derived default
    // snaps to the largest option the plan allows (4 CPU / 8 GB for Power).
    fireEvent.click(screen.getByRole("button", { name: /advanced setup/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "4", pressed: true })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^8\s?G$/, pressed: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/instances",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/instances" && init?.method === "POST",
    );
    const payload = JSON.parse(String(createCall?.[1]?.body ?? "{}"));
    expect(payload.cpuLimit).toBe(4);
    expect(payload.ramLimit).toBe(8192);
  });

  it("starts Stripe directly for managed Venice card credits", async () => {
    render(<WelcomeFlow />);

    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    // Funding is now a secondary path — the primary CTA stays "Deploy Agent".
    fireEvent.click(screen.getByRole("button", { name: /add credit first/i }));
    expect(screen.getByRole("button", { name: /start card credit top-up/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /pay with \$HermesOS/i })).not.toBeVisible();
    expect(screen.getByText("Optional token top-up").closest("details")).not.toHaveAttribute("open");

    expect(screen.queryByText(/^Bonus$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /start card credit top-up/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/billing/managed-venice/card/top-up",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ amountMicroUsd: 50_000_000 }),
        })
      );
    });

    expect(redirectToCheckoutUrl).toHaveBeenCalledWith(
      "https://checkout.stripe.test/managed-venice-card"
    );
    expect(screen.queryByRole("dialog", { name: /top up managed Venice credits/i })).not.toBeInTheDocument();
  });

  it("never re-shows the payment picker to a user returning from successful checkout, even when the webhook is slow", async () => {
    // The old 3s Promise.race always beat the 5×1.5s webhook-retry loop, so a
    // just-paid user saw "How do you want to pay?" again (double-purchase risk).
    mockGet.mockImplementation((key: string) => {
      if (key === "subscription") return "success";
      return null;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        // Webhook never lands within the retry window.
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: false, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 0, totalRam: 0 } },
          }),
        );
      }
      if (url === "/api/billing/wallet/eligibility") {
        return Promise.resolve(jsonResponse({ success: true, data: { tiers: {} } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);

    // The retry loop owns the flow: it must land on the sync-pending recovery
    // state — the payment picker must never appear on the success path.
    await screen.findByText(
      /Payment confirmed — still syncing your subscription/i,
      undefined,
      { timeout: 15_000 },
    );
    expect(screen.queryByText(/How do you want to pay\?/i)).not.toBeInTheDocument();
  }, 20_000);

  it("replaces raw infrastructure errors with calm copy and tags the analytics event with the real reason", async () => {
    const rawInfraError =
      "Deployment failed: [caddy] missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards/hermesos.cloud.{crt,key}; seed the host before provisioning";
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({ success: false, error: rawInfraError }));
        }
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    // The insight system maps host-internal raws to the humane capacity
    // headline and suppresses the internals even from the detail line.
    await screen.findByText(/temporarily at capacity/i);
    expect(screen.queryByText(/caddy|wildcards|seed the host/i)).not.toBeInTheDocument();
    expect(posthog.capture).toHaveBeenCalledWith(
      "activation_failed",
      expect.objectContaining({
        errorCategory: "capacity",
        stage: "create_instance",
        status: 200,
        errorMessage: expect.stringContaining("[caddy]"),
      }),
    );
  });

  it("does not hijack a different in-flight instance when the deploy fails and only a foreign row exists", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve(jsonResponse({ success: true, data: zeroManagedVeniceSummary }));
      }
      if (url === "/api/instances") {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse({ success: false, error: "Deployment failed" }));
        }
        // Someone ELSE's just-created instance — name does not match ours.
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: [
              {
                id: "inst-foreign",
                name: "SOMEBODY_ELSES_AGENT",
                status: "provisioning",
                lifecycle_state: "provisioning",
                provider: "nous",
                created_at: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();
    await screen.findByRole("button", { name: /^deploy (hermes agent|claude code)$/i });
    fireEvent.click(screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }));

    // The old inProgress[0] fallback would route to (and PATCH the system
    // prompt of) the foreign instance. Now: surface the failure instead.
    await screen.findByText(/Deployment failed/i);
    expect(mockPush).not.toHaveBeenCalledWith(expect.stringContaining("inst-foreign"));
  });

  it("lets the user deploy with an unknown managed Venice balance instead of forcing the funding wall", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/vault") return Promise.resolve(jsonResponse({ success: true, data: [] }));
      if (url === "/api/billing/usage") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { subscribed: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 }, plan: { totalCpu: 2, totalRam: 4096 } },
          }),
        );
      }
      if (url === "/api/billing/managed-venice/summary") {
        // Summary route 500s — the balance is UNKNOWN, not zero.
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ success: false }),
        } as Response);
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    });

    render(<WelcomeFlow />);
    await chooseHermesAgent();

    await screen.findByText(/Couldn't load your credit balance/i);
    expect(
      screen.getByRole("button", { name: /^deploy (hermes agent|claude code)$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue to managed credits/i }),
    ).not.toBeInTheDocument();
  });
});

describe("optional payment choices", () => {
  const props = {
    tiers: [], onSelectFree: jest.fn(), onDeposit: jest.fn(), onSelectCard: jest.fn(),
    onSelectCryptoYearly: jest.fn(), setPaidPathChoice: jest.fn(), cardCadence: "yearly" as const,
    setCardCadence: jest.fn(), cryptoMode: "yearly" as const, setCryptoMode: jest.fn(),
    cardCheckoutLoadingTier: null, freeActivationLoading: false,
  };
  const previous = process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    else process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED = previous;
  });
  it("shows card and free options without a mandatory payment fork when crypto is off", () => {
    delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    render(<TierPickerCards {...props} paidPathChoice="card" />);
    expect(screen.getByText("Paying with Card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start with Free" })).toBeInTheDocument();
    expect(screen.queryByText("How do you want to pay?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Other payment options" })).not.toBeInTheDocument();
  });
  it("reveals enabled token selection only after opening other payment options", () => {
    process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED = "true";
    function Harness() {
      const [choice, setChoice] = React.useState<"card" | "crypto" | null>("card");
      return <TierPickerCards {...props} paidPathChoice={choice} setPaidPathChoice={setChoice} />;
    }
    render(<Harness />);
    expect(screen.queryByText("How do you want to pay?")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Other payment options" }));
    expect(screen.getByText("How do you want to pay?")).toBeInTheDocument();
    expect(screen.getByText("$HermesOS")).toBeInTheDocument();
  });
});
