import { AGENT_COMPUTER_SURFACES } from "@/lib/agent-computers/contracts";
import {
  normalizeWorkspaceRoute,
  parseWorkspaceRoute,
  serializeWorkspaceRoute,
} from "../workspace-route-state";

describe("workspace route state", () => {
  describe("parseWorkspaceRoute", () => {
    it.each([
      ["h-123", "h-123"],
      ["x-agent_42", "x-agent_42"],
      ["h-a.b:c-d_e", "h-a.b:c-d_e"],
    ])("accepts bounded source-qualified UID %s", (value, expected) => {
      expect(parseWorkspaceRoute(`?agent=${value}&surface=conversation`)).toEqual({
        agent: expected,
        surface: "conversation",
      });
    });

    it.each([
      "raw-backing-id",
      "q-agent-1",
      "h-",
      "x-/absolute/path",
      "h-https://example.invalid",
      "x-agent?token=secret",
      "h-agent#fragment",
      "x-sk_live_DO_NOT_ACCEPT",
      "h-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.signature",
      `h-${"a".repeat(129)}`,
    ])("rejects unsafe or malformed agent value %s", (value) => {
      const params = new URLSearchParams({ agent: value, surface: "terminal" });

      expect(parseWorkspaceRoute(params)).toEqual({
        agent: null,
        surface: "conversation",
      });
    });

    it.each(["conversation", ...AGENT_COMPUTER_SURFACES])(
      "accepts the allowed surface %s",
      (surface) => {
        expect(parseWorkspaceRoute(`?agent=x-agent-1&surface=${surface}`)).toEqual({
          agent: "x-agent-1",
          surface,
        });
      },
    );

    it.each(["chat", "tui", "settings", "https://example.invalid", "terminal#token"])(
      "rejects unknown surface %s",
      (surface) => {
        expect(
          parseWorkspaceRoute(new URLSearchParams({ agent: "h-agent-1", surface })),
        ).toEqual({
          agent: "h-agent-1",
          surface: "conversation",
        });
      },
    );

    it("uses only allowlisted query keys and ignores fragments", () => {
      expect(
        parseWorkspaceRoute(
          "?agent=x-agent-1&surface=browser&token=DO_NOT_KEEP&redirect=https%3A%2F%2Fevil.invalid#secret",
        ),
      ).toEqual({ agent: "x-agent-1", surface: "browser" });
    });
  });

  describe("normalizeWorkspaceRoute", () => {
    it("keeps an advertised selected-agent surface", () => {
      expect(
        normalizeWorkspaceRoute(
          { agent: "x-agent-1", surface: "terminal" },
          ["terminal", "browser"],
        ),
      ).toEqual({
        route: { agent: "x-agent-1", surface: "terminal" },
        notice: null,
      });
    });

    it("falls back explicitly when the selected projection does not advertise the surface", () => {
      expect(
        normalizeWorkspaceRoute(
          { agent: "h-agent-1", surface: "desktop" },
          ["workspace", "files"],
        ),
      ).toEqual({
        route: { agent: "h-agent-1", surface: "conversation" },
        notice: "That surface is not available for this agent.",
      });
    });

    it("does not produce a capability notice for conversation or an unselected route", () => {
      expect(
        normalizeWorkspaceRoute(
          { agent: "x-agent-1", surface: "conversation" },
          [],
        ),
      ).toEqual({
        route: { agent: "x-agent-1", surface: "conversation" },
        notice: null,
      });
      expect(
        normalizeWorkspaceRoute(
          { agent: null, surface: "terminal" },
          ["terminal"],
        ),
      ).toEqual({
        route: { agent: null, surface: "conversation" },
        notice: null,
      });
    });
  });

  describe("serializeWorkspaceRoute", () => {
    it("emits only agent then surface in stable order", () => {
      expect(
        serializeWorkspaceRoute({
          agent: "x-agent-1",
          surface: "git",
          token: "DO_NOT_KEEP",
          redirect: "https://evil.invalid/#secret",
        } as never),
      ).toBe("/dashboard/workspace?agent=x-agent-1&surface=git");
    });

    it("drops invalid, URL-like, fragment, and token-like values", () => {
      expect(
        serializeWorkspaceRoute({
          agent: "https://evil.invalid/?token=DO_NOT_KEEP#secret",
          surface: "terminal#secret",
        } as never),
      ).toBe("/dashboard/workspace");
      expect(
        serializeWorkspaceRoute({
          agent: "x-sk_live_DO_NOT_KEEP",
          surface: "conversation",
        } as never),
      ).toBe("/dashboard/workspace");
    });

    it("serializes a valid agent without adding a redundant conversation key", () => {
      expect(
        serializeWorkspaceRoute({ agent: "h-agent-1", surface: "conversation" }),
      ).toBe("/dashboard/workspace?agent=h-agent-1&surface=conversation");
      expect(serializeWorkspaceRoute({ agent: null, surface: "conversation" })).toBe(
        "/dashboard/workspace",
      );
    });
  });
});
