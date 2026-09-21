import { resolveDefaultInstanceBackend } from "@/lib/services/instance-service";
import { buildWebUICaddyfile } from "@/lib/services/webui-instance-builder";
import { buildAgentCaddyfile } from "@/lib/services/hetzner-instance-builders";
import { isWebfreeBackend, type InstanceBackend } from "@/lib/types/instance";

/**
 * Fail-closed contract for the 2026-06-15 "gateway-default iframe-404" incident,
 * updated for the Phase-2 collapse (gateway ≡ webfree everywhere).
 *
 * Original root cause: the webui-retirement flipped resolveDefaultInstanceBackend()
 * to "gateway" while the WORKING webfree dashboard stack (official-dashboard +
 * PUBLIC /webchat + /dash file_server shells, built by buildWebUICaddyfile) was
 * produced ONLY under backend==="webui". "gateway" fell to the legacy
 * buildAgentCaddyfile (no public shell, catch-all → agent gateway :8642 → 404), so
 * every new signup got a dashboard that 404s inside the control-plane iframe.
 *
 * Phase-2 collapse: every deploy / redeploy / handoff / readiness / control-plane /
 * cron branch that historically keyed on `backend === "webui"` now routes through
 * isWebfreeBackend, so BOTH "webui" and "gateway" build the byte-identical webfree
 * stack. The legacy buildAgentCaddyfile is dormant — NO backend value routes to it.
 *
 * This contract binds the invariants that drifted apart in the incident:
 *   1. the DEFAULT backend is a webfree backend,
 *   2. EVERY backend value is a webfree backend (the collapse — there is no
 *      no-shell backend left to default to by accident),
 *   3. the webfree builder both backends select serves the public shell.
 * It runs unchanged on BOTH forks (canary + prod) and is wired into
 * `test:smoke-contracts`, so the prod-promote port can't reintroduce the bug.
 */
describe("every backend serves a public dashboard shell (incident-2026-06-15 guard)", () => {
  it("defaults to a webfree backend (its deploy serves the public shell)", () => {
    // If this ever resolves to a NON-webfree value the new-signup dashboard 404s
    // in the iframe. Post-collapse both webui and gateway are webfree, so the
    // default may be either — but it must be one of them.
    expect(isWebfreeBackend(resolveDefaultInstanceBackend())).toBe(true);
  });

  it("EVERY InstanceBackend value is a webfree backend (gateway ≡ webui collapse)", () => {
    // The collapse invariant: there is no longer a no-shell backend to fall to.
    // This Record is keyed on InstanceBackend, so adding a NEW member to the
    // InstanceBackend union without listing it here is a COMPILE error (tsc, in
    // CI) — the fail-closed tripwire. Mapping a new backend to `false` is allowed
    // but then the assertion below fires, forcing a deliberate decision: either
    // wire it to the webfree builder (→ true) or accept it 404s in the iframe like
    // the 2026-06-15 incident. (The old `for…of WEBFREE_BACKENDS` loop was
    // tautological — iterating the very set the predicate is defined from.)
    const BACKEND_IS_WEBFREE: Record<InstanceBackend, true> = {
      webui: true,
      gateway: true,
    };
    for (const backend of Object.keys(BACKEND_IS_WEBFREE) as InstanceBackend[]) {
      expect(isWebfreeBackend(backend)).toBe(BACKEND_IS_WEBFREE[backend]);
    }
  });

  it("the webfree builder (selected by BOTH backends) serves PUBLIC /webchat + /dash shells", () => {
    const caddy = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "tok", {
      instanceId: "inst-xyz",
    });
    expect(caddy).toContain("@hermesRoot path /");
    expect(caddy).toMatch(/handle_path \/webchat\* \{[\s\S]*file_server/m);
    expect(caddy).toMatch(/handle_path \/dash\* \{[\s\S]*file_server/m);
    expect(caddy).toContain("agent-inst-123-official-dashboard:9119");
  });

  it("the legacy buildAgentCaddyfile is the no-shell builder — no DEPLOY backend routes to it", () => {
    // This builder is the failure mode that 404'd the iframe. Post-collapse no
    // backend selects it *on the deploy path*; this assertion documents it as the
    // dangerous builder so any future re-route to it is an obvious red flag.
    //
    // CORRECTION: "DORMANT" was only ever true of the DEPLOY builder path. The
    // PROFILE lane (ProfileService.updateAgentCaddyRouting) called this builder
    // for EVERY backend and reloaded the result onto the live box, replacing a
    // webfree box's Caddyfile with upstreams that don't exist there
    // (`agent-<id>` / `agent-<id>-sidecar` vs the real `-gateway` /
    // `-official-dashboard` / `-dashboard-sidecar`). That lane is now gated
    // fail-closed; see profile-service.updateAgentCaddyRouting and its
    // regression test in profile-service.test.ts.
    const caddy = buildAgentCaddyfile("agent.example.com", "agent-inst-123");
    expect(caddy).not.toContain("handle_path /webchat*");
    expect(caddy).not.toContain("handle_path /dash*");
    expect(caddy).toContain("agent-inst-123:8642");
    // The upstreams that make this builder catastrophic on a webfree box.
    expect(caddy).not.toContain("agent-inst-123-gateway:");
    expect(caddy).not.toContain("agent-inst-123-official-dashboard:");
  });
});
