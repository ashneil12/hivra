/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import posthog from "posthog-js";

import { OnboardingChecklist } from "../OnboardingChecklist";
import { fetchPlan, listAgentsResult, telegramStatus } from "@/lib/hivra/agent-api";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  listAgentsResult: jest.fn(),
  fetchPlan: jest.fn(),
  telegramStatus: jest.fn(),
}));

// The real modal drags in subscription plumbing this suite doesn't exercise;
// a marker keeps the "locked opens the paywall with the right feature" check sharp.
jest.mock("@/components/billing/UpgradePaywallModal", () => ({
  UpgradePaywallModal: ({ feature, onClose }: { feature: string; onClose: () => void }) => (
    <div data-testid="paywall-modal" data-feature={feature}>
      <button type="button" onClick={onClose}>
        Close paywall
      </button>
    </div>
  ),
}));

const FREE_PLAN = {
  subscribed: false,
  name: "Free",
  key: "free",
  maxAgents: 1,
  maxCpuPerAgent: 0.5,
  maxRamPerAgent: 1,
  poolCpu: 0.5,
  poolRam: 1,
};

const PRO_PLAN = {
  ...FREE_PLAN,
  subscribed: true,
  name: "Operator",
  key: "operator",
};

const RUNNING_BOX = {
  id: "box-1",
  type: "claude-code",
  name: "ATLAS",
  status: "running",
  cpu: 2,
  ram: 4,
  chat_url: "https://box.example.com",
  api_token: "box-token",
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h old
  first_usage_at: null,
};

function freshInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst-1",
    status: "running",
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h old
    first_usage_at: null,
    ...overrides,
  };
}

