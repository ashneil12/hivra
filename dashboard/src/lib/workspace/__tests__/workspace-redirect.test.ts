import type { WorkspaceSurface } from "../workspace-contracts";
import { resolveWorkspaceRedirect } from "../workspace-redirect";

/**
 * The merge keeps the agent route and redirects the workspace into it. These
 * specs exist because a bad translation strands a link silently — the redirect
 * still returns 200, it just lands on the wrong surface or a 404'd id.
 */
describe("workspace -> agent route redirect", () => {
  describe("identity namespace", () => {
    it("strips the source-qualified prefix the agent route cannot accept", () => {
      // The workspace addresses a resource as `x-<id>`; the agent route's path
      // segment is the raw backing id. Passing the prefix through 404s.
      expect(
        resolveWorkspaceRedirect({
          agent: "x-00000000-0000-4000-8000-000000001006",
          surface: "desktop",
        }),
      ).toEqual({ id: "00000000-0000-4000-8000-000000001006", tab: "desktop" });
    });

    it("declines a Hermes instance rather than serving it the wrong shell", () => {
      // Hermes lives at /dashboard/instances/<id>. Sending it to the Hivra agent
      // page would render a Hivra surface for a Hermes resource.
      expect(
        resolveWorkspaceRedirect({ agent: "h-some-instance", surface: "terminal" }),
      ).toBeNull();
    });

    it.each([
      ["no agent", null],
      ["a bare prefix", "x-"],
      ["an unqualified id", "2839f374"],
      ["a foreign scheme", "z-abc"],
      ["an empty string", ""],
    ])("returns null for %s", (_label, agent) => {
      expect(resolveWorkspaceRedirect({ agent, surface: "desktop" })).toBeNull();
    });
  });

  describe("surface vocabulary", () => {
    it.each([
      // The two renamed tokens, which are where a naive passthrough breaks.
      ["conversation", "chat"],
      ["workspace", "aeon"],
      // The five shared tokens, which must pass through untouched.
      ["files", "files"],
      ["git", "git"],
      ["terminal", "terminal"],
      ["browser", "browser"],
      ["desktop", "desktop"],
    ] as const)("maps %s to the agent route's %s tab", (surface, tab) => {
      expect(
        resolveWorkspaceRedirect({ agent: "x-abc", surface: surface as WorkspaceSurface }),
      ).toEqual({ id: "abc", tab });
    });

    it("covers every workspace surface — no token may fall through unmapped", () => {
      // A surface the agent route genuinely lacks would need a product decision,
      // and the fallback would hide that. This fails loudly instead.
      const surfaces: WorkspaceSurface[] = [
        "conversation",
        "workspace",
        "files",
        "git",
        "terminal",
        "browser",
        "desktop",
        "native",
      ];
      for (const surface of surfaces) {
        const target = resolveWorkspaceRedirect({ agent: "x-abc", surface });
        expect(target).not.toBeNull();
        expect(target!.tab).toBeTruthy();
      }
    });
  });
});