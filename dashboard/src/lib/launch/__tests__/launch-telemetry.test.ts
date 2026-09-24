import { createLaunchDraft } from "../draft-store";
import {
  captureLaunchEvent,
  captureLaunchEventOnce,
  launchErrorMessage,
  launchEventContext,
  launchFailureStage,
} from "../launch-telemetry";

const captureMock = jest.fn();

jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: (...args: unknown[]) => captureMock(...args),
}));

beforeEach(() => captureMock.mockClear());

describe("launch telemetry", () => {
  it("sends Launch's events under its own source and route", () => {
    captureLaunchEvent("activation_started", { plan: "free" });
    expect(captureMock).toHaveBeenCalledWith("activation_started", {
      source: "launch-journey",
      route: "/dashboard/launch",
      surface: "launch",
      plan: "free",
    });
  });

  it("sends a moment on screen once per key", () => {
    captureLaunchEventOnce("paywall:draft-1:browser", "paywall_viewed", { paywall: "browser" });
    captureLaunchEventOnce("paywall:draft-1:browser", "paywall_viewed", { paywall: "browser" });
    captureLaunchEventOnce("paywall:draft-2:browser", "paywall_viewed", { paywall: "browser" });
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it("describes a launch by its choices and ids, never its name", () => {
    const draft = {
      ...createLaunchDraft(),
      profileId: "codex" as const,
      resourceKind: "agent" as const,
      name: "My secret project",
      browser: true,
      template: { id: "11111111-1111-4111-8111-111111111111", name: "Research Bot" },
    };
    const context = launchEventContext(draft);
    expect(context).toMatchObject({
      profile: "codex",
      agentType: "codex",
      resourceKind: "agent",
      launchRequestId: draft.launchRequestId,
      modelAccess: "native",
      browser: true,
      fromTemplate: true,
    });
    expect(JSON.stringify(context)).not.toMatch(/secret project|Research Bot/);
  });

  it("groups failures under the stages the first-run audit reads", () => {
    expect(launchFailureStage({ ...createLaunchDraft(), profileId: "hermes" })).toBe("create_instance");
    expect(launchFailureStage({ ...createLaunchDraft(), profileId: "claude-code" })).toBe("hivra_box_launch");
  });

  it("redacts secrets and key-like strings from a failure message and keeps it short", () => {
    const message = launchErrorMessage(new Error(`Upstream said   api_key=abc123 and sk-proj-${"x".repeat(30)} ${"y".repeat(400)}`));
    expect(message).not.toMatch(/abc123|xxxxxxxx/);
    expect(message).toContain("api_key=[REDACTED]");
    expect(message.length).toBeLessThanOrEqual(240);
    expect(launchErrorMessage("plain")).toBe("plain");
    expect(launchErrorMessage({ unexpected: true })).toBe("");
  });
});
