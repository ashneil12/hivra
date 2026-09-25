/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

import { AgentActivityPanel } from "../AgentActivityPanel";
import { fetchPlanStrict, type PlanInfo } from "@/lib/hivra/agent-api";

// captureClient is best-effort telemetry — stub it so the panel's mount event
// doesn't need a live PostHog.
jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

// Keep the real isFreePlanInfo (the gate under test); only stub the network
// fetchPlanStrict so we can drive free vs paid vs unknown.
jest.mock("@/lib/hivra/agent-api", () => {
  const actual = jest.requireActual("@/lib/hivra/agent-api");
  return { ...actual, fetchPlanStrict: jest.fn() };
});

// Marker mocks for children we're not exercising here.
jest.mock("@/components/stats/Sparkline", () => ({
  Sparkline: () => <div data-testid="sparkline" />,
}));
jest.mock("@/components/billing/UsageUpgradeFooter", () => ({
  UsageUpgradeFooter: () => <div data-testid="usage-upgrade-footer">footer</div>,
}));

const FREE_PLAN: PlanInfo = {
  subscribed: false,
  name: "Free",
  key: "free",
  maxAgents: 1,
  maxCpuPerAgent: 0.5,
  maxRamPerAgent: 1,
  poolCpu: 0.5,
  poolRam: 1,
};
const PRO_PLAN: PlanInfo = { ...FREE_PLAN, subscribed: true, name: "Pro", key: "operator" };

const EMPTY_HIVRA = {
  eventCount: 0,
  byEvent: [],
  byAgentType: [],
  activeDays: 0,
  desktopSessions: 0,
  desktopDays: 0,
  daily: [],
  fleet: { runningAgents: 0, totalAgents: 0, firstAgentAt: null, byStatus: {} },
  recent: [],
  truncated: false,
};

const ACTIVITY_WITH_USAGE = {
  totals: {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0.12,
    sessions: 3,
    apiCalls: 10,
    toolCalls: 4,
  },
  daily: [{ date: "2026-07-01", totalTokens: 150, estimatedCostUsd: 0.12, sessions: 3 }],
  topModels: [{ model: "anthropic/claude", totalTokens: 150 }],
  topSkills: [{ skill: "search", count: 4 }],
  instanceCount: 1,
  activeDays: 1,
  hivra: EMPTY_HIVRA,
  coverage: "usage" as const,
  generatedAt: new Date().toISOString(),
};

/**
 * No usage, no boxes, no events — the only genuinely-empty account. Every
 * metered term must be zeroed, cost included: `hasUsage` counts spend, so
 * leaving the fixture's `estimatedCostUsd` set would make this "empty" payload
 * render the usage view and quietly invalidate the empty-state assertions.
 */
const EMPTY_ACTIVITY = {
  ...ACTIVITY_WITH_USAGE,
  totals: {
    ...ACTIVITY_WITH_USAGE.totals,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    sessions: 0,
    apiCalls: 0,
    toolCalls: 0,
  },
  daily: [],
  topModels: [],
  topSkills: [],
  instanceCount: 0,
  activeDays: 0,
  coverage: "none" as const,
};

/**
 * Ash's exact situation: a Hivra-lane customer with real recorded activity and
 * zero metered Hermes usage. This is the regression fixture — before the fix
 * this payload rendered "No usage yet", which was false.
 */
const HIVRA_ONLY_ACTIVITY = {
  ...EMPTY_ACTIVITY,
  coverage: "activity" as const,
  hivra: {
    ...EMPTY_HIVRA,
    eventCount: 309,
    activeDays: 23,
    desktopSessions: 231,
    desktopDays: 15,
    fleet: {
      runningAgents: 7,
      totalAgents: 11,
      firstAgentAt: "2026-06-05T17:06:26.695615+00:00",
      byStatus: { running: 7, stopped: 3, error: 1 },
    },
    byEvent: [
      { event: "provisioned", count: 82 },
      { event: "launch_requested", count: 59 },
    ],
    byAgentType: [{ agentType: "codex", count: 141 }],
    daily: [{ date: "2026-09-06", count: 83 }],
    recent: [
      {
        id: "e1",
        event: "restarted",
        agentType: "linux-desktop",
        agentId: "a1",
        createdAt: new Date().toISOString(),
      },
    ],
  },
};

