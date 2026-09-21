/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { HermesDashboardPage as DashboardPage } from "@/components/dashboard/HermesDashboardPage";

const pushMock = jest.fn();
const replaceMock = jest.fn();
let hivraEnabledMock = false;
let mockClerkUser = {
  id: "user_123",
  primaryEmailAddress: { emailAddress: "person@example.com" },
  emailAddresses: [{ emailAddress: "person@example.com" }],
};

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
}));

jest.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: true,
    user: mockClerkUser,
  }),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ unoptimized, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => {
    void unoptimized;
    // eslint-disable-next-line @next/next/no-img-element -- test double for next/image intentionally renders a plain img.
    return <img {...props} alt={alt ?? ""} />;
  },
}));

jest.mock("framer-motion", () => {
  const forwardProps = <T extends object>(props: T): T => {
    const cleanRest = { ...props } as T & Record<string, unknown>;
    delete cleanRest.initial;
    delete cleanRest.animate;
    delete cleanRest.exit;
    delete cleanRest.transition;
    delete cleanRest.variants;
    delete cleanRest.whileHover;
    return cleanRest;
  };

  const MotionDiv = (props: React.HTMLAttributes<HTMLDivElement>) => <div {...forwardProps(props)} />;
  MotionDiv.displayName = "MotionDiv";

  const MotionHeader = (props: React.HTMLAttributes<HTMLElement>) => <header {...forwardProps(props)} />;
  MotionHeader.displayName = "MotionHeader";

  const MotionH3 = (props: React.HTMLAttributes<HTMLHeadingElement>) => <h3 {...forwardProps(props)} />;
  MotionH3.displayName = "MotionH3";

  const MotionSpan = (props: React.HTMLAttributes<HTMLSpanElement>) => <span {...forwardProps(props)} />;
  MotionSpan.displayName = "MotionSpan";

  return {
    motion: {
      div: MotionDiv,
      header: MotionHeader,
      h3: MotionH3,
      span: MotionSpan,
    },
    useReducedMotion: () => false,
  };
});

jest.mock("../welcome/page", () => ({
  __esModule: true,
  default: () => <div>Welcome</div>,
}));

jest.mock("@/components/InteractiveBackground", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/TelemetryGrid", () => ({
  TelemetryGrid: () => null,
}));

jest.mock("@/lib/client-storage", () => ({
  readStoredJson: jest.fn(() => null),
  writeStoredJsonIfChanged: jest.fn(),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@/lib/hivra/hivra-flag", () => ({
  isHivraEnabled: () => hivraEnabledMock,
}));

function commandCenterV2FlagResponse(enabled = false) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { enabled },
    }),
  } as Response);
}

