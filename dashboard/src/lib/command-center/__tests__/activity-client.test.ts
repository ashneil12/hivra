/** @jest-environment jsdom */
import {
  readInstanceActivityDigest,
  requestInstanceActivityDigest,
} from "../activity-client";

describe("command center activity client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads a complete instance activity digest payload", () => {
    const digest = readInstanceActivityDigest({
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
    });

    expect(digest).toEqual(
      expect.objectContaining({
        state: "responding",
        headline: "Responding now",
        source: "webui",
        activeStreams: 1,
      }),
    );
  });

  it("rejects incomplete digest payloads instead of rendering stale assumptions", () => {
    expect(readInstanceActivityDigest({ state: "responding" })).toBeNull();
    expect(
      readInstanceActivityDigest({
        state: "secret_transcript",
        headline: "Leaky",
        lastActiveAt: null,
        activeStreams: null,
        source: "webui",
        recentSessions: [],
        attentionItems: [],
      }),
    ).toBeNull();
  });

  it("fetches activity by encoded instance id and returns a typed digest", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
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
      } as Response),
    ) as typeof fetch;

    const result = await requestInstanceActivityDigest("inst/with space");

    expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst%2Fwith%20space/activity");
    expect(result).toEqual({
      ok: true,
      digest: expect.objectContaining({ state: "idle" }),
    });
  });
});
