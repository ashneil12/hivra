/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { GettingStarted } from "@/components/instances/GettingStarted";
import type { InstanceActivityDigest } from "@/lib/command-center/activity";

const idleDigest: InstanceActivityDigest = {
  state: "idle",
  headline: "Ready when you are",
  detail: "Send a message in the chat to put your agent to work.",
  lastActiveAt: "2026-05-16T10:00:00.000Z",
  activeStreams: 0,
  source: "webui",
  recentSessions: [],
  attentionItems: [],
};

const withSession: InstanceActivityDigest = {
  ...idleDigest,
  recentSessions: [
    {
      id: "s1",
      title: "First task",
      updatedAt: "2026-05-16T10:00:00.000Z",
      messageCount: 2,
      model: "glm-5.1",
      estimatedCostUsd: 0.001,
    },
  ],
};

describe("GettingStarted checklist", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the milestones for a fresh box", () => {
    render(<GettingStarted instanceId="box-1" digest={idleDigest} integrationStatuses={null} />);

    expect(screen.getByText("Getting started")).toBeInTheDocument();
    expect(screen.getByText("Your agent is awake")).toBeInTheDocument();
    expect(screen.getByText("Connect a chat channel")).toBeInTheDocument();
    expect(screen.getByText("Send your first task")).toBeInTheDocument();
    // "awake" is done (idle = running)
    expect(screen.getByTestId("checklist-item:Your agent is awake")).toHaveAttribute("data-done", "true");
  });

  it("does NOT render while the digest is still loading (no flash of an all-open list)", () => {
    render(<GettingStarted instanceId="box-1" digest={null} loading />);
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
  });

  it("marks 'Connect a chat channel' done when a channel is configured", () => {
    render(
      <GettingStarted
        instanceId="box-1"
        digest={idleDigest}
        integrationStatuses={{ Telegram: { configured: true } }}
      />,
    );
    expect(screen.getByTestId("checklist-item:Connect a chat channel")).toHaveAttribute("data-done", "true");
  });

  it("shows the app step only when appStepEnabled, and marks it done when connected", () => {
    const { rerender } = render(
      <GettingStarted instanceId="box-1" digest={idleDigest} appStepEnabled={false} />,
    );
    expect(screen.queryByText("Connect your first app")).not.toBeInTheDocument();

    rerender(
      <GettingStarted instanceId="box-1" digest={idleDigest} appStepEnabled appConnected />,
    );
    expect(screen.getByTestId("checklist-item:Connect your first app")).toHaveAttribute("data-done", "true");
  });

  it("makes each open step a tappable button that fires its handler", () => {
    const onConnectChannel = jest.fn();
    const onConnectApp = jest.fn();
    const onSendFirstTask = jest.fn();
    render(
      <GettingStarted
        instanceId="box-1"
        digest={idleDigest}
        appStepEnabled
        appConnected={false}
        onConnectChannel={onConnectChannel}
        onConnectApp={onConnectApp}
        onSendFirstTask={onSendFirstTask}
      />,
    );

    fireEvent.click(screen.getByTestId("checklist-item:Connect a chat channel"));
    fireEvent.click(screen.getByTestId("checklist-item:Connect your first app"));
    fireEvent.click(screen.getByTestId("checklist-item:Send your first task"));
    expect(onConnectChannel).toHaveBeenCalledTimes(1);
    expect(onConnectApp).toHaveBeenCalledTimes(1);
    expect(onSendFirstTask).toHaveBeenCalledTimes(1);
  });

  it("leaves a completed step a passive (non-button) row", () => {
    const onConnectChannel = jest.fn();
    render(
      <GettingStarted
        instanceId="box-1"
        digest={idleDigest}
        integrationStatuses={{ Telegram: { configured: true } }}
        onConnectChannel={onConnectChannel}
      />,
    );
    const item = screen.getByTestId("checklist-item:Connect a chat channel");
    expect(item.tagName).not.toBe("BUTTON");
    fireEvent.click(item);
    expect(onConnectChannel).not.toHaveBeenCalled();
  });

  it("marks the final step done via the optimistic taskSent flag (before the digest catches up)", () => {
    render(<GettingStarted instanceId="box-1" digest={idleDigest} taskSent onSendFirstTask={jest.fn()} />);
    const item = screen.getByTestId("checklist-item:Send your first task");
    expect(item).toHaveAttribute("data-done", "true");
    expect(item.tagName).not.toBe("BUTTON");
  });

  it("relabels the final step to 'Run your first workflow' when the shelf is live", () => {
    render(
      <GettingStarted instanceId="box-1" digest={idleDigest} workflowsAvailable onSendFirstTask={jest.fn()} />,
    );
    expect(screen.getByText("Run your first workflow")).toBeInTheDocument();
    expect(screen.queryByText("Send your first task")).not.toBeInTheDocument();
  });

  it("collapses to '✓ You're set up' and persists a done-flag once every step is complete", () => {
    render(
      <GettingStarted
        instanceId="box-1"
        digest={withSession}
        integrationStatuses={{ Telegram: { configured: true } }}
        appStepEnabled={false}
      />,
    );

    expect(screen.getByTestId("getting-started")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText(/you're set up/i)).toBeInTheDocument();
    expect(screen.queryByText("Getting started")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hivra_onboarding_done:box-1")).toBe("1");
  });

  it("renders nothing for a box that already retired onboarding", () => {
    window.localStorage.setItem("hivra_onboarding_done:box-1", "1");
    render(<GettingStarted instanceId="box-1" digest={idleDigest} />);
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
  });
});