describe("DashboardPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hivraEnabledMock = false;
    mockClerkUser = {
      id: "user_123",
      primaryEmailAddress: { emailAddress: "person@example.com" },
      emailAddresses: [{ emailAddress: "person@example.com" }],
    };
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(false);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "inst-123",
                name: "Atlas",
                status: "running",
                provider: "openai",
                public_ipv4: "203.0.113.10",
                cpu_limit: 2,
                ram_limit: 4096,
                updateAlert: {
                  title: "Auto-update failed",
                  message: "Auto-update reported a host-side failure.",
                  lastSeenAt: "2026-04-23T06:00:00.000Z",
                  runType: "scheduled",
                },
                failureAlert: {
                  title: "Provider authentication failed",
                  message: "OpenRouter rejected the saved key.",
                  lastSeenAt: "2026-05-05T08:00:00.000Z",
                  owner: "user",
                  ownerLabel: "Your action needed",
                  phase: "auth",
                  phaseLabel: "Authentication",
                  severity: "error",
                  recoveryAction: "update_provider_key",
                  recoveryLabel: "Update provider key",
                },
              },
            ],
          }),
        } as Response);
      }

      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              wallets: {
                hermesos: {
                  tokenDisplay: "0 Hivra",
                  lockedValueMicroUsd: 0,
                  availableMicroUsd: 0,
                  reservedMicroUsd: 0,
                },
                card: {
                  balanceMicroUsd: 0,
                  availableMicroUsd: 0,
                  reservedMicroUsd: 0,
                },
              },
            },
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/profiles") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [],
          }),
        } as Response);
      }

      if (url === "/api/hosts") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [],
          }),
        } as Response);
      }

      if (url === "/api/billing/usage") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              subscribed: true,
              plan: {
                maxCpuPerAgent: 8,
                maxRamPerAgent: 16384,
                totalCpu: 8,
                totalRam: 16384,
              },
              usage: {
                usedCpu: 2,
                usedRam: 4096,
              },
            },
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/activity") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              state: "idle",
              headline: "Waiting for your next message",
              detail: "Recent session activity is available.",
              lastActiveAt: null,
              activeStreams: 0,
              source: "webui",
              recentSessions: [],
              attentionItems: [],
            },
          }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as jest.Mock;
  });

  it("shows the public IPv4 on instance cards when available", async () => {
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
    });

    expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
  });

  it("does not send Hivra users back to welcome when legacy instances are empty", async () => {
    hivraEnabledMock = true;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(false);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({ success: true, data: [] }),
        } as Response);
      }

      if (url === "/api/hivra/agents") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              agents: [
                { id: "agent-claude", type: "claude-code", name: "Claude Code", status: "running", cpu: 0.5, ram: 1 },
              ],
            },
          }),
        } as Response);
      }

      if (url === "/api/hosts") {
        return Promise.resolve({
          json: async () => ({ success: true, data: [] }),
        } as Response);
      }

      if (url === "/api/billing/usage") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              subscribed: true,
              plan: { maxCpuPerAgent: 8, maxRamPerAgent: 16384, totalCpu: 8, totalRam: 16384 },
              usage: { usedCpu: 0.5, usedRam: 1024, agentCount: 1 },
            },
          }),
        } as Response);
      }

      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              wallets: {
                hermesos: { tokenDisplay: "0 Hivra", lockedValueMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
                card: { balanceMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
              },
            },
          }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as jest.Mock;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });
    expect(replaceMock).not.toHaveBeenCalledWith("/dashboard/welcome");
  });

  it("renders the Command Center dashboard chrome in Chinese", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(false);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "inst-123",
                name: "Atlas",
                status: "running",
                provider: "openrouter",
                config: { model: "google/gemma-4-26b" },
              },
            ],
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/profiles") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              { name: "default", display_name: "Ash" },
              { name: "atlas", display_name: "atlas" },
            ],
          }),
        } as Response);
      }

      if (url === "/api/hosts") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [],
          }),
        } as Response);
      }

      if (url === "/api/billing/usage") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              subscribed: true,
              plan: {
                maxCpuPerAgent: 8,
                maxRamPerAgent: 16384,
                totalCpu: 8,
                totalRam: 16384,
              },
              usage: {
                usedCpu: 2,
                usedRam: 4096,
              },
            },
          }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as jest.Mock;

    render(
      <LocaleProvider initialLocale="zh-CN">
        <DashboardPage />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByText((_, element) => element?.tagName.toLowerCase() === "h2" && element.textContent === "指挥中心。"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("第二阶段：舰队运营")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("活跃 Agent")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "核心控制台" })).toBeInTheDocument();
    expect(screen.getAllByText("运行中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("档案节点")).toHaveLength(2);
    expect(screen.getAllByText("主机实例：Atlas")).toHaveLength(2);
    expect(screen.getByText("主 Agent")).toBeInTheDocument();
    expect(screen.getByText("次级 Agent")).toBeInTheDocument();
    expect(screen.queryByText("Command Center.")).not.toBeInTheDocument();
    expect(screen.queryByText("Active Agents")).not.toBeInTheDocument();
  });

  it("flags update failures on the dashboard", async () => {
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getAllByText(/update attention needed/i).length).toBeGreaterThan(0);
    });

    expect(
      screen.getByText(/Hermes saw an update problem on 1 instance/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The last auto-update failed\. Your Docker volumes stay mounted/i)
    ).toBeInTheDocument();
  });

  it("flags active failure ownership on the dashboard", async () => {
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/active failure needs attention/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Hermes found an active failure on 1 instance/i)).toBeInTheDocument();
    const banner = screen.getByTestId("dashboard-failure-alerts");
    expect(within(banner).getByText(/Atlas/)).toBeInTheDocument();
    expect(within(banner).getByText(/Your action needed/)).toBeInTheDocument();
    expect(within(banner).getByText(/Provider authentication failed/)).toBeInTheDocument();
    expect(within(banner).getByText(/Update provider key/)).toBeInTheDocument();
  });

  it("renders the command cockpit with WebUI activity and LLM credits", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(false);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "inst-123",
                name: "Atlas",
                status: "running",
                provider: "venice",
                backend: "webui",
                config: { model: "glm-5.1" },
              },
            ],
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/profiles") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [],
          }),
        } as Response);
      }

      if (url === "/api/hosts") {
        return Promise.resolve({ json: async () => ({ success: true, data: [] }) } as Response);
      }

      if (url === "/api/billing/usage") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              subscribed: true,
              plan: {
                maxCpuPerAgent: 8,
                maxRamPerAgent: 16384,
                totalCpu: 8,
                totalRam: 16384,
              },
              usage: {
                usedCpu: 2,
                usedRam: 4096,
              },
            },
          }),
        } as Response);
      }

      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              wallets: {
                hermesos: {
                  tokenDisplay: "1,039,502 Hivra",
                  lockedValueMicroUsd: 12_000_000,
                  availableMicroUsd: 12_000_000,
                  reservedMicroUsd: 0,
                },
                card: {
                  balanceMicroUsd: 5_000_000,
                  availableMicroUsd: 5_000_000,
                  reservedMicroUsd: 0,
                },
              },
            },
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/activity") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              state: "responding",
              headline: "Responding now",
              detail: "Hermes WebUI reports active agent work.",
              lastActiveAt: "2026-05-16T10:00:00.000Z",
              activeStreams: 1,
              source: "webui",
              recentSessions: [
                {
                  id: "sess-1",
                  title: "Market research",
                  updatedAt: "2026-05-16T10:00:00.000Z",
                  messageCount: 8,
                  model: "glm-5.1",
                  estimatedCostUsd: 0.0042,
                },
              ],
              attentionItems: [],
            },
          }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as jest.Mock;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Responding now")).toBeInTheDocument();
    });

    expect(screen.getByText("Live Work")).toBeInTheDocument();
    expect(screen.getByText("Market research")).toBeInTheDocument();
    expect(screen.getByText("LLM Credits")).toBeInTheDocument();
    expect(screen.getByText("$17.0000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /top up llm credits/i }));

    expect(pushMock).toHaveBeenCalledWith("/dashboard/billing?managedVenice=deposit&wallet=hermesos");
  });

  it("keeps the Command Center v2 surface hidden for non-pilot users on main", async () => {
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Operations Cockpit")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("command-center-v2")).not.toBeInTheDocument();
    expect(screen.queryByText(/Command Center Pilot/i)).not.toBeInTheDocument();
  });

  it("renders the gated Command Center v2 for the pilot with live work and credit controls", async () => {
    mockClerkUser = {
      id: "user_fixture_pilot",
      primaryEmailAddress: { emailAddress: "pilot@example.com" },
      emailAddresses: [{ emailAddress: "pilot@example.com" }],
    };
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(true);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "inst-123",
                name: "Atlas",
                status: "running",
                provider: "venice",
                backend: "webui",
                public_ipv4: "203.0.113.10",
                config: {
                  model: "glm-5.1",
                  managedVenice: { enabled: true, walletType: "hermesos" },
                },
              },
            ],
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/profiles") {
        return Promise.resolve({ json: async () => ({ success: true, data: [] }) } as Response);
      }

      if (url === "/api/hosts") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "host-1",
                name: "Fleet Node 1",
                status: "running",
                total_cpu: 8,
                total_ram: 16384,
                used_cpu: 2,
                used_ram: 4096,
                agent_count: 1,
              },
            ],
          }),
        } as Response);
      }

      if (url === "/api/billing/usage") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              subscribed: true,
              plan: {
                maxCpuPerAgent: 8,
                maxRamPerAgent: 16384,
                totalCpu: 8,
                totalRam: 16384,
              },
              usage: {
                usedCpu: 2,
                usedRam: 4096,
              },
            },
          }),
        } as Response);
      }

      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              wallets: {
                hermesos: {
                  tokenDisplay: "1,039,502 Hivra",
                  lockedValueMicroUsd: 12_000_000,
                  availableMicroUsd: 12_000_000,
                  reservedMicroUsd: 0,
                },
                card: {
                  balanceMicroUsd: 5_000_000,
                  availableMicroUsd: 5_000_000,
                  reservedMicroUsd: 0,
                },
              },
              discount: {
                rate: "launch_20",
                discountBps: 2000,
                launchSubsidyUsedMicroUsd: 187_000_000,
                launchSubsidyCapMicroUsd: 250_000_000,
              },
              killSwitch: {
                active: false,
                weeklySubsidyUsedMicroUsd: 780_000_000,
                thresholdMicroUsd: 1_000_000_000,
              },
              keys: [
                {
                  id: "key_1",
                  name: "Atlas managed Venice",
                  keyPrefix: "hven_live_abc",
                  status: "active",
                  createdAt: "2026-05-16T10:00:00.000Z",
                  updatedAt: "2026-05-16T10:00:00.000Z",
                  lastUsedAt: null,
                  revokedAt: null,
                  pausedReason: null,
                  defaultWalletType: "hermesos",
                },
              ],
            },
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/activity") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              state: "responding",
              headline: "Responding now",
              detail: "Hermes WebUI reports active agent work.",
              lastActiveAt: "2026-05-16T10:00:00.000Z",
              activeStreams: 1,
              source: "webui",
              recentSessions: [
                {
                  id: "sess-1",
                  title: "Market research",
                  updatedAt: "2026-05-16T10:00:00.000Z",
                  messageCount: 8,
                  model: "glm-5.1",
                  estimatedCostUsd: 0.0042,
                },
              ],
              attentionItems: [],
            },
          }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as jest.Mock;

    render(<DashboardPage />);

    expect(await screen.findByTestId("command-center-v2")).toBeInTheDocument();
    expect(screen.getByText(/Command Center Pilot/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent Activity/i)).toBeInTheDocument();
    expect(screen.queryByText(/Fleet runway/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Polling Hermes WebUI/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Atlas is responding now/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/^Credits$/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/General Credits/i)).toBeInTheDocument();
    expect(screen.getByText(/\$187\.00 of \$250\.00 used/i)).toBeInTheDocument();
    expect(screen.queryByText(/Proxy Keys/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/active proxy key/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^credits$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Fleet Node 1/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /advanced console/i }));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/instances/inst-123/console");

    fireEvent.click(screen.getByRole("button", { name: /top up llm credits/i }));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/billing?managedVenice=deposit&wallet=hermesos");
  });

  it("uses the manual-update copy when the latest failed run was manual", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(false);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "inst-123",
                name: "Atlas",
                status: "running",
                provider: "openai",
                updateAlert: {
                  title: "Manual update failed",
                  message: "Manual update reported a host-side failure.",
                  lastSeenAt: "2026-04-23T06:00:00.000Z",
                  runType: "manual",
                },
              },
            ],
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-123/profiles") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [],
          }),
        } as Response);
      }

      if (url === "/api/hosts") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [],
          }),
        } as Response);
      }

      if (url === "/api/billing/usage") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              subscribed: true,
              plan: {
                maxCpuPerAgent: 8,
                maxRamPerAgent: 16384,
                totalCpu: 8,
                totalRam: 16384,
              },
              usage: {
                usedCpu: 2,
                usedRam: 4096,
              },
            },
          }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as jest.Mock;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/The last manual update failed\. Your Docker volumes stay mounted/i)).toBeInTheDocument();
    });
  });

  it("shows a load error instead of onboarding when the dashboard fetch fails", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as jest.Mock;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load operations data")).toBeInTheDocument();
    });

    expect(screen.queryByText("Welcome")).not.toBeInTheDocument();
  });

  it("does not poll /profiles when the only instance is paused/stopped/provisioning", async () => {
    // Regression for the ~130 warn/hour `/api/instances/<id>/profiles 400
    // Instance is not currently running` spike: when a user's single
    // instance is not in `status: running`, the dashboard poll loop must
    // not hit the profiles endpoint every 10s — the route would only
    // ever 400 until the VM is back up.
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(false);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "inst-paused",
                name: "Hibernating",
                status: "stopped",
                provider: "openai",
              },
            ],
          }),
        } as Response);
      }
      if (url === "/api/hosts") {
        return Promise.resolve({ json: async () => ({ success: true, data: [] }) } as Response);
      }
      if (url === "/api/billing/usage") {
        return Promise.resolve({ json: async () => ({ success: true, data: { subscribed: false } }) } as Response);
      }
      // Primary-agent panel's one-shot recent-work card (AgentUsageSummary).
      if (url.includes("/usage-summary")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { days: 7, sessions: 0, apiCalls: 0, toolCalls: 0, totalTokens: 0, estimatedCostUsd: 0, activeDays: 0, lastActiveDate: null, topModel: null, isEmpty: true } }),
        } as Response);
      }

      // If the dashboard polling regresses and hits the profiles endpoint,
      // bubble that up as an explicit assertion failure rather than
      // silently swallowing it with a stub.
      throw new Error(`Unexpected fetch: ${url}`);
    }) as jest.Mock;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Hibernating").length).toBeGreaterThan(0);
    });

    const profileCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("/profiles"),
    );
    expect(profileCalls).toHaveLength(0);
  });

  it("offers a Start restore action for a cold-archived agent and posts start when clicked", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/features/command-center-v2") {
        return commandCenterV2FlagResponse(false);
      }

      if (url === "/api/instances?summary=true") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: [
              {
                id: "inst-cold",
                name: "Artoo",
                status: "stopped",
                lifecycle_state: "cold_archived",
                paused_reason: "cold_archived",
                provider: "openai",
                backend: "webui",
                public_ipv4: null,
                cpu_limit: 2,
                ram_limit: 1024,
                config: { model: "gpt-test" },
                updateAlert: null,
                failureAlert: null,
              },
            ],
          }),
        } as Response);
      }

      if (url === "/api/instances/inst-cold" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        } as Response);
      }

      if (url === "/api/hosts") {
        return Promise.resolve({ json: async () => ({ success: true, data: [] }) } as Response);
      }

      if (url === "/api/billing/usage") {
        return Promise.resolve({ json: async () => ({ success: true, data: { subscribed: false } }) } as Response);
      }

      if (url === "/api/billing/managed-venice/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              wallets: {
                hermesos: {
                  tokenDisplay: "0 Hivra",
                  lockedValueMicroUsd: 0,
                  availableMicroUsd: 0,
                  reservedMicroUsd: 0,
                },
                card: {
                  balanceMicroUsd: 0,
                  availableMicroUsd: 0,
                  reservedMicroUsd: 0,
                },
              },
            },
          }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as jest.Mock;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /start restore/i }).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole("button", { name: /start restore/i })[0]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/instances/inst-cold",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        })
      );
    });
  });
});