const FLAG = "NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED";
let originalFlag: string | undefined;

function mockActivityFetch(payload: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: payload }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  originalFlag = process.env[FLAG];
  delete process.env[FLAG];
  (fetchPlanStrict as jest.Mock).mockResolvedValue(FREE_PLAN);
  mockActivityFetch(ACTIVITY_WITH_USAGE);
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

describe("AgentActivityPanel — usage upgrade footer gating", () => {
  it("renders the footer for a FREE user with usage when the flag is ON", async () => {
    process.env[FLAG] = "1";
    (fetchPlanStrict as jest.Mock).mockResolvedValue(FREE_PLAN);
    render(<AgentActivityPanel />);

    expect(await screen.findByTestId("usage-upgrade-footer")).toBeInTheDocument();
  });

  it("NEVER renders the footer for a PAID user, even with the flag ON", async () => {
    process.env[FLAG] = "1";
    (fetchPlanStrict as jest.Mock).mockResolvedValue(PRO_PLAN);
    render(<AgentActivityPanel />);

    // Wait for the ready render + the plan fetch to resolve, then assert absence.
    expect(await screen.findByText(/total tokens/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrict).toHaveBeenCalled());
    expect(screen.queryByTestId("usage-upgrade-footer")).not.toBeInTheDocument();
  });

  it("does NOT render the footer when the flag is OFF, and skips the plan fetch entirely", async () => {
    delete process.env[FLAG];
    (fetchPlanStrict as jest.Mock).mockResolvedValue(FREE_PLAN);
    render(<AgentActivityPanel />);

    expect(await screen.findByText(/total tokens/i)).toBeInTheDocument();
    // Dark feature = zero extra API calls: the plan fetch must not even fire.
    expect(fetchPlanStrict).not.toHaveBeenCalled();
    expect(screen.queryByTestId("usage-upgrade-footer")).not.toBeInTheDocument();
  });

  it("does NOT render the footer when the plan is UNKNOWN (strict fetch failed)", async () => {
    process.env[FLAG] = "1";
    (fetchPlanStrict as jest.Mock).mockResolvedValue(null);
    render(<AgentActivityPanel />);

    expect(await screen.findByText(/total tokens/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrict).toHaveBeenCalled());
    expect(screen.queryByTestId("usage-upgrade-footer")).not.toBeInTheDocument();
  });

  it("does NOT render the footer when there's no usage yet (nothing to show off)", async () => {
    process.env[FLAG] = "1";
    (fetchPlanStrict as jest.Mock).mockResolvedValue(FREE_PLAN);
    // Genuinely empty on BOTH lanes and with no boxes. Previously this test
    // used a zero-usage payload with boxes present, encoding "empty Hermes ==
    // empty account" as correct — which is the defect.
    mockActivityFetch(EMPTY_ACTIVITY);
    render(<AgentActivityPanel />);

    expect(await screen.findByText(/no activity recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("usage-upgrade-footer")).not.toBeInTheDocument();
  });
});

describe("AgentActivityPanel — lane coverage", () => {
  it("renders recorded activity (not the empty state) for a Hivra-only customer", async () => {
    mockActivityFetch(HIVRA_ONLY_ACTIVITY);
    render(<AgentActivityPanel />);

    // The reported bug: this payload used to render "No usage yet".
    expect(await screen.findByText(/recorded activity/i)).toBeInTheDocument();
    expect(screen.queryByText(/no usage yet/i)).not.toBeInTheDocument();

    // Real numbers from the payload, not placeholders.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("309")).toBeInTheDocument();
    expect(screen.getByText("231")).toBeInTheDocument();
    expect(screen.getByText(/82/)).toBeInTheDocument();
  });

  it("shows an agent added to a computer in the timeline in its own words, not the raw event name", async () => {
    mockActivityFetch({ ...HIVRA_ONLY_ACTIVITY, hivra: { ...HIVRA_ONLY_ACTIVITY.hivra,
      byEvent: [{ event: "agent_removed", count: 1 }, { event: "agent_access_changed", count: 1 }],
      recent: [{ id: "e2", event: "agent_attached", agentType: "linux-desktop", agentId: "a1", createdAt: new Date().toISOString(),
        summary: "Codex added to MY_UBUNTU_DESKTOP · access: ~/Hivra read and write, internet" }] } });
    render(<AgentActivityPanel />);
    expect(await screen.findByText("Codex added to MY_UBUNTU_DESKTOP · access: ~/Hivra read and write, internet")).toBeInTheDocument();
    expect(screen.getByText("Agent removed · files in ~/Hivra kept")).toBeInTheDocument();
    expect(screen.getByText("Access changed")).toBeInTheDocument();
    expect(screen.queryByText(/agent attached|agent removed/)).not.toBeInTheDocument();
  });

  it("never renders a token or dollar figure for Hivra-lane activity", async () => {
    mockActivityFetch(HIVRA_ONLY_ACTIVITY);
    const { container } = render(<AgentActivityPanel />);
    await screen.findByText(/recorded activity/i);

    // These boxes run BYO keys — no metering exists, so claiming any would lie.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/total tokens/i);
    expect(text).not.toMatch(/est\. cost/i);
    expect(screen.queryByText(/token volume/i)).not.toBeInTheDocument();
  });

  it("distinguishes 'boxes but nothing recorded' from 'no boxes at all'", async () => {
    mockActivityFetch({
      ...EMPTY_ACTIVITY,
      coverage: "activity" as const,
      hivra: {
        ...EMPTY_HIVRA,
        fleet: {
          runningAgents: 2,
          totalAgents: 3,
          firstAgentAt: "2026-06-05T00:00:00.000Z",
          byStatus: { running: 2, stopped: 1 },
        },
      },
    });
    render(<AgentActivityPanel />);

    // Must not tell a user with 3 boxes that they have never used the product.
    expect(await screen.findByText(/you have 3 agents/i)).toBeInTheDocument();
    expect(screen.queryByText(/no activity recorded yet/i)).not.toBeInTheDocument();
  });

  it("keeps rendering Hermes usage when the Hivra lane alone degrades", async () => {
    mockActivityFetch({
      ...ACTIVITY_WITH_USAGE,
      hivra: { ...EMPTY_HIVRA, degraded: true },
    });
    render(<AgentActivityPanel />);

    // One lane's hiccup must not blank the other lane's real data.
    expect(await screen.findByText(/total tokens/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load your agent's activity just now/i)).not.toBeInTheDocument();
  });

  it("counts spend-only metered usage as usage, not as no-usage", async () => {
    // A snapshot can carry cost without a token count. Gating on tokens alone
    // would render the Hivra section's "we don't meter you" disclaimer over a
    // real Hermes invoice.
    mockActivityFetch({
      ...ACTIVITY_WITH_USAGE,
      totals: {
        ...ACTIVITY_WITH_USAGE.totals,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        sessions: 0,
        apiCalls: 0,
        toolCalls: 0,
        estimatedCostUsd: 1.23,
      },
      hivra: EMPTY_HIVRA,
      coverage: "usage" as const,
    });
    render(<AgentActivityPanel />);

    expect(await screen.findByText(/est\. cost/i)).toBeInTheDocument();
    expect(screen.queryByText(/no activity recorded yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/does not meter their tokens/i)).not.toBeInTheDocument();
  });

  it("tolerates an older server payload with no hivra field (rolling deploy)", async () => {
    // Cast through unknown rather than destructure-and-discard: the point is a
    // payload that genuinely lacks the new fields, which the type forbids.
    const legacy = { ...ACTIVITY_WITH_USAGE } as Record<string, unknown>;
    delete legacy.hivra;
    delete legacy.coverage;
    mockActivityFetch(legacy);
    render(<AgentActivityPanel />);

    expect(await screen.findByText(/total tokens/i)).toBeInTheDocument();
  });
});
