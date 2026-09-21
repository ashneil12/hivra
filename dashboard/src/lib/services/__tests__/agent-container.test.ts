import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CONTAINER_SUFFIXES,
  buildResolveAgentContainerScript,
  getAgentContainerCandidates,
  runtimeComposeServiceExpr,
} from "@/lib/services/agent-container";

describe("agent-container resolution helpers", () => {
  it("orders candidates legacy → gateway → official-dashboard", () => {
    expect(AGENT_CONTAINER_SUFFIXES).toEqual(["", "-gateway", "-official-dashboard"]);
    expect(getAgentContainerCandidates("agent-inst-1")).toEqual([
      "agent-inst-1",
      "agent-inst-1-gateway",
      "agent-inst-1-official-dashboard",
    ]);
  });

  describe("buildResolveAgentContainerScript", () => {
    const script = buildResolveAgentContainerScript("agent-inst-1");

    it("inspects every candidate in order and picks the first running one", () => {
      expect(script).toContain('for __agent_cand in "agent-inst-1" "agent-inst-1-gateway" "agent-inst-1-official-dashboard"; do');
      expect(script).toContain(`docker inspect -f '{{.State.Running}}' "$__agent_cand"`);
      expect(script).toContain('AGENT_CONTAINER="$__agent_cand"; break;');
    });

    it("initializes the var empty so the caller can fail closed when nothing runs", () => {
      expect(script.startsWith('AGENT_CONTAINER=""')).toBe(true);
    });

    it("honours a custom var name", () => {
      expect(buildResolveAgentContainerScript("agent-inst-1", { varName: "CONTAINER_NAME" })).toContain(
        'CONTAINER_NAME=""',
      );
    });

    it("is set -e safe: the inspect runs inside an if-condition", () => {
      expect(script).toContain("if docker inspect");
      expect(script).toContain("; then ");
    });
  });

  describe("runtimeComposeServiceExpr", () => {
    it("prefers the webfree gateway service and falls back to legacy webui", () => {
      expect(runtimeComposeServiceExpr()).toBe(
        '"$({ docker compose config --services 2>/dev/null || true; } | grep -qx gateway && echo gateway || echo webui)"',
      );
    });

    it("uses sudo docker compose when asked (non-root SSH user paths)", () => {
      expect(runtimeComposeServiceExpr({ sudo: true })).toBe(
        '"$({ sudo docker compose config --services 2>/dev/null || true; } | grep -qx gateway && echo gateway || echo webui)"',
      );
    });

    it("neutralizes `docker compose config`'s exit code before the pipe (pipefail-safe)", () => {
      // The whole point of the fix: `config` is wrapped in `{ …; || true; }` so a
      // non-zero exit can't propagate through the pipe and flip the resolution.
      expect(runtimeComposeServiceExpr()).toContain("|| true; } | grep -qx gateway");
      // The buggy bare pipeline (config directly into grep) must be gone.
      expect(runtimeComposeServiceExpr()).not.toContain("config --services 2>/dev/null | grep -qx gateway");
      expect(runtimeComposeServiceExpr({ sudo: true })).not.toContain(
        "config --services 2>/dev/null | grep -qx gateway",
      );
    });
  });

  // Behavioral proof of the pipefail fix. Each case runs the EXACT expr the
  // helper emits under `set -euo pipefail` (the regime real callers use, e.g. the
  // integrations CONNECT script + the watchdog) against a fake `docker` on PATH,
  // and asserts how it resolves. The pre-fix expr resolved `service-down` cases to
  // `webui` whenever `docker compose config` exited non-zero — even when `gateway`
  // was present — which is the 2026-06-24 prod incident this guards against.
  describe("runtimeComposeServiceExpr — pipefail resolution behavior", () => {
    // services: space-separated lines printed by the fake `docker compose config`;
    // exitCode: the code that fake config exits with.
    function resolveUnderPipefail(opts: {
      sudo?: boolean;
      services: string;
      exitCode: number;
    }): string {
      const dir = mkdtempSync(join(tmpdir(), "agent-container-pipefail-"));
      try {
        const dockerPath = join(dir, "docker");
        writeFileSync(
          dockerPath,
          `#!/bin/sh\n` +
            `if [ "$1" = compose ] && [ "$2" = config ]; then\n` +
            (opts.services ? `  printf '%s\\n' ${opts.services}\n` : "") +
            `  exit ${opts.exitCode}\n` +
            `fi\nexit 0\n`,
        );
        chmodSync(dockerPath, 0o755);

        // `sudo` shim so the sudo variant runs without real sudo: drop an optional
        // `-n` then exec the rest (resolves the fake `docker` via the same PATH).
        const sudoPath = join(dir, "sudo");
        writeFileSync(sudoPath, `#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n`);
        chmodSync(sudoPath, 0o755);

        const script = `set -euo pipefail\nSERVICE=${runtimeComposeServiceExpr({ sudo: opts.sudo })}\nprintf '%s' "$SERVICE"`;
        return execFileSync("bash", ["-c", script], {
          // Prepend the fake-binary dir so our `docker`/`sudo` shims win; keep the
          // rest of the env (the typed ProcessEnv requires NODE_ENV).
          env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
          encoding: "utf8",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("resolves to gateway even when `docker compose config` exits non-zero but gateway IS present (the bug)", () => {
      expect(
        resolveUnderPipefail({ services: "gateway official-dashboard dashboard-sidecar", exitCode: 1 }),
      ).toBe("gateway");
    });

    it("still resolves to gateway when config exits cleanly", () => {
      expect(
        resolveUnderPipefail({ services: "gateway official-dashboard dashboard-sidecar", exitCode: 0 }),
      ).toBe("gateway");
    });

    it("falls back to webui on a legacy box (no gateway service) regardless of config exit code", () => {
      expect(resolveUnderPipefail({ services: "webui", exitCode: 0 })).toBe("webui");
      expect(resolveUnderPipefail({ services: "webui", exitCode: 1 })).toBe("webui");
    });

    it("applies the same pipefail-safety on the sudo path", () => {
      expect(
        resolveUnderPipefail({ sudo: true, services: "gateway official-dashboard", exitCode: 1 }),
      ).toBe("gateway");
    });
  });
});