describe("OnboardingChecklist", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    (listAgentsResult as jest.Mock).mockResolvedValue({ agents: [RUNNING_BOX], error: null });
    (fetchPlan as jest.Mock).mockResolvedValue(FREE_PLAN);
    (telegramStatus as jest.Mock).mockResolvedValue({ connected: false, active: false, ownerId: null });
  });

  it("renders item states: deploy done, message/telegram pending, Pro items locked on Free", async () => {
    render(<OnboardingChecklist instances={[freshInstance()]} />);

    expect(await screen.findByTestId("onboarding-checklist")).toBeInTheDocument();
    await waitFor(() =>
      expect(telegramStatus).toHaveBeenCalledWith("https://box.example.com", "box-token"),
    );

    expect(screen.getByText("Deploy your agent")).toBeInTheDocument();
    expect(screen.getByText("Send your first message")).toBeInTheDocument();
    expect(screen.getByText("Connect a channel (Telegram)")).toBeInTheDocument();
    expect(screen.getByText("Enable web browsing")).toBeInTheDocument();
    expect(screen.getByText("Add a scheduled task")).toBeInTheDocument();

    // Deploy is the only completed step → 1 of 5.
    expect(screen.getByText("1 of 5 done")).toBeInTheDocument();
    expect(screen.getAllByText("Pro")).toHaveLength(2);
  });

  it("marks the first-message item done from the HivraChat localStorage marker", async () => {
    window.localStorage.setItem("hermes:first_message_sent:box-1", new Date().toISOString());

    render(<OnboardingChecklist instances={[freshInstance()]} />);

    expect(await screen.findByText("2 of 5 done")).toBeInTheDocument();
  });

  it("marks the first-message item done from first_usage_at when no local marker exists", async () => {
    render(
      <OnboardingChecklist
        instances={[freshInstance({ first_usage_at: "2026-06-10T00:00:00.000Z" })]}
      />,
    );

    expect(await screen.findByText("2 of 5 done")).toBeInTheDocument();
  });

  it("marks the first-message item done from a Hivra agent first_usage_at when no local marker exists", async () => {
    (listAgentsResult as jest.Mock).mockResolvedValue({
      agents: [{ ...RUNNING_BOX, first_usage_at: "2026-06-10T00:00:00.000Z" }],
      error: null,
    });

    render(<OnboardingChecklist instances={[freshInstance()]} />);

    expect(await screen.findByText("2 of 5 done")).toBeInTheDocument();
  });

  it("marks the channel item done when a running box reports Telegram connected", async () => {
    (telegramStatus as jest.Mock).mockResolvedValue({ connected: true, active: true, ownerId: "1" });

    render(<OnboardingChecklist instances={[freshInstance()]} />);

    expect(await screen.findByText("2 of 5 done")).toBeInTheDocument();
  });

  it("opens the upgrade paywall (feature browser/cron) from locked items and captures the click", async () => {
    render(<OnboardingChecklist instances={[freshInstance()]} />);

    fireEvent.click(await screen.findByTestId("onboarding-item-browser"));
    expect(screen.getByTestId("paywall-modal")).toHaveAttribute("data-feature", "browser");
    expect(posthog.capture).toHaveBeenCalledWith(
      "onboarding_checklist_item_clicked",
      expect.objectContaining({ item: "browser", locked: true }),
    );
    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Close paywall"));
    expect(screen.queryByTestId("paywall-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("onboarding-item-cron"));
    expect(screen.getByTestId("paywall-modal")).toHaveAttribute("data-feature", "cron");
    expect(posthog.capture).toHaveBeenCalledWith(
      "onboarding_checklist_item_clicked",
      expect.objectContaining({ item: "cron", locked: true }),
    );
  });

  it("navigates instead of locking for paid plans and remembers the acknowledgement", async () => {
    (fetchPlan as jest.Mock).mockResolvedValue(PRO_PLAN);

    render(<OnboardingChecklist instances={[freshInstance()]} />);

    const browserItem = await screen.findByTestId("onboarding-item-browser");
    // Wait for the plan to land — the item unlocks (locked → pending) first.
    await waitFor(() => expect(browserItem).toHaveAttribute("data-state", "pending"));

    fireEvent.click(browserItem);
    expect(pushMock).toHaveBeenCalledWith("/dashboard/agent/box-1?tab=browser");
    expect(posthog.capture).toHaveBeenCalledWith(
      "onboarding_checklist_item_clicked",
      expect.objectContaining({ item: "browser", locked: false }),
    );
    expect(window.localStorage.getItem("hermes:onboarding_checklist_done:browser")).toBe("1");
    expect(screen.queryByTestId("paywall-modal")).not.toBeInTheDocument();
  });

  it("navigates to the box Telegram tab from the channel item", async () => {
    render(<OnboardingChecklist instances={[freshInstance()]} />);

    fireEvent.click(await screen.findByTestId("onboarding-item-telegram"));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/agent/box-1?tab=telegram");
    expect(posthog.capture).toHaveBeenCalledWith(
      "onboarding_checklist_item_clicked",
      expect.objectContaining({ item: "telegram", locked: false }),
    );
  });

  it("routes Hermes-lane users (no boxes) to the instance Telegram connect modal", async () => {
    (listAgentsResult as jest.Mock).mockResolvedValue({ agents: [], error: null });

    render(<OnboardingChecklist instances={[freshInstance()]} />);

    fireEvent.click(await screen.findByTestId("onboarding-item-telegram"));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/instances/inst-1?surface=chat&connect=telegram");
  });

  it("dismiss persists in localStorage, captures the event, and survives remount", async () => {
    const { unmount } = render(<OnboardingChecklist instances={[freshInstance()]} />);

    fireEvent.click(await screen.findByRole("button", { name: /dismiss checklist/i }));

    expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hermes:onboarding_checklist_dismissed")).toBe("1");
    expect(posthog.capture).toHaveBeenCalledWith(
      "onboarding_checklist_dismissed",
      expect.objectContaining({ done_count: expect.any(Number) }),
    );

    unmount();
    render(<OnboardingChecklist instances={[freshInstance()]} />);
    await waitFor(() => expect(listAgentsResult).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
  });

  it("stays hidden when the first deployment is older than 14 days", async () => {
    (listAgentsResult as jest.Mock).mockResolvedValue({ agents: [], error: null });
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

    render(<OnboardingChecklist instances={[freshInstance({ created_at: old })]} />);

    await waitFor(() => expect(listAgentsResult).toHaveBeenCalled());
    expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
  });

  it("stays hidden when nothing is deployed yet", async () => {
    (listAgentsResult as jest.Mock).mockResolvedValue({ agents: [], error: null });

    render(<OnboardingChecklist instances={[]} />);

    await waitFor(() => expect(listAgentsResult).toHaveBeenCalled());
    expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
  });

  it("skips the Hivra agents fetch when the lane is unavailable (legacy surface)", async () => {
    render(<OnboardingChecklist instances={[freshInstance()]} includeHivra={false} />);

    expect(await screen.findByTestId("onboarding-checklist")).toBeInTheDocument();
    expect(listAgentsResult).not.toHaveBeenCalled();
    expect(telegramStatus).not.toHaveBeenCalled();
  });
});
