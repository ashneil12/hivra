/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { AgentActivityDigest } from "../AgentActivityDigest";
import type { InstanceActivityDigest } from "@/lib/command-center/activity";

const digest: InstanceActivityDigest = {
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
  attentionItems: [
    {
      type: "runtime",
      label: "Runtime activity unavailable",
      severity: "warning",
    },
  ],
};

describe("AgentActivityDigest", () => {
  it("renders a privacy-safe live work digest", () => {
    render(<AgentActivityDigest digest={digest} />);

    expect(screen.getByText("Live Work")).toBeInTheDocument();
    expect(screen.getByText("Responding now")).toBeInTheDocument();
    expect(screen.getByText("Runtime activity unavailable")).toBeInTheDocument();
    expect(screen.getByText("Market research")).toBeInTheDocument();
    expect(screen.getByText(/8 messages/i)).toBeInTheDocument();
    expect(screen.getByText(/1 active stream/i)).toBeInTheDocument();
    expect(screen.queryByText(/cat \/private/i)).not.toBeInTheDocument();
  });

  it("shows a calm idle state (no error tone) when no digest has loaded yet", () => {
    render(<AgentActivityDigest digest={null} loading={false} error="Activity unavailable" />);

    // The legacy live-activity surface is retired: a missing digest is a normal
    // condition, not an error. We must NOT surface alarming copy or the raw
    // error string, just a calm idle prompt that points the user to the chat.
    expect(screen.getByText("Ready when you are")).toBeInTheDocument();
    expect(
      screen.getByText("Send a message in the chat to put your agent to work."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Activity unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText(/runtime signal/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/WebUI/i)).not.toBeInTheDocument();
  });
});
