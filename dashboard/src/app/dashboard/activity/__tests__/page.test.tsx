/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import ActivityPage from "../page";
import { auth } from "@clerk/nextjs/server";

let localAuthMode = false;

jest.mock("@clerk/nextjs/server", () => {
  const authMock = jest.fn();
  (authMock as jest.Mock & { protect: jest.Mock }).protect = jest.fn();
  return { auth: authMock };
});

jest.mock("@/components/dashboard/AgentActivityPanel", () => ({
  AgentActivityPanel: () => <div data-testid="recorded-agent-activity">Recorded agent usage</div>,
}));

jest.mock("@/lib/self-host/config", () => ({
  isLocalAuthMode: () => localAuthMode,
}));

beforeEach(() => {
  localAuthMode = false;
});

describe("ActivityPage", () => {
  it("protects the route and renders only the recorded account activity surface", async () => {
    const ui = await ActivityPage();
    render(ui);

    expect((auth as unknown as { protect: jest.Mock }).protect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByText("Recorded account activity")).toBeInTheDocument();
    // Covers BOTH lanes: metered usage and recorded activity. The old copy
    // advertised "recorded usage from managed Hermes agents" only, which was
    // literally the false claim above a Hivra customer's empty state.
    expect(screen.getByText(/recorded lifecycle activity and desktop sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/metered token usage where a managed agent reports it/i)).toBeInTheDocument();
    expect(screen.getByText(/does not estimate task completion/i)).toBeInTheDocument();
    expect(screen.getByTestId("recorded-agent-activity")).toBeInTheDocument();
    expect(screen.queryByText(/percent complete/i)).not.toBeInTheDocument();
  });

  it("shows a healthy empty state instead of calling hosted usage in local mode", async () => {
    localAuthMode = true;

    const ui = await ActivityPage();
    render(ui);

    expect(screen.getByRole("status")).toHaveTextContent(/no managed-agent activity/i);
    expect(screen.queryByTestId("recorded-agent-activity")).not.toBeInTheDocument();
  });
});
