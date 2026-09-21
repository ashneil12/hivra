import {
  desktopTransportForProfile,
  normalizeComputerProfile,
  resolveResourceLanding,
} from "../resource-landing";

/**
 * These specs pin the ONE decision both routes read. The bug they exist to
 * prevent is drift: the workspace opened a computer on a terminal while the
 * per-agent page opened it on a desktop, because each route decided separately.
 */
describe("resource landing", () => {
  describe("normalizeComputerProfile", () => {
    it.each([
      ["omarchy", "omarchy"],
      ["windows", "windows"],
      ["ubuntu-desktop", "ubuntu-desktop"],
      // A null profile on a linux-desktop row is Ubuntu: that was the only
      // computer image before profiles existed, so null is not a fourth profile.
      [null, "ubuntu-desktop"],
      [undefined, "ubuntu-desktop"],
      ["", "ubuntu-desktop"],
      // Anything unrecognised fails safe to the general Linux desktop rather
      // than inventing a transport.
      ["plan9", "ubuntu-desktop"],
    ] as const)("normalizes %s to %s", (input, expected) => {
      expect(normalizeComputerProfile(input)).toBe(expected);
    });
  });

  describe("desktopTransportForProfile", () => {
    it.each([
      ["omarchy", "omarchy"],
      ["windows", "windows"],
      ["ubuntu-desktop", "remote"],
      [null, "remote"],
    ] as const)("maps %s to the %s transport", (profile, expected) => {
      expect(desktopTransportForProfile(profile)).toBe(expected);
    });
  });

  describe("a running computer", () => {
    it.each([
      ["ubuntu-desktop", "remote", false],
      ["omarchy", "omarchy", false],
      ["windows", "windows", true],
      [null, "remote", false],
    ] as const)(
      "lands on its desktop (%s → %s), never a conversation",
      (profile, transport, autoOpen) => {
        const landing = resolveResourceLanding({
          source: "hivra",
          type: "linux-desktop",
          computerProfile: profile,
          status: "running",
          surfaceKind: "computer",
          resourceKind: "computer",
        });

        expect(landing.landing).toBe("desktop");
        expect(landing.desktop).toBe(true);
        expect(landing.desktopTransport).toBe(transport);
        expect(landing.desktopAutoOpen).toBe(autoOpen);
        expect(landing.profile).toBe(profile ?? "ubuntu-desktop");
        // The whole bug: a running computer was handed a "conversation" that
        // resolved to the box's /terminal/ endpoint. It has no conversation.
        expect(landing.conversation).toBe(false);
      },
    );

    it("does not require a chat_url — desktops issue their own session", () => {
      const landing = resolveResourceLanding({
        source: "hivra",
        type: "linux-desktop",
        computerProfile: "omarchy",
        status: "running",
        chatUrl: null,
        surfaceKind: "computer",
        resourceKind: "computer",
      });

      expect(landing.landing).toBe("desktop");
    });
  });

  describe("a computer that is not up", () => {
    it.each(["provisioning", "stopped", "error", "unknown", null])(
      "falls back to the conversation landing while %s",
      (status) => {
        const landing = resolveResourceLanding({
          source: "hivra",
          type: "linux-desktop",
          computerProfile: "omarchy",
          status,
          surfaceKind: "computer",
          resourceKind: "computer",
        });

        // No session can be issued, so there is no desktop to promise. The
        // existing state notice (provisioning/unavailable/recovery) renders.
        expect(landing.landing).toBe("conversation");
        expect(landing.desktop).toBe(false);
        expect(landing.desktopTransport).toBeNull();
        // The profile is still reported, so a caller can label the resource.
        expect(landing.profile).toBe("omarchy");
      },
    );
  });

  describe("everything that is not a computer", () => {
    it.each([
      { label: "a CLI chat agent", resource: { type: "codex", surfaceKind: "chat" as const } },
      { label: "a dashboard agent", resource: { type: "aeon", surfaceKind: "dashboard" as const } },
      { label: "an agent with no surface kind", resource: { type: "claude-code" } },
    ])("keeps $label on its conversation", ({ resource }) => {
      const landing = resolveResourceLanding({
        source: "hivra",
        status: "running",
        chatUrl: "https://box.invalid",
        ...resource,
      });

      expect(landing.landing).toBe("conversation");
      expect(landing.conversation).toBe(true);
      expect(landing.desktop).toBe(false);
      expect(landing.desktopTransport).toBeNull();
      expect(landing.profile).toBeNull();
    });

    it("keeps a Hermes instance on its conversation", () => {
      const landing = resolveResourceLanding({
        source: "hermes",
        status: "running",
        resourceKind: "agent",
      });

      expect(landing.landing).toBe("conversation");
      expect(landing.conversation).toBe(true);
      expect(landing.desktop).toBe(false);
    });

    it("does not mistake a computer-shaped status for a computer", () => {
      // resourceKind/surfaceKind are the discriminators, not status alone.
      const landing = resolveResourceLanding({
        source: "hivra",
        type: "codex",
        status: "running",
        resourceKind: "agent",
      });

      expect(landing.landing).toBe("conversation");
      expect(landing.desktop).toBe(false);
    });
  });
});
