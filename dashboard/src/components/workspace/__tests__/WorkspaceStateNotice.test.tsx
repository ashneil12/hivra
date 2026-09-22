/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import type { AgentComputer } from "@/lib/agent-computers/contracts";
import {
  WorkspaceStateNotice,
  type WorkspaceNoticeState,
} from "../WorkspaceStateNotice";

const NOW = "2026-08-24T20:05:00.000Z";
const UPDATED_AT = "2026-08-24T20:00:00.000Z";

const computer: AgentComputer = {
  contractVersion: "2026-08-24",
  id: "x-beta",
  name: "Beta",
  source: { kind: "hivra", id: "beta" },
  capabilities: { surfaces: [], actions: [] },
  state: {
    desired: "running",
    observed: "provisioning",
    health: "enrolling",
    operation: {
      state: "provisioning",
      id: "op-beta",
      observedAt: UPDATED_AT,
    },
  },
  compatibility: { mode: "projected", sourceStatus: "provisioning" },
};

interface NoticeCase {
  state: WorkspaceNoticeState;
  copy: string;
  action?: string;
  alert?: boolean;
}

const cases: NoticeCase[] = [
  { state: "loading", copy: "Opening Terminal…" },
  {
    state: "unavailable",
    copy: "Terminal is unavailable right now. The runtime did not advertise access.",
    action: "Retry surface",
  },
  {
    state: "expired",
    copy: "Access to Terminal expired.",
    action: "Reconnect surface",
  },
  {
    state: "revoked",
    copy: "Access to Terminal was revoked.",
    action: "Return to conversation",
    alert: true,
  },
  {
    state: "reconnecting",
    copy: "Reconnecting to Terminal… Last connected 10 minutes ago.",
    action: "Retry surface",
  },
  {
    state: "error",
    copy: "Couldn't reach Beta. Check the connection and try again.",
    action: "Retry message",
  },
  {
    state: "recovery",
    copy: "Beta needs attention. The last operation failed.",
    action: "Open Console",
  },
  {
    state: "provisioning",
    copy: "Beta is still starting. Observed: provisioning. This workspace opens when the runtime responds; no completion percentage is guessed. Last checked 5 minutes ago.",
    action: "Refresh status",
  },
  {
    state: "compatibility",
    copy:
      "This legacy session has no canonical run acknowledgement. Activity shown here is connection and event evidence only.",
  },
  {
    state: "unknown",
    copy: "Terminal state is unknown. Last checked 5 minutes ago.",
    action: "Refresh status",
  },
];

describe("WorkspaceStateNotice", () => {
  it.each(cases)(
    "renders $state with exact copy, action, and live-region semantics",
    ({ state, copy, action, alert }) => {
      const onPrimaryAction = jest.fn();
      render(
        <WorkspaceStateNotice
          state={state}
          agentName="Beta"
          surfaceLabel="Terminal"
          observedReason="The runtime did not advertise access."
          observedDetail="The last operation failed."
          observedState="provisioning"
          updatedAt={UPDATED_AT}
          lastConnectedAt="2026-08-24T19:55:00.000Z"
          recoveryActionLabel="Open Console"
          now={NOW}
          onPrimaryAction={onPrimaryAction}
        />,
      );

      expect(screen.getByText(copy)).toBeInTheDocument();
      const region = alert ? screen.getByRole("alert") : screen.getByRole("status");
      expect(region).toHaveAttribute("aria-live", alert ? "assertive" : "polite");
      if (state !== "loading") expect(screen.getByText("Updated 5 minutes ago")).toHaveAttribute(
        "aria-label",
        expect.stringContaining("24 August 2026"),
      );

      if (action) {
        fireEvent.click(screen.getByRole("button", { name: action }));
        expect(onPrimaryAction).toHaveBeenCalledTimes(1);
      } else {
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
      }
    },
  );

  it("keeps desired, observed, health, and operation as independent facts", () => {
    render(
      <WorkspaceStateNotice
        state="provisioning"
        agentName="Beta"
        surfaceLabel="Workspace"
        observedState="provisioning"
        updatedAt={UPDATED_AT}
        now={NOW}
        computer={computer}
      />,
    );

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getAllByText("provisioning")).toHaveLength(2);
    expect(screen.getByText("enrolling")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-state-facts")).toHaveClass(
      "sm:grid-cols-4",
    );
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
    expect(screen.queryByText("offline")).not.toBeInTheDocument();
  });

  it("keeps responsive outer gutters separate from the bounded error card", () => {
    render(
      <WorkspaceStateNotice
        state="unknown"
        agentName="Beta"
        surfaceLabel="Workspace"
        updatedAt={UPDATED_AT}
        now={NOW}
      />,
    );

    const gutter = screen.getByTestId("workspace-state-gutter");
    expect(gutter).toHaveClass("p-4", "sm:p-6", "lg:p-8");
    expect(screen.getByRole("status")).toHaveClass(
      "max-w-[840px]",
      "p-5",
      "sm:p-6",
    );
  });

  it.each(["unavailable", "unknown"] as const)(
    "does not invent usable, ready, or connected access for %s",
    (state) => {
      render(
        <WorkspaceStateNotice
          state={state}
          agentName="Beta"
          surfaceLabel="Terminal"
          observedReason="No usable route was advertised."
          updatedAt={UPDATED_AT}
          now={NOW}
        />,
      );

      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.queryByText(/\bready\b/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/\bconnected\b/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /open/i })).not.toBeInTheDocument();
    },
  );

  it("uses alert semantics only when an otherwise nonblocking state is explicitly blocking", () => {
    render(
      <WorkspaceStateNotice
        state="error"
        agentName="Beta"
        surfaceLabel="Conversation"
        updatedAt={UPDATED_AT}
        now={NOW}
        blocking
      />,
    );

    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });
});
