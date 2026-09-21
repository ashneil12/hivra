import { buildInstanceActivityDigest } from "../activity";

const runningInstance = {
  id: "inst-123",
  name: "Atlas",
  status: "running",
  backend: "webui",
};

const recentSession = {
  session_id: "sess-1",
  title: "Market research",
  updated_at: 1_778_900_000,
  message_count: 8,
  model: "glm-5.1",
  estimated_cost: 0.0042,
};

describe("buildInstanceActivityDigest", () => {
  // There is no needs_approval / needs_clarification state: approvals arrive as
  // push events on the workspace iframe's /api/ws socket, never over HTTP, so
  // the dashboard can't observe them. See the note on InstanceActivityState.
  it("maps active WebUI streams to responding", () => {
    const digest = buildInstanceActivityDigest({
      instance: runningInstance,
      health: { status: "ok", sessions: 1, active_streams: 2, uptime_seconds: 120 },
      sessions: [recentSession],
    });

    expect(digest.state).toBe("responding");
    expect(digest.headline).toBe("Responding now");
    expect(digest.activeStreams).toBe(2);
  });

  it("maps healthy WebUI with no attention to idle with recent session metadata", () => {
    const digest = buildInstanceActivityDigest({
      instance: runningInstance,
      health: { status: "ok", sessions: 1, active_streams: 0, uptime_seconds: 120 },
      sessions: [recentSession],
    });

    expect(digest.state).toBe("idle");
    expect(digest.headline).toBe("Waiting for your next message");
    expect(digest.lastActiveAt).toBe(new Date(recentSession.updated_at * 1000).toISOString());
    expect(digest.recentSessions).toEqual([
      {
        id: "sess-1",
        title: "Market research",
        updatedAt: new Date(recentSession.updated_at * 1000).toISOString(),
        messageCount: 8,
        model: "glm-5.1",
        estimatedCostUsd: 0.0042,
      },
    ]);
  });

  it("maps stopped instances without querying transcript-like data", () => {
    const digest = buildInstanceActivityDigest({
      instance: { ...runningInstance, status: "stopped" },
      health: null,
      sessions: [],
    });

    expect(digest.state).toBe("not_running");
    expect(digest.headline).toBe("Agent is stopped");
    expect(digest.source).toBe("dashboard");
  });
});
