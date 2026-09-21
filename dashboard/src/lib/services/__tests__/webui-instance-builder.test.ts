import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHermesEnvFile,
  resolveWebUIProviderEnvVar,
  buildWebUIAuthStoreFile,
  buildWebUIBootstrapScript,
  buildWebUICompose,
  buildWebUIComposeEnv,
  buildWebUICaddyfile,
  buildWebUIConfigYaml,
  buildWebUIProvisioningArtifacts,
  buildHermesBrowserSidecarCacheCleanupFunction,
  buildHermesVolumeSafeUpdateCleanupFunctions,
  type WebUIDeployParams,
} from "../webui-instance-builder";
import { OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH } from "@/lib/operatoros-flavor";
import {
  WEBUI_CLEARABLE_RUNTIME_ENV_KEYS,
  WEBUI_MANAGED_RUNTIME_ENV_KEYS,
} from "../webui-runtime-env";
import { getPersonaSoulPrompt } from "@/lib/persona-souls-accessor";
import { ONBOARDING_RITUAL } from "@/lib/onboarding-ritual";
import { WEBUI_TERMINAL_CONFIG_SYNC_PYTHON } from "../webui-terminal-config";

const baseParams: WebUIDeployParams = {
  instanceId: "inst-123",
  containerName: "agent-inst-123",
  fqdn: "agent.example.com",
  cpuLimit: 2,
  ramLimit: 4096,
  llmApiKey: "provider-key",
  inferenceProvider: "custom",
  defaultModel: "deepseek-v3.2",
  baseUrl: "https://crof.ai/v1",
  webuiPassword: "webui-password",
};
const expectedWebUIPath = [
  "PATH=/home/hermes/.hermes/bin",
  "/home/hermes/.hermes/python/bin",
  "/home/hermes/.local/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  // /usr/local/sbin:/usr/sbin:/sbin must follow the regular /bin entries.
  // The legacy image init script invokes groupmod (at /usr/sbin/groupmod
  // on Debian); without these on PATH, init dies with "groupmod: command not
  // found" and webui crash-loops every fresh deploy.
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
  "/usr/local/games",
  "/usr/games",
].join(":");

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("webui-instance-builder", () => {
  it("runs WebUI as a shared-host instance without binding public ports", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
    });

    // webui-free: the bare webui service is gone; gateway + dashboard run the
    // AGENT image. (Migration 2026-06-05.)
    expect(compose).not.toContain("ghcr.io/ashneil12/hermes-webui");
    expect(compose).not.toMatch(/^  webui:\s*$/m);
    const gatewayServiceBlock = compose.slice(
      compose.indexOf("  gateway:"),
      compose.indexOf("  official-dashboard:")
    );
    // gateway runs the agent image + bypasses s6-overlay (entrypoint:[]) so the
    // supervisor command runs directly (s6 fatals as non-pid-1 under user:).
    expect(gatewayServiceBlock).toContain("image: ghcr.io/ashneil12/vanilla-hermes-agent:latest");
    expect(gatewayServiceBlock).toContain("entrypoint: []");
    expect(gatewayServiceBlock).toContain("http://127.0.0.1:8642/health");
    expect(gatewayServiceBlock).toContain(
      "- HERMES_WRITE_SAFE_ROOT=/opt/data:/home/hermes/.hermes/workspace:/workspace"
    );
    expect(gatewayServiceBlock).toContain("- ./runtime-passwd:/etc/passwd:ro");
    const officialDashboardServiceBlock = compose.slice(
      compose.indexOf("  official-dashboard:"),
      compose.indexOf("  dashboard-sidecar:")
    );
    expect(officialDashboardServiceBlock).toContain(
      "depends_on:\n      - gateway"
    );
    expect(officialDashboardServiceBlock).not.toContain("condition: service_healthy");
    expect(officialDashboardServiceBlock).toContain(
      'entrypoint: ["/bin/sh", "-c"]'
    );
    expect(officialDashboardServiceBlock).toContain(
      "until curl -fsS --max-time 3 http://agent-inst-123-gateway:8642/health"
    );
    expect(officialDashboardServiceBlock).toContain(
      "dashboard_gateway_attempt=$$((dashboard_gateway_attempt + 1))"
    );
    expect(officialDashboardServiceBlock).toContain('if [ "$$dashboard_gateway_attempt" -ge 90 ]; then');
    expect(officialDashboardServiceBlock).toContain(
      "exec /opt/hermes/.venv/bin/hermes dashboard --host 0.0.0.0 --port 9119 --no-open --insecure"
    );
    expect(officialDashboardServiceBlock).toContain(
      "- HERMES_WRITE_SAFE_ROOT=/opt/data:/home/hermes/.hermes/workspace:/workspace"
    );
    expect(officialDashboardServiceBlock).toContain("- ./runtime-passwd:/etc/passwd:ro");
    expect(compose).toContain("- agent-source:/home/hermes/.hermes/hermes-agent");
    // Aeon run-eligibility gate inputs — the agent-side aeon skill reads these.
    expect(compose).toContain("- HERMES_AEON_GATE_URL=");
    expect(compose).toContain("- HERMES_INSTANCE_ID=");
    expect(compose).toContain("external: true");
    // No public ports bound (the host caddy fronts the instance).
    expect(compose).not.toContain("ports:");
    expect(compose).not.toContain('"80:80"');
    expect(compose).not.toContain('"443:443"');
    expect(compose).not.toContain("container_name: agent-inst-123-caddy");
  });

  it("generates a persistent uid-1024 passwd identity before starting compose", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).toContain(
      'docker run --rm --network none --entrypoint cat "$runtime_passwd_image" /etc/passwd'
    );
    expect(script).toMatch(/docker pull [^\n]+\n# Compose pins the two agent-bearing services/);
    expect(script).toContain(
      "awk -F: '$1 != \"hivra\" && $3 != \"1024\"' > \"$runtime_passwd_tmp\""
    );
    expect(script).toContain(
      "hivra:x:1024:1024:Hivra Agent:/home/hermes:/bin/sh"
    );
    expect(script).toContain('mv -f "$runtime_passwd_tmp" runtime-passwd');
    expect(script.indexOf('mv -f "$runtime_passwd_tmp" runtime-passwd')).toBeLessThan(
      script.indexOf("timeout 180s docker compose up")
    );

    const start = script.indexOf("# Compose pins the two agent-bearing services to uid/gid 1024");
    const end = script.indexOf("docker run --rm \\\n  -v agent-inst-123_agent-source:/target", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const dir = mkdtempSync(join(tmpdir(), "hivra-runtime-passwd-"));
    try {
      const command = `docker() {
  printf '%s\\n' \\
    'root:x:0:0:root:/root:/bin/sh' \\
    'stale:x:1024:1024:Stale:/wrong:/bin/false' \\
    'hermes:x:10000:10000:Hermes:/opt/data:/bin/sh'
}
INSTANCE_DIR=${JSON.stringify(dir)}
cd "$INSTANCE_DIR"
${script.slice(start, end)}`;
      const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

      expect(result.status).toBe(0);
      const passwd = readFileSync(join(dir, "runtime-passwd"), "utf8");
      expect(passwd).toContain("root:x:0:0:root:/root:/bin/sh");
      expect(passwd).toContain("hermes:x:10000:10000:Hermes:/opt/data:/bin/sh");
      expect(passwd).not.toContain("stale:x:1024");
      expect(passwd.match(/^hivra:x:1024:1024:Hivra Agent:\/home\/hermes:\/bin\/sh$/gm)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])("starts the dashboard wrapper immediately and bounds waiting when gateway ready=%s", (ready) => {
    const compose = buildWebUICompose({ ...baseParams, image: "webui:test", agentImage: "agent:test" });
    const service = compose.slice(compose.indexOf("  official-dashboard:"), compose.indexOf("  dashboard-sidecar:"));
    // A health dependency blocks compose scheduling itself and can leave this
    // service Created after the outer compose-up timeout. The wrapper, not the
    // dependency graph, must wait for a cold-starting gateway.
    expect(service).toContain("depends_on:\n      - gateway");
    expect(service).not.toContain("condition: service_healthy");
    const start = service.indexOf('echo "[official-dashboard] waiting for gateway health before startup"');
    const finish = service.indexOf("exec /opt/hermes/.venv/bin/hermes dashboard", start);
    expect(start).toBeGreaterThan(0);
    expect(finish).toBeGreaterThan(start);
    // Compose reduces $$ to $ before passing the single command argument to sh.
    const waitScript = service.slice(start, finish).replace(/\$\$/g, "$");
    const result = spawnSync("/bin/sh", ["-c", `curl() { return ${ready ? 0 : 1}; }; sleep() { :; };\n${waitScript}\nprintf 'DASHBOARD_STARTED\\n'`], {
      encoding: "utf8",
      timeout: 2_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(ready ? 0 : 1);
    expect(result.stdout.match(/waiting for gateway health/g)).toHaveLength(1);
    if (ready) {
      expect(result.stdout).toContain("DASHBOARD_STARTED");
      expect(result.stderr).toBe("");
    } else {
      expect(result.stdout).not.toContain("DASHBOARD_STARTED");
      expect(result.stderr).toContain("gateway did not become ready after 90 probes; startup failed");
    }
  });

  it("keeps Docker control out of the gateway unless a dedicated VM explicitly enables it", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
    });
    const gatewayServiceBlock = compose.slice(
      compose.indexOf("  gateway:"),
      compose.indexOf("  official-dashboard:")
    );
    const officialDashboardServiceBlock = compose.slice(
      compose.indexOf("  official-dashboard:"),
      compose.indexOf("  dashboard-sidecar:")
    );

    expect(gatewayServiceBlock).toContain('user: "1024:1024"');
    expect(gatewayServiceBlock).not.toContain("HERMES_ALLOW_ROOT_GATEWAY=1");
    expect(gatewayServiceBlock).not.toContain("/var/run/docker.sock");
    expect(officialDashboardServiceBlock).not.toContain("group_add:");
    expect(officialDashboardServiceBlock).not.toContain("/var/run/docker.sock");
  });

  it("gives both command-executing agent services Docker control when explicitly enabled", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      gatewayDockerAccess: true,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
    } as WebUIDeployParams & {
      gatewayDockerAccess: boolean;
      image: string;
      agentImage: string;
    });
    const gatewayServiceBlock = compose.slice(
      compose.indexOf("  gateway:"),
      compose.indexOf("  official-dashboard:")
    );
    const officialDashboardServiceBlock = compose.slice(
      compose.indexOf("  official-dashboard:"),
      compose.indexOf("  dashboard-sidecar:")
    );

    expect(gatewayServiceBlock).toContain('user: "1024:1024"');
    expect(gatewayServiceBlock).toContain("group_add:");
    expect(gatewayServiceBlock).toContain(
      '- "${HERMES_GUEST_DOCKER_GID:?guest Docker socket GID is required}"'
    );
    expect(gatewayServiceBlock).not.toContain("HERMES_ALLOW_ROOT_GATEWAY=1");
    expect(gatewayServiceBlock).toContain("- /var/run/docker.sock:/var/run/docker.sock");
    expect(gatewayServiceBlock).not.toContain("privileged: true");
    expect(officialDashboardServiceBlock).toContain('user: "1024:1024"');
    expect(officialDashboardServiceBlock).toContain("group_add:");
    expect(officialDashboardServiceBlock).toContain(
      '- "${HERMES_GUEST_DOCKER_GID:?guest Docker socket GID is required}"'
    );
    expect(officialDashboardServiceBlock).toContain(
      "- /var/run/docker.sock:/var/run/docker.sock"
    );
    expect(officialDashboardServiceBlock).not.toContain("privileged: true");
  });

  it("derives the guest Docker socket GID before compose and fails closed if it is unavailable", () => {
    const params = {
      ...baseParams,
      gatewayDockerAccess: true,
    } as WebUIDeployParams & { gatewayDockerAccess: boolean };
    const artifacts = buildWebUIProvisioningArtifacts(params);
    const script = buildWebUIBootstrapScript(artifacts, params, { mode: "update" });

    expect(script).toContain('if [ ! -S /var/run/docker.sock ]; then');
    expect(script).toContain("stat -c '%g' /var/run/docker.sock");
    expect(script).toContain('HERMES_GUEST_DOCKER_GID="$guest_docker_gid"');
    expect(script).toContain('printf \'HERMES_GUEST_DOCKER_GID=%s\\n\'');
    expect(script.indexOf("stat -c '%g' /var/run/docker.sock")).toBeLessThan(
      script.indexOf("docker compose pull")
    );
  });

  it("execs the gateway profile-supervisor with python3 (the agent image ships no bare `python`)", () => {
    // Regression for the 2026-06-11 fresh-deploy gateway crash-loop: the gateway
    // command launched its profile-supervisor with `exec python - <<'PY'`, but
    // the webui-free agent image only ships /usr/bin/python3 — there is no
    // `python` on PATH. Fresh boxes therefore died with
    // `sh: exec: python: not found` (exit 127): the dashboard + sidecar stayed
    // healthy but the chat embed was blank because the gateway hosts the
    // api_server on :8642. The supervisor must exec python3, not bare python.
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
    });
    const gatewayServiceBlock = compose.slice(
      compose.indexOf("  gateway:"),
      compose.indexOf("  official-dashboard:")
    );
    // The supervisor heredoc must be fed to python3, never bare python.
    expect(gatewayServiceBlock).toContain("exec python3 - <<'PY'");
    expect(gatewayServiceBlock).not.toContain("exec python - <<'PY'");
  });

  it("makes the gateway supervisor self-heal + back off instead of crash-looping into a blank workspace", () => {
    // Regression for a read-only-venv crash loop found in disposable verification and
    // the fleet-wide stale-.env variant: the gateway launches via `uv run`, which
    // re-syncs the venv and (a) rewrites .venv/bin/hermes — fatal if the venv tree
    // is read-only — and (b) honours UV_CACHE_DIR from the profile .env, which on
    // legacy /home/hermeswebui-homed instances points uv at an uncreatable cache
    // dir. Either way `uv run` exits non-zero on every launch and the supervisor
    // respawned it ~every 10s forever, hosting nothing on :8642 so the embedded
    // workspace rendered blank-white. The supervisor must now: (1) chmod the venv
    // writable before the first launch, (2) re-pin UV_CACHE_DIR/HOME/XDG_* from the
    // live container env so a stale .env can't repoint them, and (3) self-heal +
    // exponentially back off on a deterministic fast failure instead of a tight
    // silent restart loop.
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
    });
    const gatewayServiceBlock = compose.slice(
      compose.indexOf("  gateway:"),
      compose.indexOf("  official-dashboard:")
    );
    // (1) Pre-launch venv writability self-heal in the shell preamble.
    expect(gatewayServiceBlock).toContain(
      'chmod -R u+w "$$BASE_HOME/hermes-agent/.venv"'
    );
    // (2) Infra env keys are re-pinned from os.environ AFTER the profile .env is
    //     loaded, so a stale persisted UV_CACHE_DIR (legacy /home/hermeswebui)
    //     cannot win and crash uv's cache init.
    expect(gatewayServiceBlock).toContain("PINNED_INFRA_ENV_KEYS");
    expect(gatewayServiceBlock).toContain('"UV_CACHE_DIR"');
    // (3) Deterministic fast-failure handling: self-heal once, then escalating,
    //     capped backoff — never a tight forever-respawn.
    expect(gatewayServiceBlock).toContain("def heal_readonly_venv");
    expect(gatewayServiceBlock).toContain("cooldown_until");
    expect(gatewayServiceBlock).toContain("failing fast");
    expect(gatewayServiceBlock).toContain("min(60, 5 * (2 ** min(n - 1, 4)))");
  });

  // (Removed: the free-tier /tmp tmpfs cap lived on the bare webui service, which
  // is gone in the webui-free migration. The agent-image gateway/dashboard manage
  // their own /tmp; if a free-tier cap is wanted there, it's a separate follow-up.)

  it("bootstrap script ensures busybox is cached before any docker run busybox so Docker Hub rate-limits don't kill the redeploy", () => {
    // hermes-disk-cleanup evicts busybox:latest after 24h. Re-pull collides
    // with Docker Hub's 100/6h per-IP cap when many tenants on one host
    // (fixturenodea: 35 VMs) redeploy in a wave. The ensure-busybox snippet must
    // appear BEFORE the first `docker run ... busybox` (the workspace-chown
    // sidecar) so a missing-or-rate-limited pull falls back to retagging an
    // already-cached image.
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
    const ensureIdx = script.indexOf("[ensure-busybox]");
    const firstBusyboxRunIdx = script.indexOf("busybox sh -c 'mkdir -p /workspace");
    expect(ensureIdx).toBeGreaterThan(0);
    expect(firstBusyboxRunIdx).toBeGreaterThan(0);
    expect(ensureIdx).toBeLessThan(firstBusyboxRunIdx);
  });

  // Onboarding ritual seeding. The original guard only seeded when SOUL.md was
  // EMPTY, but the agent image ships a non-empty factory-default persona, so the
  // ritual never seeded on any box (Jun-2026). The guard now also seeds over the
  // factory default (and an un-run ritual), while preserving a real custom SOUL.
  it("seeds the onboarding ritual over an empty OR factory-default SOUL on fresh provision", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
    expect(script).toContain("seed_onboarding_soul");
    // guard overwrites the image's factory-default persona, not just an empty file
    expect(script).toContain("^You are Hermes Agent");
    expect(script).toContain("^# Hermes Agent Persona");
    expect(script).toContain("just came online");
  });

  // Reliability fix (Jul-2026): the seed used to be gated on `!isUpdate`, so a
  // box that reached "running" via a recovery redrive, and every config
  // redeploy (both run in update mode), skipped the seed entirely and left the
  // box on the raw factory-default SOUL.md. It now runs in update mode too —
  // the head-pattern guard makes the re-seed idempotent and safe (it never
  // clobbers a real authored identity), so a redriven/slow box gets its
  // ritual/persona soul on its next routine redeploy.
  it("ALSO seeds onboarding on update/redeploy, still guard-wrapped (reliability fix)", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });
    expect(script).toContain("seed_onboarding_soul");
    // guard is intact: only overwrites empty / factory-default / un-run-ritual SOULs
    expect(script).toContain("^You are Hermes Agent");
    expect(script).toContain("^# Hermes Agent Persona");
    expect(script).toContain("just came online");
  });

  // The health-wait loop (seq 1 180 = 360s) is the only place the seed fired;
  // if a box didn't pass health+surface probes in that window the loop fell
  // through to `exit 1` WITHOUT ever seeding, so a slow-but-eventually-up box
  // (recovered later) was stuck on the factory default. It now seeds once more,
  // best-effort + guard-protected, right before giving up.
  it("seeds once more on the health-wait timeout path before exit 1 (slow-provision reliability)", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
    // Anchor on the specific 360s-timeout message (the phrase "did not become
    // healthy" also appears in an earlier repair block, so match the full line).
    const timeoutIdx = script.indexOf(
      "WebUI did not become healthy (or dashboard surface not serving) in 360s"
    );
    expect(timeoutIdx).toBeGreaterThan(0);
    const exitIdx = script.indexOf("exit 1", timeoutIdx);
    expect(exitIdx).toBeGreaterThan(timeoutIdx);
    const seedBeforeExit = script.lastIndexOf("seed_onboarding_soul", exitIdx);
    expect(seedBeforeExit).toBeGreaterThan(timeoutIdx);
    expect(seedBeforeExit).toBeLessThan(exitIdx);
  });

  // Persona deploys: the authored soul replaces the ritual as the SOUL.md seed
  // (Jul-2026 finding: souls were stored in config.agentSettings.systemPrompt
  // but no provisioning path ever wrote them to a box — every persona deploy
  // booted into the who-am-I ritual and invented a contradicting identity).
  it("seeds the AUTHORED persona soul instead of the ritual when personaSoulPrompt is set", () => {
    const soul = getPersonaSoulPrompt("bea");
    expect(soul.length).toBeGreaterThan(2000); // sanity: real soul, not fallback
    const params: WebUIDeployParams = { ...baseParams, personaSoulPrompt: soul };
    const artifacts = buildWebUIProvisioningArtifacts(params);
    const script = buildWebUIBootstrapScript(artifacts, params, { mode: "provision" });
    expect(script).toContain("seed_onboarding_soul");
    expect(script).toContain(Buffer.from(soul, "utf8").toString("base64"));
    expect(script).toContain("seeded authored persona soul into SOUL.md");
    expect(script).not.toContain(Buffer.from(ONBOARDING_RITUAL, "utf8").toString("base64"));
    // The guard is unchanged: an authored soul may replace an empty file, the
    // factory default, or an un-run ritual — never a real onboarded identity.
    expect(script).toContain("^You are Hermes Agent");
    expect(script).toContain("just came online");
  });

  it("keeps the who-am-I ritual for non-persona deploys (zero-regression contract)", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
    expect(script).toContain(Buffer.from(ONBOARDING_RITUAL, "utf8").toString("base64"));
    expect(script).toContain("seeded first-run onboarding ritual into SOUL.md");
    expect(script).not.toContain("seeded authored persona soul");
  });

  // A redrive/config-redeploy of a persona box (update mode) re-seeds the hired
  // persona's authored soul — not the ritual — when the box is still
  // un-onboarded, so a box that only ever reached running via a redrive still
  // boots AS the persona. The guard keeps it from clobbering a real identity.
  it("seeds the AUTHORED persona soul on update/redeploy when personaSoulPrompt resolves", () => {
    const soul = getPersonaSoulPrompt("bea");
    expect(soul.length).toBeGreaterThan(2000); // sanity: real soul, not fallback
    const params: WebUIDeployParams = {
      ...baseParams,
      personaSoulPrompt: soul,
    };
    const artifacts = buildWebUIProvisioningArtifacts(params);
    const script = buildWebUIBootstrapScript(artifacts, params, { mode: "update" });
    expect(script).toContain("seed_onboarding_soul");
    expect(script).toContain(Buffer.from(soul, "utf8").toString("base64"));
    expect(script).toContain("seeded authored persona soul into SOUL.md");
    // The ritual is NOT seeded when a persona soul resolves, in update mode too.
    expect(script).not.toContain(Buffer.from(ONBOARDING_RITUAL, "utf8").toString("base64"));
  });

  // Operator OS deploys (agent image containing "operatoros", the PR #550
  // belt-and-suspenders substring): the box's identity is the autonomy SOUL
  // shipped inside the agent image, and this seeder is its ONLY installer on a
  // webfree box — the compose's `entrypoint: []` bypasses s6 (the image's
  // cont-init SOUL enforcer never runs) and soul-seed-reconcile skips
  // operatoros boxes. Before this gate, fresh Operator OS provisions booted
  // into the who-am-I ritual (Jul-2026 canary finding; box fixturecase22 was fixed
  // by hand).
  it("rejects a fresh Operator OS provision even when an image is passed explicitly", () => {
    const params: WebUIDeployParams = {
      ...baseParams,
      agentImage: "ghcr.io/ashneil12/operatoros-agent:stable",
    };
    expect(() => buildWebUIProvisioningArtifacts(params)).toThrow(
      "New Operator OS provisioning is unavailable"
    );
  });

  // Update/redeploy runs the same seed (that's how already-broken boxes get
  // organically reconciled), and the builder must null a stray persona soul on
  // its own — the callers already gate personaSoulPrompt for operatoros, but
  // the builder is the last line of defense (mirrors PR #550's belt-and-
  // suspenders): an Operator OS box must never boot AS Bea.
  it("seeds the autonomy SOUL on update mode too and ignores a stray persona soul (Operator OS)", () => {
    const soul = getPersonaSoulPrompt("bea");
    expect(soul.length).toBeGreaterThan(2000); // sanity: real soul, not fallback
    const params: WebUIDeployParams = {
      ...baseParams,
      agentImage: "ghcr.io/ashneil12/operatoros-agent:stable",
      personaSoulPrompt: soul,
    };
    const artifacts = buildWebUIProvisioningArtifacts(params, "update");
    const script = buildWebUIBootstrapScript(artifacts, params, { mode: "update" });
    expect(script).toContain(OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH);
    expect(script).toContain("seeded Operator OS autonomy SOUL into SOUL.md");
    expect(script).not.toContain(Buffer.from(soul, "utf8").toString("base64"));
    expect(script).not.toContain("seeded authored persona soul");
    expect(script).not.toContain(Buffer.from(ONBOARDING_RITUAL, "utf8").toString("base64"));
  });

  it("keeps the ritual seed for vanilla agent images (zero-regression contract for non-operatoros deploys)", () => {
    const params: WebUIDeployParams = {
      ...baseParams,
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
    };
    const artifacts = buildWebUIProvisioningArtifacts(params);
    const script = buildWebUIBootstrapScript(artifacts, params, { mode: "provision" });
    expect(script).toContain(Buffer.from(ONBOARDING_RITUAL, "utf8").toString("base64"));
    expect(script).toContain("seeded first-run onboarding ritual into SOUL.md");
    expect(script).not.toContain(OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH);
  });

  describe("browser sidecar (Pro-tier-gated)", () => {
    it("does NOT emit the browser-sidecar service block when the toggle is unset", () => {
      const compose = buildWebUICompose({
        ...baseParams,
        image: "ghcr.io/ashneil12/hermes-webui:stable",
        agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
      });
      // Default behaviour: free tier and any user who hasn't opted in get
      // zero RAM cost from the browser sidecar.
      expect(compose).not.toContain("browser-sidecar:");
      expect(compose).not.toContain("browser-state");
    });

    it("does NOT emit the browser-sidecar service block when toggle is explicitly false", () => {
      const compose = buildWebUICompose({
        ...baseParams,
        browserSidecarEnabled: false,
        image: "ghcr.io/ashneil12/hermes-webui:stable",
        agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
      });
      expect(compose).not.toContain("browser-sidecar:");
      expect(compose).not.toContain("browser-state");
    });

    it("emits the browser-sidecar service block + named volume when enabled", () => {
      const compose = buildWebUICompose({
        ...baseParams,
        browserSidecarEnabled: true,
        image: "ghcr.io/ashneil12/hermes-webui:stable",
        agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
      });

      // Service block present and named correctly.
      expect(compose).toContain("browser-sidecar:");
      expect(compose).toContain("container_name: agent-inst-123-browser-sidecar");

      // Internal port exposed but never bound to host. Caller is the agent
      // container on the same docker network.
      expect(compose).toContain('- "8789"');
      expect(compose).not.toContain("ports:\n      - \"8789:8789\"");

      // Tier-check Layer 2: the sidecar must hit the dashboard's internal
      // tier-check endpoint on start so a downgrade between deploy and start
      // takes the container down.
      expect(compose).toContain("- TIER_CHECK_URL=");
      expect(compose).toContain("/api/internal/tier-check");
      expect(compose).toContain("- TIER_CHECK_INSTANCE_ID=inst-123");

      // Bearer / signing secret reuses the per-instance webuiPassword so we
      // don't introduce a second credential to manage.
      expect(compose).toContain("- TIER_CHECK_TOKEN=webui-password");
      expect(compose).toContain("- SIGNING_SECRET=webui-password");

      // The sidecar bearer-auth token shipped in the follow-up PR. The
      // sidecar's preHandler gates every tool route on this value; the
      // agent client reads HERMES_BROWSER_SIDECAR_AUTH_TOKEN from
      // hermes.env. Both must use the same per-instance secret so a
      // redeploy rotates them in lockstep.
      expect(compose).toContain("- SIDECAR_AUTH_TOKEN=webui-password");

      // Named volume for the persistent Playwright user-data-dir.
      expect(compose).toContain("browser-state:\n    name: agent-inst-123_browser-state");
      expect(compose).toContain("- browser-state:/var/lib/hermes-browser");

      // Healthcheck wired to /health on the internal port.
      expect(compose).toContain("http://localhost:8789/health");
    });

    it("defaults prod deployments to the prod browser-sidecar image when no override is set", () => {
      withEnv(
        {
          HERMES_BROWSER_SIDECAR_IMAGE: undefined,
          HERMES_DEPLOY_CHANNEL: undefined,
          NEXT_PUBLIC_HERMES_DEPLOY_CHANNEL: undefined,
          VERCEL_GIT_REPO_SLUG: "hermesdeploy",
          GITHUB_REPOSITORY: "ashneil12/hermesdeploy",
        },
        () => {
          const compose = buildWebUICompose({
            ...baseParams,
            browserSidecarEnabled: true,
            image: "ghcr.io/ashneil12/hermes-webui:stable",
            agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
          });

          expect(compose).toContain("image: ghcr.io/ashneil12/hermes-browser-sidecar:stable");
          expect(compose).not.toContain("hermes-browser-sidecar-canary");
        }
      );
    });

    it("defaults canary deployments to the canary browser-sidecar image", () => {
      withEnv(
        {
          HERMES_BROWSER_SIDECAR_IMAGE: undefined,
          HERMES_DEPLOY_CHANNEL: undefined,
          NEXT_PUBLIC_HERMES_DEPLOY_CHANNEL: undefined,
          VERCEL_GIT_REPO_SLUG: "hermesdeploy-canary",
          GITHUB_REPOSITORY: "ashneil12/hermesdeploy-canary",
        },
        () => {
          const compose = buildWebUICompose({
            ...baseParams,
            browserSidecarEnabled: true,
            image: "ghcr.io/ashneil12/hermes-webui:stable",
            agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
          });

          expect(compose).toContain("image: ghcr.io/ashneil12/hermes-browser-sidecar-canary:stable");
        }
      );
    });

    it("the browser-sidecar block sits inside the services: section, not the volumes: section", () => {
      const compose = buildWebUICompose({
        ...baseParams,
        browserSidecarEnabled: true,
        image: "ghcr.io/ashneil12/hermes-webui:stable",
        agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
      });
      const networksIdx = compose.indexOf("\nnetworks:");
      const volumesIdx = compose.indexOf("\nvolumes:");
      const serviceIdx = compose.indexOf("browser-sidecar:");
      const volumeBlockIdx = compose.indexOf("browser-state:\n    name:");
      // Service block must come before networks/volumes; volume entry must
      // come after volumes:.
      expect(serviceIdx).toBeGreaterThan(0);
      expect(serviceIdx).toBeLessThan(networksIdx);
      expect(volumeBlockIdx).toBeGreaterThan(volumesIdx);
    });

    it("emits the autoheal watchdog with autoheal label on the sidecar when enabled", () => {
      const compose = buildWebUICompose({
        ...baseParams,
        browserSidecarEnabled: true,
        image: "ghcr.io/ashneil12/hermes-webui:stable",
        agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
      });
      // Autoheal sibling exists.
      expect(compose).toContain("autoheal:");
      expect(compose).toContain("image: willfarrell/autoheal:latest");
      expect(compose).toContain("- AUTOHEAL_CONTAINER_LABEL=autoheal");
      expect(compose).toContain("- /var/run/docker.sock:/var/run/docker.sock");
      // Browser-sidecar carries the matching label.
      expect(compose).toContain('- "autoheal=true"');
    });

    it("does NOT emit the autoheal watchdog when the sidecar is off (existing services keep current restart semantics)", () => {
      const compose = buildWebUICompose({
        ...baseParams,
        image: "ghcr.io/ashneil12/hermes-webui:stable",
        agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
      });
      expect(compose).not.toContain("autoheal:");
      expect(compose).not.toContain("willfarrell/autoheal");
    });

    it("emits same-origin /vnc/ noVNC routing in the inner Caddyfile when enabled, suppressed otherwise", () => {
      const enabled = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc", {
        browserSidecarEnabled: true,
      });
      // Same-origin /vnc/ route (proven box-tunnel viewer): no signed URL /
      // forward_auth — the sidecar's VNC password gates it instead.
      expect(enabled).toContain("handle_path /vnc/*");
      expect(enabled).toContain("reverse_proxy agent-inst-123-browser-sidecar:6080");
      expect(enabled).not.toContain("/browser-sidecar/novnc");
      expect(enabled).not.toContain("verify-novnc-url");

      const disabled = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc");
      expect(disabled).not.toContain("handle_path /vnc/*");
      expect(disabled).not.toContain("browser-sidecar:6080");
    });

    it("exposes ONLY the /browser-sidecar/cookies/import tool endpoint, bearer-gated, when enabled", () => {
      const enabled = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc", {
        browserSidecarEnabled: true,
      });
      // Cookie import: the one tool-API endpoint of :8789 we expose (so the
      // dashboard can load a user's cookies into the agent's browser). Exact
      // path + rewrite to the sidecar's /cookies/import; nothing else of :8789.
      expect(enabled).toContain("handle /browser-sidecar/cookies/import");
      expect(enabled).toContain("rewrite * /cookies/import");
      expect(enabled).toContain("reverse_proxy agent-inst-123-browser-sidecar:8789");
      // We must not blanket-proxy the whole tool API surface.
      expect(enabled).not.toContain("handle /browser-sidecar/* ");

      const disabled = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc");
      expect(disabled).not.toContain("/browser-sidecar/cookies/import");
    });

    it("CORS-opens the /vnc/ assets so the dashboard viewer can import noVNC modules", () => {
      const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc", {
        browserSidecarEnabled: true,
      });

      const vncBlock = caddyfile.match(/handle_path \/vnc\/\* \{[\s\S]*?\n  \}/)?.[0] || "";

      expect(vncBlock).toContain('header Access-Control-Allow-Origin "*"');
      expect(vncBlock).toContain('header Access-Control-Allow-Methods "GET, OPTIONS"');
      expect(vncBlock).toContain('header Access-Control-Allow-Headers "Content-Type"');
    });

    it("never surfaces the Vex browser_sidecar toolset (CDP mode drives Chrome via native browser tools)", () => {
      // CDP mode: the agent browses through the regular Chrome over CDP using
      // its native browser tools (in hermes-cli). The deterministic Vex
      // toolset is suppressed so it can't spawn a second, divergent Chrome.
      const offConfig = buildWebUIConfigYaml({ ...baseParams, browserSidecarEnabled: false });
      expect(offConfig).toContain("- hermes-cli");
      expect(offConfig).not.toContain("- browser_sidecar");

      const onConfig = buildWebUIConfigYaml({ ...baseParams, browserSidecarEnabled: true });
      expect(onConfig).toContain("- hermes-cli");
      expect(onConfig).not.toContain("- browser_sidecar");
    });

    // Regression guard for the Jun-2026 webui managed-Venice 401 outage: a `custom`
    // provider needs model.api_key in config.yaml because the agent does NOT fall
    // back to OPENAI_API_KEY for it — a keyless config.yaml made the agent send an
    // empty credential and the gateway 401'd every chat.
    it("bakes model.api_key into config.yaml when a key is present", () => {
      const cfg = buildWebUIConfigYaml(baseParams);
      expect(cfg).toContain('api_key: "provider-key"');
      // ordering: api_key sits inside the model block, after base_url
      expect(cfg.indexOf("api_key:")).toBeGreaterThan(cfg.indexOf("base_url:"));
      expect(cfg.indexOf("api_key:")).toBeLessThan(cfg.indexOf("toolsets:"));
    });

    it("omits api_key when there is no key (e.g. codex auth-bundle / unset BYO)", () => {
      const cfg = buildWebUIConfigYaml({ ...baseParams, llmApiKey: "" });
      expect(cfg).not.toContain("api_key:");
      expect(cfg).toContain('provider: "custom"');
    });

    it("omits the whole model block (and api_key) for unconfigured clean-slate boxes", () => {
      const cfg = buildWebUIConfigYaml({ ...baseParams, unconfigured: true });
      expect(cfg).not.toContain("api_key:");
      expect(cfg).not.toContain("model:");
    });

    // Default web-search backend. Without web.backend the agent's fallback is
    // `firecrawl` (needs an API key our default deploy doesn't ship), so every
    // fresh box's web search died with a 'browser not cooperating' error. The
    // generated config now defaults to `ddgs` (DuckDuckGo, no key) so search
    // works on every box. (Pro tier additionally gets the browser sidecar.)
    it("defaults web.backend to ddgs (keyless DuckDuckGo) so search works without a Tavily/Firecrawl key", () => {
      const cfg = buildWebUIConfigYaml(baseParams);
      expect(cfg).toContain("web:");
      expect(cfg).toContain("backend: ddgs");
      // web: block sits between model: and toolsets:, keeping the file readable
      expect(cfg.indexOf("web:")).toBeGreaterThan(cfg.indexOf("model:"));
      expect(cfg.indexOf("web:")).toBeLessThan(cfg.indexOf("toolsets:"));
    });

    it("omits the web: block for unconfigured clean-slate boxes (no model = no web)", () => {
      const cfg = buildWebUIConfigYaml({ ...baseParams, unconfigured: true });
      expect(cfg).not.toContain("web:");
      expect(cfg).not.toContain("backend: ddgs");
    });

    it("runs the agent CDP bridge (AGENT_CDP_ENABLED + port + expose) by default, off only when HERMES_AGENT_BROWSER_CDP_ENABLED=false", () => {
      const build = () =>
        buildWebUICompose({
          ...baseParams,
          browserSidecarEnabled: true,
          image: "ghcr.io/ashneil12/hermes-webui:stable",
          agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
        });

      // Default ON: the sidecar image's entrypoint launches Chrome + the CDP proxy
      // on AGENT_CDP_PORT, exposed on the docker network (never host-bound). Both
      // prod and canary images are CDP-capable, so this is the standard.
      withEnv({ HERMES_AGENT_BROWSER_CDP_ENABLED: undefined }, () => {
        const compose = build();
        expect(compose).toContain("- AGENT_CDP_ENABLED=true");
        // Chrome on 9223 (loopback), host-rewrite proxy on 9224 — the proxy is
        // the port exposed on the docker network + what BROWSER_CDP_URL targets.
        expect(compose).toContain("- AGENT_CDP_PORT=9223");
        expect(compose).toContain("- AGENT_CDP_PROXY_PORT=9224");
        expect(compose).toContain('- "9224"');
        expect(compose).not.toContain('- "9224:9224"');
      });

      // Explicit kill switch → no CDP env on the sidecar.
      withEnv({ HERMES_AGENT_BROWSER_CDP_ENABLED: "false" }, () => {
        const compose = build();
        expect(compose).not.toContain("AGENT_CDP_ENABLED");
        expect(compose).not.toContain("AGENT_CDP_PORT");
      });
    });

    it("wires BROWSER_CDP_URL to the sidecar CDP Chrome by default when the sidecar is enabled (kill switch removes it)", () => {
      const expected = "BROWSER_CDP_URL=http://agent-inst-123-browser-sidecar:9224";

      // Default (bridge on) + sidecar on → endpoint written to both env files
      // (hermes.env the agent reads, and the compose .env the overlay can touch).
      withEnv({ HERMES_AGENT_BROWSER_CDP_ENABLED: undefined }, () => {
        expect(buildHermesEnvFile({ ...baseParams, browserSidecarEnabled: true })).toContain(expected);
        expect(buildWebUIComposeEnv({ ...baseParams, browserSidecarEnabled: true })).toContain(expected);

        // Sidecar off → no endpoint (would be a dead CDP target).
        expect(buildHermesEnvFile({ ...baseParams, browserSidecarEnabled: false })).not.toContain("BROWSER_CDP_URL");
        expect(buildWebUIComposeEnv({ ...baseParams, browserSidecarEnabled: false })).not.toContain("BROWSER_CDP_URL");
      });

      // Kill switch → no endpoint even with the sidecar enabled.
      withEnv({ HERMES_AGENT_BROWSER_CDP_ENABLED: "false" }, () => {
        expect(buildHermesEnvFile({ ...baseParams, browserSidecarEnabled: true })).not.toContain("BROWSER_CDP_URL");
        expect(buildWebUIComposeEnv({ ...baseParams, browserSidecarEnabled: true })).not.toContain("BROWSER_CDP_URL");
      });
    });

    it("seeds agent.max_turns: 999 so the agent isn't force-summarized mid-task (tunable via WebUI /maxturns)", () => {
      const configYaml = buildWebUIConfigYaml(baseParams);
      expect(configYaml).toContain("agent:\n  max_turns: 999");
      expect(configYaml).not.toContain("max_turns: 30");
    });

    it("appends video_gen and Venice env aliases for Venice-backed native media tools", () => {
      const veniceParams: WebUIDeployParams = {
        ...baseParams,
        dashboardProvider: "venice",
        inferenceProvider: "custom",
        baseUrl: "https://api.venice.ai/api/v1",
      };

      const hermesEnv = buildHermesEnvFile(veniceParams);
      const configYaml = buildWebUIConfigYaml(veniceParams);

      expect(hermesEnv).toContain("OPENAI_API_KEY=provider-key");
      expect(hermesEnv).toContain("OPENAI_BASE_URL=https://api.venice.ai/api/v1");
      expect(hermesEnv).toContain("VENICE_API_KEY=provider-key");
      expect(hermesEnv).toContain("VENICE_BASE_URL=https://api.venice.ai/api/v1");
      expect(configYaml).toContain("toolsets:\n  - hermes-cli\n  - video_gen");
    });

    it("update-mode bootstrap script includes pre-pull disk cleanup so a tight-disk update does not silently fail", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });
      // Pre-pull cleanup must run BEFORE `docker pull` of the agent image.
      const cleanupIdx = updateScript.indexOf("hermes_volume_safe_update_cleanup pre-pull");
      const headroomIdx = updateScript.indexOf("\nhermes_verify_update_disk_headroom\n");
      const pullIdx = updateScript.indexOf("docker pull ");
      expect(cleanupIdx).toBeGreaterThan(0);
      expect(headroomIdx).toBeGreaterThan(cleanupIdx);
      expect(pullIdx).toBeGreaterThan(0);
      expect(headroomIdx).toBeLessThan(pullIdx);
      expect(updateScript).toContain("/usr/local/bin/hermes-disk-cleanup");
      expect(updateScript).toContain("docker builder prune -af");
      // Plain `-f` (not `-af`) so tagged-but-unused images such as the
      // auto-update LKG rollback tag survive cleanup.
      expect(updateScript).toContain("docker image prune -f ");
      expect(updateScript).not.toContain("docker image prune -af");
      expect(updateScript).toContain("HERMES_UPDATE_MIN_FREE_MB");
      expect(updateScript).not.toContain("docker volume prune");
      expect(updateScript).not.toContain("docker system prune --volumes");
      // The browser-sidecar Chrome cache (the dominant disk hog on Pro/browser
      // tenants) is pruned before the agent-image pull so a ballooned
      // browser-state can't fail the headroom check and block the update.
      expect(updateScript).toContain("prune_browser_sidecar_cache");
      // OCR/SFTP helpers install large disposable venvs in the active dashboard
      // container's writable /tmp. They must be removed before the headroom gate;
      // named customer volumes are deliberately untouched.
      expect(updateScript).toContain("prune_official_dashboard_ephemeral_tool_envs() {");
      expect(updateScript).toContain("\n  prune_official_dashboard_ephemeral_tool_envs\n");
      expect(updateScript).toContain(
        "rm -rf -- /tmp/ocrvenv /tmp/sftpvenv /tmp/node-compile-cache"
      );
      expect(updateScript).toContain("docker exec -u 0");
    });

    describe("browser-sidecar Chrome cache cleanup (disk-pressure backstop)", () => {
      it("defines a cache-only prune that preserves persistent profile state", () => {
        const fn = buildHermesBrowserSidecarCacheCleanupFunction();
        expect(fn).toContain("prune_browser_sidecar_cache() {");
        // Scoped to the browser-state volumes only.
        expect(fn).toContain("/var/lib/docker/volumes/*_browser-state/_data");
        // Targets the rebuildable Chrome cache dirs by name...
        for (const cname of ["Cache", '"Code Cache"', "GPUCache", "CacheStorage"]) {
          expect(fn).toContain(cname);
        }
        // ...via a name-matched find prune, NOT a blanket wipe of the volume or
        // the profile (cookies/logins/IndexedDB must survive).
        expect(fn).toContain('-type d -name "$cname" -prune -exec rm -rf {} +');
        expect(fn).not.toContain("rm -rf $vol_data/profiles\n");
        expect(fn).not.toContain("docker volume rm");
      });

      it("the update-mode cleanup both defines and invokes the cache prune", () => {
        const cleanup = buildHermesVolumeSafeUpdateCleanupFunctions();
        expect(cleanup).toContain("prune_browser_sidecar_cache() {");
        // Defined before it is called.
        const defIdx = cleanup.indexOf("prune_browser_sidecar_cache() {");
        const callIdx = cleanup.indexOf("\n  prune_browser_sidecar_cache\n");
        expect(defIdx).toBeGreaterThanOrEqual(0);
        expect(callIdx).toBeGreaterThan(defIdx);
      });
    });

    it("update-mode state-volume chown is fault-tolerant so transient SQLite WAL/SHM files cannot abort the update before the recreate", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });
      // Regression: `chown -R 1024:1024 /state` ran under `set -e`. When SQLite
      // *.db-wal/*.db-shm sidecar files were present then vanished mid-run
      // (checkpoint), chown exited non-zero and aborted the whole update BEFORE
      // the container recreate — silently (output -> /dev/null). fleet-live-update
      // reported "launched" but the container never moved to the new image. The
      // state-volume chown must be best-effort.
      expect(updateScript).toContain("chown -R 1024:1024 /state 2>/dev/null || true");
      // The env-repair docker-run helper (the last step before the recreate, which
      // closes its heredoc with `SH`) must use the tolerant form specifically.
      expect(updateScript).toMatch(/chown -R 1024:1024 \/state 2>\/dev\/null \|\| true\n+SH/);
    });

    it("update mode sanitizes persisted and generated env files before publishing or compose startup", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

      const sanitizeDefinition = updateScript.indexOf("sanitize_runtime_env_file() {");
      const persistedSanitize = updateScript.indexOf(
        'sanitize_runtime_env_file "$webui_env_tmp" "persisted WebUI state"'
      );
      const persistedPublish = updateScript.indexOf('mv -f "$webui_env_tmp" /state/.env');
      const composeSanitize = updateScript.indexOf(
        'sanitize_runtime_env_file /tmp/hermes-compose-generated.env "generated compose env"'
      );
      const composeReplay = updateScript.indexOf(
        "cat /tmp/hermes-compose-generated.env >> /seed/.env"
      );
      const composeStart = updateScript.indexOf("docker compose up -d");

      expect(sanitizeDefinition).toBeGreaterThan(-1);
      expect(persistedSanitize).toBeGreaterThan(sanitizeDefinition);
      expect(persistedPublish).toBeGreaterThan(persistedSanitize);
      expect(composeSanitize).toBeGreaterThan(sanitizeDefinition);
      expect(composeReplay).toBeGreaterThan(composeSanitize);
      expect(composeStart).toBeGreaterThan(composeReplay);
      expect(updateScript).toContain("invalid env key at line");
      expect(updateScript).not.toContain('echo "$invalid_env_line"');
    });

    it("update-mode re-seeds the generated compose env after .env is overwritten with the runtime env", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

      // Regression: the update-mode seed step does `cp /state/.env /seed/.env` to
      // carry the agent runtime env (notably the toolchain block, which the
      // gateway supervisor re-pins from the container env) into the compose
      // env_file. But `.env` IS the compose env_file for gateway AND
      // official-dashboard, so that copy also DELETED every key the builder emits
      // into .env but not into hermes.env. Only HERMES_DASHBOARD_URL +
      // API_SERVER_KEY were re-seeded; HERMES_INSTANCE_ID (the approval relay) and
      // HERMES_DASHBOARD_BASIC_AUTH_* (the /desktop cookie lane) were not, and
      // died on the container's next recreate.
      const snapshotIdx = updateScript.indexOf("cp /seed/.env /tmp/hermes-compose-generated.env");
      const clobberIdx = updateScript.indexOf("cp /state/.env /seed/.env");
      const reseedIdx = updateScript.indexOf("cat /tmp/hermes-compose-generated.env >> /seed/.env");

      expect(snapshotIdx).toBeGreaterThan(0);
      // Snapshot must be taken BEFORE the copy destroys the generated file...
      expect(snapshotIdx).toBeLessThan(clobberIdx);
      // ...and replayed AFTER it.
      expect(reseedIdx).toBeGreaterThan(clobberIdx);
      // Delete-then-append, so the generated value wins and no key is duplicated.
      expect(updateScript).toContain('sed -i "/^${compose_env_key}=/d" /seed/.env');
    });

    it("update-mode compose-env re-seed covers the keys the runtime env cannot carry", () => {
      // Guards the PREMISE of the re-seed above: .env genuinely holds keys that
      // hermes.env (-> /state/.env) does not, so overwriting .env with the runtime
      // env is lossy. If these ever move into hermes.env or a compose
      // `environment:` block, the re-seed can be revisited — until then it is the
      // only thing putting them back.
      const composeKeys = buildWebUIComposeEnv(baseParams)
        .split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => l.split("=", 1)[0]);
      const hermesKeys = new Set(
        buildHermesEnvFile(baseParams)
          .split("\n")
          .filter((l) => l && !l.startsWith("#") && l.includes("="))
          .map((l) => l.split("=", 1)[0])
      );
      const composeOnly = composeKeys.filter((k) => !hermesKeys.has(k));

      // The two that actually break a user-facing lane when lost.
      expect(composeOnly).toContain("HERMES_INSTANCE_ID");
      expect(composeOnly).toContain("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD");
      // And the re-seed replays the whole generated file, so it covers all of them.
      expect(composeOnly.length).toBeGreaterThan(0);
    });

    it("provision-mode cleans stale baked template layers only after WebUI is healthy", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });

      const healthyIdx = script.indexOf('echo "WebUI healthy"');
      const cleanupIdx = script.indexOf("Drop stale template image layers after the first healthy WebUI boot");
      expect(healthyIdx).toBeGreaterThan(0);
      expect(cleanupIdx).toBeGreaterThan(healthyIdx);
      expect(script).toContain("Running immediate Hermes disk cleanup after first healthy WebUI boot");
      expect(script).toContain("/usr/local/bin/hermes-disk-cleanup");
      expect(script).toContain("prune_dangling_docker_images");
      expect(script).toContain("prune_old_unused_hermes_agent_images");
      expect(script).toContain("'ghcr.io/ashneil12/vanilla-hermes-agent'");
      expect(script).toContain("docker builder prune -af");
      expect(script).toContain("ctr -n moby content prune references");
      expect(script).toContain("fstrim -av");
      expect(script).not.toContain("docker volume prune");
      expect(script).not.toContain("docker system prune --volumes");
    });

    it("bounds compose startup so a detached compose hang cannot skip first-boot cleanup", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });

      const composeIdx = script.indexOf("timeout 180s docker compose up -d --remove-orphans");
      const healthIdx = script.indexOf("# Wait for health");
      const cleanupIdx = script.indexOf("Running immediate Hermes disk cleanup after first healthy WebUI boot");
      expect(composeIdx).toBeGreaterThan(0);
      expect(healthIdx).toBeGreaterThan(composeIdx);
      expect(cleanupIdx).toBeGreaterThan(healthIdx);
      expect(script).toContain("docker compose up timed out after 180s");
      // The timeout-continue guard still falls through to `exit "$compose_up_rc"`
      // when NO runtime container exists (genuine failure), so a detached hang
      // can't silently skip first-boot cleanup.
      expect(script).toContain('>/dev/null 2>&1 || exit "$compose_up_rc"');
    });

    it("timeout-continue guard is webfree-aware: probes any runtime container, not just the bare agent-<id>", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });

      // Regression: the old guard hard-coded `docker inspect agent-inst-123`,
      // which never exists on webfree instances (they run -gateway /
      // -official-dashboard, no bare container). On a slow webfree host that
      // tripped the 180s timeout (exit 124) even though the stack came up, the
      // bare inspect failed and the script spuriously `exit 124`d, reporting a
      // healthy provision as FAILED. Guard must accept ANY real runtime
      // container before bailing.
      expect(script).not.toContain('docker inspect agent-inst-123 >/dev/null 2>&1 || exit "$compose_up_rc"');
      expect(script).toContain(
        'docker inspect agent-inst-123 >/dev/null 2>&1 || ' +
          'docker inspect agent-inst-123-gateway >/dev/null 2>&1 || ' +
          'docker inspect agent-inst-123-official-dashboard >/dev/null 2>&1 || ' +
          'exit "$compose_up_rc"'
      );
    });

    it("update-mode docker compose pull uses --ignore-pull-failures so one missing image does not abort the whole update", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });
      expect(updateScript).toContain("docker compose pull --ignore-pull-failures");

      // Provision mode must NOT use the flag (provision is first-boot, every
      // image MUST pull successfully or the instance is broken).
      const provisionScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
      expect(provisionScript).not.toContain("--ignore-pull-failures");
    });

    it("update-mode verifies the running containers actually swapped onto :stable and fails loudly otherwise", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

      // Resolve the freshly-pulled :stable image id for the webui-free
      // services. gateway + official-dashboard both run the agent image.
      expect(updateScript).toContain(
        `agent_target_iid="$(docker image inspect ghcr.io/ashneil12/vanilla-hermes-agent:stable --format '{{.Id}}' 2>/dev/null || true)"`
      );
      // Compare each running container's image id ({{.Image}}) to its target.
      expect(updateScript).toContain(
        `[ "$(hermes_running_image_iid agent-inst-123-gateway)" = "$agent_target_iid" ] || return 1`
      );
      expect(updateScript).toContain(
        `[ "$(hermes_running_image_iid agent-inst-123-official-dashboard)" = "$agent_target_iid" ] || return 1`
      );
      expect(updateScript).not.toContain("webui_target_iid=");
      expect(updateScript).not.toContain("hermes_running_image_iid agent-inst-123)");
      // On mismatch, re-drive a targeted force-recreate (the known-good manual
      // fix) and, if it still won't converge, exit non-zero so the wrapper
      // reports "failed" instead of a false success.
      expect(updateScript).toContain(
        "timeout 180s docker compose up -d --force-recreate --no-deps gateway"
      );
      expect(updateScript).toContain(
        "docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' agent-inst-123-gateway"
      );
      expect(updateScript).toContain(
        "timeout 180s docker compose up -d --force-recreate --no-deps official-dashboard"
      );
      expect(updateScript).not.toContain(
        "--no-deps gateway official-dashboard"
      );
      expect(updateScript.indexOf("--no-deps gateway")).toBeLessThan(
        updateScript.indexOf("--no-deps official-dashboard")
      );
      expect(updateScript).not.toContain(
        "timeout 180s docker compose up -d --force-recreate --no-deps webui gateway official-dashboard"
      );
      expect(updateScript).toContain(
        "[webui-update] FATAL: containers did not converge to :stable after recreate retries"
      );

      // The convergence gate must sit AFTER the initial compose up and BEFORE
      // the health loop, so a healthy-but-stale old container can no longer
      // satisfy the /health probe and short-circuit to exit 0.
      const initialUpIdx = updateScript.indexOf(
        "timeout 180s docker compose up -d --remove-orphans --force-recreate"
      );
      const gateIdx = updateScript.indexOf("Verify image convergence (update mode)");
      const healthIdx = updateScript.indexOf("# Wait for health");
      expect(initialUpIdx).toBeGreaterThan(0);
      expect(gateIdx).toBeGreaterThan(initialUpIdx);
      expect(healthIdx).toBeGreaterThan(gateIdx);

      // Provision mode is first-boot: there is no prior container/image to
      // converge from, so the gate must not appear there.
      const provisionScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
      expect(provisionScript).not.toContain("Verify image convergence (update mode)");
      expect(provisionScript).not.toContain("hermes_update_converged");
    });

    it("downs a legacy gateway stack BEFORE the webfree compose up (memory-safe migration)", () => {
      // Regression for the 2026-06-15 incident: redeploying a legacy gateway box
      // onto the webfree stack ran both container sets at once under
      // --force-recreate, spiking RAM past the 1GB free-tier cap mid-swap and
      // getting the VM watchdog-shut-down half-migrated. The bootstrap must tear
      // the old stack (detected via the gateway-only `-web` container) down FIRST
      // so the webfree stack starts into freed RAM. Must run for BOTH modes (a
      // gateway→webfree migration can arrive via provision OR update) and sit
      // before the swap `compose up`.
      for (const mode of ["update", "provision"] as const) {
        const artifacts = buildWebUIProvisioningArtifacts(baseParams);
        const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode });
        const guardIdx = script.indexOf('grep -qx "agent-inst-123-web"');
        expect(guardIdx).toBeGreaterThan(0);
        expect(script).toContain("downing it before webfree up (memory-safe migration)");
        const downIdx = script.indexOf("docker compose down --remove-orphans", guardIdx);
        expect(downIdx).toBeGreaterThan(guardIdx);
        const swapUpIdx = script.indexOf("timeout 180s docker compose up -d ", guardIdx);
        expect(swapUpIdx).toBeGreaterThan(downIdx);
      }
    });

    it("can force-pull the WebUI image during provision while still using baked agent images", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, {
        mode: "provision",
        forceWebUIImagePull: true,
      });

      expect(script).toContain("[webui-image] Force-pulling WebUI image for fresh provision");
      expect(script).toContain("docker pull ghcr.io/ashneil12/hermes-webui:stable");
      expect(script).toContain("[webui-image] WARN: docker pull failed");
      expect(script).toContain("[webui-image] continuing with existing image");
      expect(script).toContain("[webui-image] FATAL: docker pull failed and no local image exists");
      expect(script).not.toContain(
        "docker image inspect ghcr.io/ashneil12/hermes-webui:stable >/dev/null 2>&1 || docker compose pull"
      );
      // Keep the heavy agent runtime cache-friendly unless update mode is
      // explicitly requested; the canary risk is the WebUI app image baked
      // into templates, not the agent source seed image.
      expect(script).toContain(
        "docker image inspect ghcr.io/ashneil12/vanilla-hermes-agent:stable >/dev/null 2>&1 || docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable"
      );
      expect(script).toContain("docker compose up -d --remove-orphans");
      expect(script).not.toContain("docker compose up -d --remove-orphans --force-recreate");
    });

    it("can force-pull the Hermes Agent seed image during provision", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, {
        mode: "provision",
        forceAgentImagePull: true,
      });

      expect(script).toContain("[agent-image] Force-pulling Hermes Agent seed image for fresh provision");
      expect(script).toContain("docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable");
      expect(script).toContain("[agent-image] WARN: docker pull failed");
      expect(script).toContain("[agent-image] continuing with existing image");
      expect(script).toContain("[agent-image] FATAL: docker pull failed and no local image exists");
      expect(script).not.toContain(
        "docker image inspect ghcr.io/ashneil12/vanilla-hermes-agent:stable >/dev/null 2>&1 || docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable"
      );
    });

    it("quiesces cloud-image apt timers before Docker image work on fresh provision", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, {
        mode: "provision",
        forceWebUIImagePull: true,
        forceAgentImagePull: true,
      });

      const quiesceIdx = script.indexOf("hermes_quiesce_background_apt");
      const agentPullIdx = script.indexOf("[agent-image] Force-pulling");
      const webuiPullIdx = script.indexOf("[webui-image] Force-pulling");

      expect(script).toContain("/var/log/hermes-apt-quiesce.log");
      expect(script).toContain("apt-daily.timer apt-daily-upgrade.timer");
      expect(script).toContain("apt.systemd.daily|unattended-upgrade|packagekitd");
      expect(quiesceIdx).toBeGreaterThan(0);
      expect(agentPullIdx).toBeGreaterThan(quiesceIdx);
      expect(webuiPullIdx).toBeGreaterThan(quiesceIdx);
    });

    it("treats the WebUI-free gateway/dashboard stack as healthy without waiting on the removed main container", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, {
        mode: "provision",
      });

      expect(script).toContain("webui_free_stack_healthy()");
      expect(script).toContain("agent-inst-123-gateway agent-inst-123-official-dashboard agent-inst-123-dashboard-sidecar");
      expect(script).toContain('echo "[webui-bootstrap] WebUI-free stack healthy + dashboard surface serving"');
      expect(script).toContain('echo "WebUI healthy"');
      // The deploy must not report healthy until the PUBLIC dashboard shells
      // actually serve SPA HTML (container health != dashboard serving — the
      // 2026-06-15 incident). The surface gate must be ANDed onto the primary
      // healthy-exit, not just defined.
      expect(script).toContain("webui_free_surface_ready()");
      // Topology-agnostic surface probe: it must carry the instance FQDN +
      // --resolve (Hetzner-host webfree keys the in-VM Caddy on the real FQDN
      // with auto_https), NOT a bare localhost:80 that only matches Proxmox's
      // :80 site — a bare-localhost probe false-fails every Hetzner deploy.
      expect(script).toContain('--resolve "agent.example.com:80:127.0.0.1"');
      expect(script).toContain('"http://agent.example.com$path"');
      expect(script).not.toContain('"http://localhost:80$path"');
      expect(script).toContain("if webui_free_stack_healthy && webui_free_surface_ready; then");
      // The WebUI-free stack gate must be defined before the legacy
      // bare-container /health probe it falls back to. Match the legacy probe
      // specifically (the inspect immediately followed by the python /health
      // exec) so unrelated `docker inspect ... State.Running` shims emitted
      // earlier in the bootstrap don't shift this ordering check.
      expect(script.indexOf("webui_free_stack_healthy")).toBeLessThan(
        script.indexOf("docker exec agent-inst-123 python -c 'import urllib.request;")
      );
      expect(script).toContain(
        "docker inspect --format='{{.State.Running}}' agent-inst-123"
      );
      expect(script).toContain(
        "docker exec agent-inst-123 python -c 'import urllib.request;"
      );
      expect(script).not.toContain("docker exec agent-inst-123 python - <<'PY'");
    });

    it("pre-creates the agent-source mount-point dir inside webui-state owned 1024:1024 so the nested-volume mount doesn't leave it root-owned", () => {
      // Regression for 2026-05-12 fresh-deploy failures on fixturenodea: docker creates
      // the agent-source mount point as root:root when establishing the nested
      // volume mount at /home/hermes/.hermes/hermes-agent. The webui
      // container's docker_init.bash later runs `chown -R /home/hermes`
      // but the mount overlay hides the underlying webui-state dir entry, so
      // chown can't reach it from inside the container. Downstream the
      // uid 1024 tries `mkdir /home/hermes/.hermes/cache`
      // and hits Permission denied — entire venv install fails, container
      // restart-loops, Phase 2 readiness times out at 600s, VM auto-destroyed.
      //
      // Fix is a busybox sidecar that pre-chowns the state volume (including
      // the hermes-agent subdir we create explicitly) BEFORE docker compose up,
      // mirroring the existing webui-workspace chown sidecar.
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });

      // The sidecar must mount webui-state and pre-create both the
      // agent-source mount-point AND the cache subtree, then chown + chmod.
      expect(script).toContain("docker run --rm -i -u 0:0");
      expect(script).toContain("-v agent-inst-123_webui-state:/state");
      expect(script).toContain("busybox sh <<'SH'");
      expect(script).toContain("mkdir -p /state /state/hermes-agent");
      expect(script).toContain("/state/cache/uv/tools");
      // The gateway runtime dirs are pre-created here too (born-webfree fix:
      // otherwise the root-running official-dashboard mints them root:0 700 and
      // the uid-1024 gateway crashloops on hooks/ scandir). See webui-runtime-env.
      expect(script).toContain("/state/hooks /state/audio_cache /state/image_cache /state/pairing");
      expect(script).toContain("chown -R 1024:1024 /state");
      expect(script).toContain("chmod 755 /state /state/hermes-agent");
      expect(script).toContain("/state/cache/uv/tools");
      expect(script).toContain("chmod -R u+rwX,go+rX /state/cache");

      // Must come BEFORE `docker compose up -d` so the dirs exist when docker
      // sets up the nested volume mount + the webui init runs as uid 1024.
      const chownIdx = script.indexOf("Repair WebUI persistent state cache ownership");
      const composeUpIdx = script.indexOf("\ntimeout 180s docker compose up -d --remove-orphans");
      expect(chownIdx).toBeGreaterThan(0);
      expect(composeUpIdx).toBeGreaterThan(chownIdx);
    });

    it("keeps heredoc-fed docker run helpers interactive so repair scripts receive stdin", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
      const lines = script.split("\n");
      const heredocRunBlocks = lines.flatMap((line, index) => {
        if (!line.includes("busybox sh <<'SH'")) return [];
        return [lines.slice(Math.max(0, index - 4), index + 1).join("\n")];
      });

      expect(heredocRunBlocks.length).toBeGreaterThan(0);
      for (const block of heredocRunBlocks) {
        expect(block).toContain("docker run --rm -i");
      }
    });

    it("update-mode state-seed always strips the Vex browser_sidecar toolset (CDP mode), even when the sidecar is enabled", () => {
      // CDP mode never surfaces the deterministic Vex toolset, so the merge runs
      // in removal mode regardless of browserSidecarEnabled — this also cleans
      // up any stale entry left in live /state/config.yaml by a pre-CDP deploy.
      const enabledArtifacts = buildWebUIProvisioningArtifacts({
        ...baseParams,
        browserSidecarEnabled: true,
      });
      const enabledScript = buildWebUIBootstrapScript(
        enabledArtifacts,
        { ...baseParams, browserSidecarEnabled: true },
        { mode: "update" },
      );
      // The merge function fires in removal mode (desired=false) even when the
      // sidecar container itself is enabled.
      expect(enabledScript).toContain("merge_browser_sidecar_toolset");
      expect(enabledScript).toContain("desired_browser_sidecar='false'");
      // Top-level + per-profile coverage (live state's profile configs each
      // have their own toolsets list and must each get cleaned).
      expect(enabledScript).toContain("merge_browser_sidecar_toolset /state/config.yaml");
      expect(enabledScript).toContain("/state/profiles/*/config.yaml");

      const disabledArtifacts = buildWebUIProvisioningArtifacts(baseParams);
      const disabledScript = buildWebUIBootstrapScript(disabledArtifacts, baseParams, { mode: "update" });
      expect(disabledScript).toContain("desired_browser_sidecar='false'");
      expect(disabledScript).toContain("merge_browser_sidecar_toolset");
    });
  });

  it("does not pin HERMES_CONFIG_PATH (it must stay unset so WebUI can resolve per-profile config.yaml from the hermes_profile cookie)", () => {
    // Regression for the sub-agent model-save bug: a hard-coded
    // HERMES_CONFIG_PATH short-circuits WebUI's _get_config_path() before it
    // can honor the per-request profile cookie, so every sub-agent model edit
    // silently rewrites the default profile's config.yaml. The env var must
    // stay absent so WebUI falls through to get_active_hermes_home().
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
    });
    expect(compose).not.toContain("HERMES_CONFIG_PATH");
  });

  // (Removed: the HERMES_WEBUI_DEFAULT_MODEL=${HERMES_MODEL:-…} compose env lived
  // on the bare webui service, dropped in the webui-free migration. The
  // persisted-config-overrides-default behavior is now via config.yaml (the
  // agent reads the persisted webui-state config), covered by the update-mode
  // "preserves the persisted WebUI model config" tests below.)

  it("seeds fresh WebUI deploys with the dashboard provider-qualified default model", () => {
    const artifacts = buildWebUIProvisioningArtifacts({
      ...baseParams,
      dashboardProvider: "crof",
      defaultModel: "deepseek-v4-pro",
    });

    expect(artifacts.envFile).toContain("HERMES_WEBUI_DEFAULT_MODEL=@crof:deepseek-v4-pro");
    // (compose env dropped with the webui service; config.yaml is the real seed)
    expect(artifacts.configYaml).toContain('default: "deepseek-v4-pro"');
    // HERMES_MODEL is deliberately NOT stamped into hermes.env: the official
    // dashboard's _resolve_model() reads it before config.yaml, and a stale pin
    // bricks the model switcher (keyless-provider). config.yaml owns the model.
    expect(artifacts.hermesEnvFile).not.toContain("HERMES_MODEL=");
  });

  it("routes public traffic through the host caddy import", () => {
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc");

    expect(caddyfile).toContain("agent.example.com {");
    expect(caddyfile).not.toContain("agent.example.com, :80");
    expect(caddyfile).toContain("reverse_proxy agent-inst-123-official-dashboard:9119");
    expect(caddyfile).toContain("flush_interval -1");
  });

  it("enforces bearer auth at Caddy edge with public exemptions", () => {
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz");

    // Bearer matcher carries the per-instance token
    expect(caddyfile).toContain('@authBearer header Authorization "Bearer secret-bearer-xyz"');
    // Public endpoints reachable without auth (dashboard probes these,
    // and `/` MUST be public so the iframe SPA shell HTML loads —
    // see the iframe-shim bearer-from-hash flow).
    expect(caddyfile).toContain("@public path / /health /api/auth/status /favicon.ico");
    // Default fall-through rejects unauthenticated requests
    expect(caddyfile).toContain("respond 401");
  });

  it("pins HERMES_DASHBOARD_SESSION_TOKEN on official-dashboard so a remote Desktop client can authenticate", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const start = compose.indexOf("  official-dashboard:\n");
    const end = compose.indexOf("\n  # Browser handoff sidecar", start);
    const block = compose.slice(start, end);

    // The dashboard web_server's session-token bearer is pinned to the
    // per-instance webuiPassword (= API_SERVER_KEY) so the dashboard can hand
    // the owner a stable token for Nous Hermes Desktop "remote gateway" mode.
    expect(block).toContain("- HERMES_DASHBOARD_SESSION_TOKEN=webui-password");
    // Same value the gateway service uses for API_SERVER_KEY — one token,
    // both the edge Caddy /desktop bearer and the web_server session check.
    expect(compose).toContain("- API_SERVER_KEY=webui-password");
  });

  it("bakes the hardened 'basic' auth creds INLINE into the compose environment (not only .env) so the on-VM secrets-sync overlay can't strip them", () => {
    // Regression guard for the fleet-wide /desktop cookie-lane outage (2026-07):
    // the June-2026 auth hardening FAILS CLOSED with no provider registered, and
    // the on-VM secrets-sync overlay ("sync-profiles.sh") regenerates .env from
    // its own template, dropping the HERMES_DASHBOARD_BASIC_AUTH_* block. The
    // overlay owns .env but never touches docker-compose.yml, and compose
    // `environment:` overrides `env_file`, so the block MUST be inline in compose
    // to survive. Empirically 33 hardened boxes were already active-broken.
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });

    // The official-dashboard service runs the basic provider — it MUST carry all
    // four creds inline in its own environment block.
    const odStart = compose.indexOf("  official-dashboard:\n");
    const odEnd = compose.indexOf("\n  # Browser handoff sidecar", odStart);
    const officialDashboardBlock = compose.slice(odStart, odEnd);
    expect(officialDashboardBlock).toContain("- HERMES_DASHBOARD_BASIC_AUTH_USERNAME=hivra");
    expect(officialDashboardBlock).toContain("- HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=webui-password");
    expect(officialDashboardBlock).toContain("- HERMES_DASHBOARD_BASIC_AUTH_SECRET=");
    expect(officialDashboardBlock).toContain("- HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS=43200");

    // The gateway service also carries them inline so the sidecar's recovery
    // fallback (relaunch the dashboard inside the gateway container) still
    // registers the provider. So the username line appears in compose exactly
    // twice — once per service — never fewer (fewer = a service lost the inline
    // copy and would depend on the clobberable .env).
    const usernameOccurrences = compose.split(
      "- HERMES_DASHBOARD_BASIC_AUTH_USERNAME=hivra",
    ).length - 1;
    expect(usernameOccurrences).toBe(2);

    // .env keeps the block too (belt-and-suspenders for non-overlay recovery
    // paths), but it is NOT the authoritative copy.
    expect(buildWebUIComposeEnv(baseParams)).toContain(
      "HERMES_DASHBOARD_BASIC_AUTH_USERNAME=hivra",
    );
  });

  it("keeps the hardened dashboard cookie gate enabled so the sidecar can mint WebSocket tickets", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const start = compose.indexOf("  official-dashboard:\n");
    const end = compose.indexOf("\n  # Browser handoff sidecar", start);
    const block = compose.slice(start, end);

    // HERMES_DASHBOARD_TRUST_PROXY disables app.state.auth_required in the
    // agent image. That makes /auth/password-login appear successful while the
    // resulting cookies are ignored, so /api/auth/ws-ticket returns 401 and
    // the sidecar cannot bridge the browser's /api/ws connection.
    expect(block).not.toMatch(/^\s*-\s+HERMES_DASHBOARD_TRUST_PROXY=/m);
    expect(block).toContain("- HERMES_DASHBOARD_BASIC_AUTH_USERNAME=hivra");
    expect(block).toContain("- HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=webui-password");
  });

  it("does NOT pass --tui to the dashboard command (upstream made it a top-level chat flag; passing it crash-loops the dashboard)", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    // Regression guard for the 2026-06-05 incident: an Aeon upstream sync moved
    // --tui to `hermes [--tui] {dashboard,...}`, so `dashboard --tui` is rejected
    // ("unrecognized arguments: --tui") and the container crash-loops.
    expect(compose).toContain(
      "exec /opt/hermes/.venv/bin/hermes dashboard --host 0.0.0.0 --port 9119 --no-open --insecure",
    );
    expect(compose).not.toContain("--insecure --tui");
  });

  it("exposes the hermes-dashboard backend over a bearer-authed /desktop route for the Nous Desktop app", () => {
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz");

    // /desktop is a distinct surface from the webui chat /api/* routes: it
    // proxies the upstream `hermes dashboard` backend (official-dashboard:9119)
    // that the native Desktop app speaks to.
    expect(caddyfile).toContain('@desktopBearer {');
    expect(caddyfile).toContain("path /desktop /desktop/*");
    expect(caddyfile).toContain('header Authorization "Bearer secret-bearer-xyz"');
    // The Desktop app's HTTP requests authenticate with X-Hermes-Session-Token
    // (fetchJson in main.cjs), NOT Authorization: Bearer. Missing this header
    // matcher = every Desktop HTTP probe 401s. Regression guard.
    expect(caddyfile).toContain("@desktopHeaderToken {");
    expect(caddyfile).toContain('header X-Hermes-Session-Token "secret-bearer-xyz"');
    expect(caddyfile).toMatch(
      /handle @desktopHeaderToken \{[\s\S]*reverse_proxy agent-inst-123-official-dashboard:9119/m
    );
    // WS gateway (/desktop/api/ws?token=) can't set a header → query-token auth,
    // same per-instance bearer.
    expect(caddyfile).toContain("@desktopQueryToken {");
    expect(caddyfile).toContain("query token=secret-bearer-xyz");
    // Both handlers strip the prefix and proxy to the official-dashboard service
    // (NOT the webui chat container).
    expect(caddyfile).toMatch(
      /handle @desktopBearer \{[\s\S]*uri strip_prefix \/desktop[\s\S]*reverse_proxy agent-inst-123-official-dashboard:9119/m
    );
    expect(caddyfile).toMatch(
      /handle @desktopQueryToken \{[\s\S]*reverse_proxy agent-inst-123-official-dashboard:9119/m
    );
    // Order: the /desktop handlers must precede the header-only @authBearer
    // handler (which would otherwise claim a /desktop request that carries the
    // bearer) and the catch-all 401.
    const desktopIdx = caddyfile.indexOf("handle @desktopBearer");
    const authBearerIdx = caddyfile.indexOf("handle @authBearer");
    const catchAllIdx = caddyfile.lastIndexOf("respond 401");
    expect(desktopIdx).toBeGreaterThan(0);
    expect(authBearerIdx).toBeGreaterThan(desktopIdx);
    expect(catchAllIdx).toBeGreaterThan(desktopIdx);
    // Unauthenticated /desktop requests are rejected at the edge, not leaked to
    // the webui chat handlers.
    expect(caddyfile).toContain("@desktopUnauthed path /desktop /desktop/*");
  });

  it("binds every Desktop credential form to one instance token and exposes only status publicly", () => {
    const ownerToken = "owner-instance-token";
    const foreignToken = "foreign-instance-token";
    const caddyfile = buildWebUICaddyfile("owner-agent.example.com", "agent-owner", ownerToken);

    expect(caddyfile).toContain(`header X-Hermes-Session-Token "${ownerToken}"`);
    expect(caddyfile).toContain(`header Authorization "Bearer ${ownerToken}"`);
    expect(caddyfile).toContain(`query token=${ownerToken}`);
    expect(caddyfile).not.toContain(foreignToken);
    // One matcher definition and its one handle reference are present; the
    // matcher itself names only the status discovery endpoint.
    expect(caddyfile.match(/@desktopPublicStatus \{/g)).toHaveLength(2);
    expect(caddyfile.match(/path \/desktop\/api\/status/g)).toHaveLength(1);
    expect(caddyfile).toMatch(/@desktopPublicStatus \{\s*path \/desktop\/api\/status\s*method GET HEAD\s*\}/m);
    expect(caddyfile).toMatch(/@desktopUnauthed path \/desktop \/desktop\/\*[\s\S]*?respond 401/m);
  });

  it("serves WebUI SPA document navigations without exposing protected APIs", () => {
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz");

    expect(caddyfile).toContain("@publicHtml {");
    expect(caddyfile).toContain('header_regexp Accept ".*text/html.*"');
    expect(caddyfile).toContain("not path /api* /_sidecar* /web-api* /browser-sidecar* /v1* /mcp* /acp*");

    const publicHtmlIdx = caddyfile.indexOf("handle @publicHtml");
    const bearerIdx = caddyfile.indexOf("handle @authBearer");
    expect(publicHtmlIdx).toBeGreaterThan(0);
    expect(bearerIdx).toBeGreaterThan(publicHtmlIdx);
    expect(caddyfile).toMatch(/handle @publicHtml \{[\s\S]*rewrite \* \/[ \t]*\n[\s\S]*reverse_proxy agent-inst-123-official-dashboard:9119/m);
  });

  it("authenticates EventSource / WebSocket via ?token= query param (iframe-shim contract)", () => {
    // Regression guard for the iframe-shim contract: when SSE/WS requests
    // come in with `?token=<bearer>` (because EventSource cannot set the
    // Authorization header from JS), Caddy must accept them. Without
    // this matcher, every chat-stream EventSource hits the 401 catch-all
    // and surfaces as "Error: Connection lost" in the chat.
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz");

    // Matcher emitted with the same per-instance token as @authBearer
    expect(caddyfile).toContain("@authQueryToken query token=secret-bearer-xyz");
    // Handler routes to the same upstream as @authBearer with SSE-safe
    // flush_interval -1. Routed through the dashboard-sidecar (not the
    // dashboard directly): the hardened image gates the dashboard, so the
    // sidecar swaps this SPA ?token= for a real gated session before forwarding.
    expect(caddyfile).toMatch(/handle @authQueryToken \{[\s\S]*reverse_proxy agent-inst-123-dashboard-sidecar:9090 \{[\s\S]*flush_interval -1/m);
    // Order constraint: @authQueryToken handler must precede the
    // catch-all `handle { respond 401 }`
    const handlerIdx = caddyfile.indexOf("handle @authQueryToken");
    // lastIndexOf: the catch-all is the FINAL `respond 401`. The /desktop route
    // adds an earlier @desktopUnauthed `respond 401`, so indexOf would wrongly
    // match that one.
    const catchAllIdx = caddyfile.lastIndexOf("respond 401");
    expect(handlerIdx).toBeGreaterThan(0);
    expect(catchAllIdx).toBeGreaterThan(handlerIdx);
  });

  it("emits the webui-free rich-chat routes when instanceId is provided (cutover)", () => {
    // HermesOS cutover: with an instanceId, the per-instance Caddyfile serves
    // the rich chat (webui-free) — / + /webchat file_server the tokenless
    // webchat_dist from the instance dir, /desktop is a token-gated proxy to
    // the official-dashboard backend, and /dash/api is rewritten onto the
    // proven /desktop gating. The webui routes still follow (Stage 1 leaves the
    // webui container running-idle), so first-match-wins claims / for the chat.
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz", {
      instanceId: "inst-xyz",
    });
    expect(caddyfile).toContain("root * /opt/hermes/instances/inst-xyz/webchat");
    expect(caddyfile).toContain("handle_path /webchat* {");
    expect(caddyfile).toMatch(/handle_path \/webchat\* \{[\s\S]*try_files \{path\} \/index\.html[\s\S]*file_server/m);
    expect(caddyfile).toMatch(/handle_path \/dash\* \{[\s\S]*try_files \{path\} \/index\.html[\s\S]*file_server/m);
    expect(caddyfile).toContain("@hermesRoot path /");
    expect(caddyfile).toContain("agent-inst-123-official-dashboard:9119");
    expect(caddyfile).toContain('header X-Hermes-Session-Token "secret-bearer-xyz"');
    expect(caddyfile).not.toContain("rewrite @dashApiRw /desktop");
    expect(caddyfile).toContain("handle /dash/api*");
    const dashApiBlock = caddyfile.slice(
      caddyfile.indexOf("handle /dash/api*"),
      caddyfile.indexOf("@dashPluginAssets"),
    );
    expect(dashApiBlock).toContain("uri strip_prefix /dash");
    // The sidecar owns the complete dashboard auth contract (cookie, bearer,
    // X-Hermes-Session-Token, and query token). A Caddy forward_auth check that
    // forwards only Cookie rejects the admin bundle's token-authenticated API
    // calls before they can reach that gate.
    expect(dashApiBlock).not.toContain("forward_auth");
    expect(dashApiBlock).not.toContain("uri /dashboard-session-check");
    // Keep the API behind the authenticated sidecar rather than exposing the
    // official-dashboard container directly.
    expect(dashApiBlock).toContain("reverse_proxy agent-inst-123-dashboard-sidecar:9090");
    expect(caddyfile).toContain("@dashPluginAssets path /dash/dashboard-plugins /dash/dashboard-plugins/*");
    expect(caddyfile).toContain("handle @dashPluginAssets");
    expect(caddyfile).toContain("uri strip_prefix /dash");
    expect(caddyfile.indexOf("handle @dashPluginAssets")).toBeLessThan(caddyfile.indexOf("handle_path /dash*"));
    // Rich-chat / must be claimed before the legacy webui @public route.
    expect(caddyfile.indexOf("@hermesRoot")).toBeLessThan(caddyfile.indexOf("@public path"));
  });

  it("keeps Hermes Desktop Web history routes on the webchat bundle while /dash remains the admin panel", () => {
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz", {
      instanceId: "inst-xyz",
    });

    // Hermes Desktop Web starts at /webchat, then its browser-history router
    // moves to top-level document paths such as /sessions and /chat. Those
    // navigations must keep serving the Desktop Web shell; sending them to the
    // official-dashboard SPA silently replaces Desktop Web with the admin app.
    expect(caddyfile).toContain("@hermesDesktopDocument {");
    expect(caddyfile).toContain(
      "not path /dash* /api* /_sidecar* /web-api* /browser-sidecar* /v1* /mcp* /acp* /desktop*",
    );
    expect(caddyfile).toMatch(
      /handle @hermesDesktopDocument \{[\s\S]*root \* \/opt\/hermes\/instances\/inst-xyz\/webchat[\s\S]*rewrite \* \/index\.html[\s\S]*file_server/m,
    );

    const desktopDocumentIdx = caddyfile.indexOf("handle @hermesDesktopDocument");
    const legacyPublicHtmlIdx = caddyfile.indexOf("handle @publicHtml");
    const adminIdx = caddyfile.indexOf("handle_path /dash*");
    expect(desktopDocumentIdx).toBeGreaterThan(adminIdx);
    expect(legacyPublicHtmlIdx).toBeGreaterThan(desktopDocumentIdx);
  });

  it("declares each /desktop named matcher exactly ONCE in webfree mode (no duplicate-matcher caddy validate failure)", () => {
    // Regression for the #104 webui-free cutover: the webfree block used to
    // re-declare @desktopHeaderToken/@desktopBearer/@desktopQueryToken/
    // @desktopUnauthed that the main site block already defines. Two
    // definitions of the same named matcher in one site block is a FATAL
    // `caddy validate` error ("named matcher already defined") — the whole
    // edge config refuses to load, so every webfree provision's Desktop
    // connection (and the rest of the site) breaks. .toContain() can't catch
    // this because one occurrence already satisfies it, so count definitions.
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz", {
      instanceId: "inst-xyz",
    });
    const defCount = (name: string, withBrace = true) =>
      (caddyfile.match(new RegExp(`^[ \\t]*@${name} ${withBrace ? "\\{" : "path"}`, "gm")) || []).length;
    expect(defCount("desktopHeaderToken")).toBe(1);
    expect(defCount("desktopBearer")).toBe(1);
    expect(defCount("desktopQueryToken")).toBe(1);
    expect(defCount("desktopUnauthed", false)).toBe(1);
  });

  it("omits the rich-chat block when no instanceId (back-compat for existing call sites)", () => {
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "secret-bearer-xyz");
    expect(caddyfile).not.toContain("@hermesRoot");
    expect(caddyfile).not.toContain("/opt/hermes/instances");
  });

  it("bootstrap extracts webchat_dist into the instance dir for the file_server", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
    expect(script).toContain("cp -a /opt/hermes/hermes_cli/webchat_dist/. /out/");
    // Extract runs against a STAGING dir, not the live surface, so a bundle-less
    // image can never blank the live /webchat (see the footgun-guard test below).
    expect(script).toContain('-v "$INSTANCE_DIR/.webchat.stage":/out');
    expect(script).toContain('mv "$INSTANCE_DIR/.webchat.stage" "$INSTANCE_DIR/webchat"');
  });

  it("bootstrap extracts the base=/dash dashboard bundle (web_dist_dash) for the Admin Panel /dash file_server", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
    // web_dist_dash is baked with --base=/dash/ in the agent image; the inner
    // caddy file_servers it at /dash for the Admin Panel nav item.
    expect(script).toContain("cp -a /opt/hermes/hermes_cli/web_dist_dash/. /out/");
    expect(script).toContain('-v "$INSTANCE_DIR/.dash.stage":/out');
    expect(script).toContain('mv "$INSTANCE_DIR/.dash.stage" "$INSTANCE_DIR/dash"');
  });

  it("re-extracts the static surfaces in UPDATE mode too (UI changes reach users on redeploy/roll)", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });
    // The whole point of the fix: image rolls must refresh the static dir, so
    // the extract must NOT be gated to fresh provisions.
    expect(script).toContain("cp -a /opt/hermes/hermes_cli/webchat_dist/. /out/");
    expect(script).toContain('mv "$INSTANCE_DIR/.webchat.stage" "$INSTANCE_DIR/webchat"');
  });

  it("never wipes a working static surface when the image lacks the bundle (CAUSE-4 blank-chat footgun guard)", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "provision" });
    // The old code did `rm -rf "$INSTANCE_DIR/webchat"` BEFORE a conditional copy,
    // so an image missing webchat_dist blanked the surface. The swap must be
    // guarded on the staging dir actually having content, and a miss must KEEP
    // the existing surface and warn loudly instead of wiping.
    expect(script).not.toContain('rm -rf "$INSTANCE_DIR/webchat" && mkdir');
    expect(script).toContain('if [ -n "$(ls -A "$INSTANCE_DIR/.webchat.stage" 2>/dev/null)" ]; then');
    expect(script).toContain(
      'WARN: image missing /opt/hermes/hermes_cli/webchat_dist; keeping existing webchat surface (not wiping)'
    );
  });

  it("emits a gateway supervisor heartbeat tick so gateway_state.json stays fresh under stalls", () => {
    // The cross-container WebUI considers the gateway "not responding" when
    // gateway_state.json's `updated_at` field is older than 120s. The gateway
    // process writes that field on platform events but does NOT periodically
    // heartbeat — so a stalled internal loop (cron ticker, kanban dispatcher)
    // silently lets the timestamp go stale and the user sees a red banner
    // even though the gateway HTTP API is still alive.
    //
    // The supervisor in the gateway compose service runs a 10s loop anyway.
    // A tiny helper now refreshes gateway_state.json's `updated_at` every
    // tick from the supervisor, independent of the gateway's own loops.
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    expect(compose).toContain("_heartbeat_state_files");
    // The call must fire inside the while-True loop, near the tail —
    // immediately before the final `time.sleep(10)` of each iteration.
    expect(compose).toMatch(/_heartbeat_state_files\(\)\n\s+time\.sleep\(10\)/);
    // The helper must rewrite gateway_state.json atomically.
    expect(compose).toContain('_state_path.with_suffix(".json.tmp")');
    expect(compose).toContain("_tmp.replace(_state_path)");
  });

  it("heartbeats each live named profile independently when the base state is orphaned", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });

    // Legacy profile switching can leave an orphaned base gateway_state while
    // the same container still has a real named-profile gateway. Each record
    // therefore needs its own strict PID + start-time + cmdline + HERMES_HOME
    // proof. An invalid base must not prevent a valid named state from being
    // refreshed, and the invalid base itself must remain stale/fail-closed.
    expect(compose).toContain("def _heartbeat_candidates():");
    expect(compose).toContain('if runtime_profile_name == "default":');
    expect(compose).toContain('for _candidate in sorted((base_home / "profiles").glob("*/gateway_state.json"))');
    expect(compose).toContain("def _live_gateway_identity(_record, _expected_home):");
    expect(compose).toContain('if _record.get("gateway_state") != "running":');
    expect(compose).toContain('if _record.get("kind") != "hermes-gateway":');
    expect(compose).toContain("_current_start = _process_start_time(_pid)");
    expect(compose).toContain("if _recorded_start is None or _current_start != _recorded_start:");
    expect(compose).toContain("if not _looks_like_gateway_runtime(_pid):");
    expect(compose).toContain('def _process_env_value(_pid, _key):');
    expect(compose).toContain('_process_home = _process_env_value(_pid, "HERMES_HOME")');
    expect(compose).toContain("if not _process_home:");
    expect(compose).toContain("if Path(_process_home).resolve(strict=False) != _expected_home.resolve(strict=False):");
    expect(compose).not.toContain('_record.get("hermes_home")');
    expect(compose).toContain("if _primary_identity is not None:");
    expect(compose).toContain("if _candidate_identity is None:");
    expect(compose).not.toContain("if _candidate_identity != primary_identity:");
    expect(compose).not.toContain("primary-gateway-identity-unverified\")\n                  return");
    expect(compose).toContain("[gateway-supervisor] heartbeat skipped profile=");
  });

  it("uses a named profile home while keeping the shared Kanban root writable for a dealer gateway", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });

    // A dedicated named-profile container overrides HERMES_HOME and
    // HERMES_PROFILE_NAME, but Kanban intentionally stays shared at the base
    // root so dispatcher/worker handoff is not forked per profile. Therefore
    // the whole webui-state mount must remain rw; a ro base + rw profile bind
    // still fails on /home/hermes/.hermes/kanban.db.init.lock with EROFS.
    expect(compose).toContain("- HERMES_PROFILE_NAME=default");
    expect(compose).toContain("- HERMES_KANBAN_HOME=/home/hermes/.hermes");
    expect(compose).toContain("- HERMES_WEBUI_AGENT_DIR=/home/hermes/.hermes/hermes-agent");
    expect(compose).toContain('BASE_HOME="$${HERMES_HOME:-/home/hermes/.hermes}"');
    expect(compose).not.toContain('BASE_HOME="/home/hermes/.hermes"');
    expect(compose).toContain('runtime_profile_name = os.environ.get("HERMES_PROFILE_NAME", "default").strip() or "default"');
    expect(compose).toContain('agent_dir = Path(os.environ["HERMES_WEBUI_AGENT_DIR"])');
    expect(compose).toContain("return [(runtime_profile_name, base_home)]");
    const gatewayBlock = compose.slice(
      compose.indexOf("  gateway:"),
      compose.indexOf("  official-dashboard:")
    );
    expect(gatewayBlock).toContain("- webui-state:/home/hermes/.hermes");
    expect(gatewayBlock).not.toContain("- webui-state:/home/hermes/.hermes:ro");
  });

  it("scrubs stale gateway platform status for unconfigured messaging integrations", () => {
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });

    expect(compose).toContain("PLATFORM_REQUIRED_ENV_KEYS");
    expect(compose).toContain('"telegram": ("TELEGRAM_BOT_TOKEN",)');
    expect(compose).toContain('"discord": ("DISCORD_BOT_TOKEN",)');
    expect(compose).toContain("CANARY_SHAPE_PROBE");
    expect(compose).toContain("[gateway-supervisor] scrubbed stale platform state");
    expect(compose).toMatch(/if str\(_platform or ""\)\.lower\(\) in PLATFORM_REQUIRED_ENV_KEYS and not platform_configured\(_platform, _env\):\n\s+_platforms\.pop\(_platform, None\)/);
  });

  it("routes official dashboard browser sessions through a signed handoff sidecar", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    expect(artifacts.composeYaml).toContain("official-dashboard:");
    expect(artifacts.composeYaml).toContain("image: ghcr.io/ashneil12/vanilla-hermes-agent:stable");
    expect(artifacts.composeYaml).toContain("container_name: agent-inst-123-official-dashboard");
    expect(artifacts.composeYaml).toContain('entrypoint: ["/bin/sh", "-c"]');
    expect(artifacts.composeYaml).toContain("- HERMES_DASHBOARD_TUI=1");
    expect(artifacts.composeYaml).toContain('- "9119"');
    expect(artifacts.composeYaml).toContain(
      "exec /opt/hermes/.venv/bin/hermes dashboard --host 0.0.0.0 --port 9119 --no-open --insecure"
    );
    expect(artifacts.composeYaml).toContain("- GATEWAY_HEALTH_URL=http://agent-inst-123-gateway:8642");
    const officialDashboardBlock = artifacts.composeYaml.slice(
      artifacts.composeYaml.indexOf("  official-dashboard:"),
      artifacts.composeYaml.indexOf("  # Browser handoff sidecar")
    );
    // The official-dashboard IS pinned to uid 1024 (same as the gateway). It
    // shares the webui-state volume (/home/hermes/.hermes) rw, and its
    // cron-management UI writes ~/.hermes/cron/jobs.json. Running as the
    // image-default root left that file root-owned + mode 600, unreadable by
    // the uid-1024 gateway, which then crash-logged "IOError reading jobs.json:
    // [Errno 13] Permission denied" every cron tick and re-fired a job, double-
    // delivering to the end user (incident 2026-06-12, inst fixturecase21). #256's
    // deploy-time pre-chown only homed the runtime *dirs* to 1024 — it could
    // not stop root minting root-owned *files* inside them mid-session. Pinning
    // the writer to 1024 closes the class. Verified live: `hermes dashboard`
    // boots clean and serves /api/status as uid 1024 (canary fixturecase17).
    expect(officialDashboardBlock).toContain('user: "1024:1024"');
    expect(officialDashboardBlock).not.toContain("init: true");

    // The dashboard-sidecar must stay root (apk add docker-cli + the root-owned
    // docker.sock), so it can't be pinned. It also mounts webui-state rw, so it
    // heals ownership back to 1024 on every boot — which also repairs any box
    // that already has root-owned cron/.env/profile files from the pre-fix
    // dashboard when it redeploys onto this compose.
    expect(artifacts.composeYaml).toContain(
      "chown -R 1024:1024 /home/hermes/.hermes 2>/dev/null || true"
    );

    expect(artifacts.sidecarServerFile).toContain("requestUrl.pathname === '/dashboard-login'");
    expect(artifacts.composeYaml).toContain("dashboard-sidecar:");
    expect(artifacts.composeYaml).toContain("image: node:22-alpine");
    expect(artifacts.composeYaml).toContain("container_name: agent-inst-123-dashboard-sidecar");
    expect(artifacts.composeYaml).toContain("- DASHBOARD_UPSTREAM_URL=http://agent-inst-123-official-dashboard:9119");
    expect(artifacts.composeYaml).toContain("- WEBUI_TERMINAL_UPSTREAM_URL=http://agent-inst-123-official-dashboard:9119");
    expect(artifacts.composeYaml).toContain("- ./sidecar_server.js:/opt/data/server.js:ro");
    expect(artifacts.composeYaml).toContain('      - "9090"');

    expect(artifacts.caddyfile).toContain("handle_path /_sidecar*");
    expect(artifacts.caddyfile).toContain("reverse_proxy agent-inst-123-dashboard-sidecar:9090");
    expect(artifacts.caddyfile).toContain("forward_auth agent-inst-123-dashboard-sidecar:9090");
    expect(artifacts.caddyfile).toContain("uri /dashboard-session-check");
    expect(artifacts.caddyfile).toContain("hermes_dashboard_session");
    expect(artifacts.caddyfile).toContain(
      "header Cookie *hermes_dashboard_session=*",
    );
    expect(artifacts.caddyfile).toContain(
      "header Cookie *hermes_webui_session=*",
    );
    expect(artifacts.caddyfile).not.toContain(
      'header_regexp Cookie "(^|;\\\\s*)hermes_dashboard_session="',
    );

    const dashboardBrowserBlock = artifacts.caddyfile.slice(
      artifacts.caddyfile.indexOf("  handle @dashboard_browser"),
      artifacts.caddyfile.indexOf("  handle @webui_browser")
    );
    expect(dashboardBrowserBlock).toContain(
      "header_up Cookie {http.request.header.Cookie}",
    );
    expect(dashboardBrowserBlock).toContain("reverse_proxy agent-inst-123-dashboard-sidecar:9090");
    // @dashboard_browser goes to the signed-handoff sidecar, NOT the dashboard
    // backend directly (the adjacent @webui_browser is what proxies the backend).
    expect(dashboardBrowserBlock).not.toContain("reverse_proxy agent-inst-123-official-dashboard:9119");
  });

  it("routes generated Hermes cache image paths through the sidecar before browser-session handlers", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    expect(artifacts.caddyfile).toContain(
      "@generatedImagePath path /home/hermes/.hermes/cache/images/*",
    );
    expect(artifacts.caddyfile).toContain(
      "@generatedProfileImagePath path_regexp generated_profile_image ^/home/hermes/\\.hermes/profiles/[A-Za-z0-9_-]+/cache/images/.+$",
    );
    expect(artifacts.caddyfile).toMatch(
      /handle @generatedImagePath \{[\s\S]*reverse_proxy agent-inst-123-dashboard-sidecar:9090/m,
    );
    expect(artifacts.caddyfile).toMatch(
      /handle @generatedProfileImagePath \{[\s\S]*reverse_proxy agent-inst-123-dashboard-sidecar:9090/m,
    );

    const generatedImageHandleIdx = artifacts.caddyfile.indexOf("handle @generatedImagePath");
    const generatedProfileImageHandleIdx = artifacts.caddyfile.indexOf("handle @generatedProfileImagePath");
    const dashboardBrowserHandleIdx = artifacts.caddyfile.indexOf("handle @dashboard_browser");
    const webuiBrowserHandleIdx = artifacts.caddyfile.indexOf("handle @webui_browser");
    expect(generatedImageHandleIdx).toBeGreaterThan(0);
    expect(generatedProfileImageHandleIdx).toBeGreaterThan(generatedImageHandleIdx);
    expect(generatedImageHandleIdx).toBeLessThan(dashboardBrowserHandleIdx);
    expect(generatedImageHandleIdx).toBeLessThan(webuiBrowserHandleIdx);
    expect(generatedProfileImageHandleIdx).toBeLessThan(dashboardBrowserHandleIdx);
    expect(generatedProfileImageHandleIdx).toBeLessThan(webuiBrowserHandleIdx);
  });

  it("serves generated image cache files from the sidecar with auth and path containment checks", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    expect(artifacts.sidecarServerFile).toContain("function handleGeneratedImageRequest(req, res, requestUrl, rawBody)");
    expect(artifacts.sidecarServerFile).toContain("function resolveGeneratedImagePath(pathname)");
    expect(artifacts.sidecarServerFile).toContain("getDashboardSession(req)");
    expect(artifacts.sidecarServerFile).toContain("typeof getWebuiSession === 'function'");
    expect(artifacts.sidecarServerFile).toContain("path.relative(DEFAULT_IMAGE_CACHE_ROOT, resolvedPath)");
    expect(artifacts.sidecarServerFile).toContain("path.relative(HOST_PROFILES_DIR, resolvedPath)");
    expect(artifacts.sidecarServerFile).toContain("failureType: 'sidecar_generated_image_missing'");
    expect(artifacts.sidecarServerFile).toContain("failureType: 'sidecar_generated_image_stream_failed'");
  });

  it("scales the official-dashboard container limits with the VM tier (not hardcoded free-tier)", () => {
    const dashboardBlock = (yaml: string) =>
      yaml.slice(
        yaml.indexOf("  official-dashboard:"),
        yaml.indexOf("  dashboard-sidecar:")
      );

    const paid = buildWebUIProvisioningArtifacts({ ...baseParams, cpuLimit: 4, ramLimit: 8192 });
    expect(dashboardBlock(paid.composeYaml)).toContain('cpus: "4"');
    expect(dashboardBlock(paid.composeYaml)).toContain("memory: 8192M");

    const free = buildWebUIProvisioningArtifacts({ ...baseParams, cpuLimit: 1, ramLimit: 1024 });
    expect(dashboardBlock(free.composeYaml)).toContain('cpus: "1"');
    expect(dashboardBlock(free.composeYaml)).toContain("memory: 1024M");
  });

  it("preserves upstream official dashboard cookies while stripping only the Hermes auth cookie", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    expect(artifacts.sidecarServerFile).toContain("function filterDashboardProxyCookieHeader(cookieHeader)");
    expect(artifacts.sidecarServerFile).toContain("const filteredCookie = filterDashboardProxyCookieHeader(req.headers.cookie);");
    expect(artifacts.sidecarServerFile).toContain("headers.cookie = filteredCookie;");
    expect(artifacts.sidecarServerFile).toContain("strippedDashboardSessionCookie");
  });

  it("routes the WebUI iframe cookie via forward_auth then proxies through the sidecar (gated-image auth bridge)", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    // Matcher and handle block both present
    expect(artifacts.caddyfile).toContain("@webui_browser {");
    expect(artifacts.caddyfile).toContain("hermes_webui_session=");
    expect(artifacts.caddyfile).toContain("handle @webui_browser {");

    // forward_auth points at the SAME sidecar that does dashboard-login,
    // but the path is /webui-session-check (NOT dashboard-session-check).
    const webuiBrowserBlock = artifacts.caddyfile.slice(
      artifacts.caddyfile.indexOf("  handle @webui_browser"),
      artifacts.caddyfile.indexOf("handle @authBearer")
    );
    expect(webuiBrowserBlock).toContain("forward_auth agent-inst-123-dashboard-sidecar:9090");
    expect(webuiBrowserBlock).toContain("uri /webui-session-check");

    // After the cookie check passes, the request is proxied THROUGH the sidecar
    // (not the dashboard directly): the June-2026 hardening gates the dashboard,
    // so the sidecar attaches a real gated session cookie before forwarding.
    expect(webuiBrowserBlock).toContain("reverse_proxy agent-inst-123-dashboard-sidecar:9090");
    expect(webuiBrowserBlock).not.toContain("reverse_proxy agent-inst-123-official-dashboard:9119");

    // Order constraint: @webui_browser is matched before @authBearer so
    // cookie-authenticated traffic doesn't fall through to bearer-auth.
    const webuiIdx = artifacts.caddyfile.indexOf("@webui_browser {");
    const bearerIdx = artifacts.caddyfile.indexOf("@authBearer header Authorization");
    expect(webuiIdx).toBeGreaterThan(0);
    expect(bearerIdx).toBeGreaterThan(0);
    expect(webuiIdx).toBeLessThan(bearerIdx);
  });

  it("strips webui's restrictive X-Frame-Options and adds an exact-origin frame-ancestors CSP", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    // Strip the default DENY/SAMEORIGIN webui Python may emit.
    expect(artifacts.caddyfile).toContain("-X-Frame-Options");

    // Allowlist EXACT dashboard origins — no wildcard. Wildcards would let
    // any subdomain frame a customer's webui.
    expect(artifacts.caddyfile).toContain(
      `Content-Security-Policy "frame-ancestors 'self' https://hermesos.cloud https://dashboard.hermesos.cloud https://canary.hermesos.cloud https://hivra.cloud https://www.hivra.cloud"`,
    );
    expect(artifacts.caddyfile).not.toContain("frame-ancestors 'self' https://*.hermesos.cloud");
  });

  it("injects HERMES_WEBUI_FRAME_POLICY=ALLOWALL into the webui compose env (forward-compatible w/ fork patch)", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    // artifacts.envFile is the docker-compose.env contents for the webui service.
    expect(artifacts.envFile).toContain("HERMES_WEBUI_FRAME_POLICY=ALLOWALL");
  });

  it("exposes the gateway api_server on 0.0.0.0 with the bearer key so webui can reach it", () => {
    // gateway_state.json on every fresh proxmox deploy used to show:
    //   api_server: { state: "retrying", error_message: "failed to reconnect" }
    // forever — because (a) the api_server platform binds 127.0.0.1 by
    // default (unreachable from the sibling webui container) and (b) it
    // silently skips starting without API_SERVER_KEY. This test guards
    // both pieces of the fix on the gateway service env.
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    const gatewayBlock = compose.slice(
      compose.indexOf("  gateway:"),
      compose.indexOf("  # Chat-durability sidecar"),
    );
    expect(gatewayBlock).toContain("- API_SERVER_HOST=0.0.0.0");
    expect(gatewayBlock).toContain("- API_SERVER_PORT=8642");
    expect(gatewayBlock).toContain(`- API_SERVER_KEY=${baseParams.webuiPassword}`);
  });

  it("includes /usr/local/sbin:/usr/sbin:/sbin on the runtime PATH so groupmod resolves during init", () => {
    // The legacy WebUI image init script runs `groupmod` to align the
    // container user with the mounted state volume's UID. groupmod lives at
    // /usr/sbin/groupmod on Debian. If the runtime PATH is missing the sbin
    // entries, init dies with "groupmod: command not found" and webui
    // crash-loops on every fresh deploy. This regression test guards the
    // canary 407 hotfix that is now baked into WEBUI_RUNTIME_PATH.
    const compose = buildWebUICompose({
      ...baseParams,
      image: "ghcr.io/ashneil12/hermes-webui:stable",
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    // Substring-search the rendered PATH= lines for the sbin entries; the
    // exact ordering follows expectedWebUIPath above.
    expect(compose).toContain("/bin:/usr/local/sbin:/usr/sbin:/sbin:");
    // The agent-side .env file (lives inside the webui-state volume, not the
    // compose env_file) must also carry the sbin entries so any hermes-agent
    // subprocess sees them too.
    const hermesEnv = buildHermesEnvFile(baseParams);
    expect(hermesEnv).toContain("/bin:/usr/local/sbin:/usr/sbin:/sbin:");
  });

  describe("agent name passthrough -> HERMES_WEBUI_BOT_NAME", () => {
    it("emits HERMES_WEBUI_BOT_NAME when agentName is provided", () => {
      const artifacts = buildWebUIProvisioningArtifacts({
        ...baseParams,
        agentName: "Atlas",
      });
      expect(artifacts.envFile).toContain("HERMES_WEBUI_BOT_NAME=Atlas");
    });

    it("trims whitespace before writing to the env file", () => {
      const artifacts = buildWebUIProvisioningArtifacts({
        ...baseParams,
        agentName: "  Atlas  ",
      });
      expect(artifacts.envFile).toContain("HERMES_WEBUI_BOT_NAME=Atlas");
      expect(artifacts.envFile).not.toContain("HERMES_WEBUI_BOT_NAME=  Atlas  ");
    });

    it("omits the env var entirely when agentName is null / undefined / empty", () => {
      const missing = buildWebUIProvisioningArtifacts(baseParams);
      expect(missing.envFile).not.toContain("HERMES_WEBUI_BOT_NAME");

      const nullValue = buildWebUIProvisioningArtifacts({ ...baseParams, agentName: null });
      expect(nullValue.envFile).not.toContain("HERMES_WEBUI_BOT_NAME");

      const emptyString = buildWebUIProvisioningArtifacts({ ...baseParams, agentName: "" });
      expect(emptyString.envFile).not.toContain("HERMES_WEBUI_BOT_NAME");

      const whitespaceOnly = buildWebUIProvisioningArtifacts({ ...baseParams, agentName: "   " });
      expect(whitespaceOnly.envFile).not.toContain("HERMES_WEBUI_BOT_NAME");
    });

    it("seeds HERMES_BROWSER_SIDECAR_AUTH_TOKEN into hermes.env using the same per-instance secret as SIDECAR_AUTH_TOKEN", () => {
      // The agent container's browser_sidecar.py reads this env var to
      // build the Authorization: Bearer header. The sidecar's
      // SIDECAR_AUTH_TOKEN (in compose env, only present when the
      // sidecar is enabled) must match so the bearer verifies. Same
      // source value (webuiPassword) keeps a redeploy rotation in
      // lockstep — set one without the other and the agent's tool
      // calls 401 until the next compose write.
      const params: WebUIDeployParams = { ...baseParams, browserSidecarEnabled: true };
      const artifacts = buildWebUIProvisioningArtifacts(params);
      expect(artifacts.hermesEnvFile).toContain(
        `HERMES_BROWSER_SIDECAR_AUTH_TOKEN=${params.webuiPassword}`
      );
      expect(artifacts.envFile).toContain(
        `HERMES_BROWSER_SIDECAR_AUTH_TOKEN=${params.webuiPassword}`
      );
      expect(artifacts.composeYaml).toContain(`SIDECAR_AUTH_TOKEN=${params.webuiPassword}`);
    });

    it("refuses to build a bootstrap script when an env-file body contains the heredoc terminator", () => {
      const malicious: WebUIDeployParams = {
        ...baseParams,
        // If a name (or any user-controlled string) ever bypassed input
        // validation, the heredoc helper must fail loud rather than splice
        // attacker bytes into a bash heredoc that runs as root on the VM.
        agentName: "ok\n__HERMES_EOF__\nrm -rf /\n",
      };
      const artifacts = buildWebUIProvisioningArtifacts(malicious);
      expect(() => buildWebUIBootstrapScript(artifacts, malicious)).toThrow(
        /heredoc body for ".*" contains the EOF terminator/
      );
    });
  });

  it("gives the dashboard-sidecar a docker CLI and socket so it can run terminal/OAuth flows", () => {
    // The sidecar shells out to `docker exec` for terminal sessions, Nous
    // Portal OAuth, and profile flows (sidecar-script.ts). node:22-alpine has
    // no docker CLI, so without an apk install + socket mount the sidecar
    // dies with "/bin/sh: docker: not found" (exit 127). Mirrors what the
    // Hetzner sidecar in hetzner-instance-builders.ts already does.
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const dashboardSidecarBlock = artifacts.composeYaml.slice(
      artifacts.composeYaml.indexOf("  dashboard-sidecar:")
    );

    expect(dashboardSidecarBlock).toContain("apk add --no-cache docker-cli");
    expect(dashboardSidecarBlock).toContain("node /opt/data/server.js");
    expect(dashboardSidecarBlock).toContain("- /var/run/docker.sock:/var/run/docker.sock");
  });

  it("installs the native PTY Python runtime before starting a fresh dashboard-sidecar", () => {
    const compose = buildWebUIProvisioningArtifacts(baseParams).composeYaml;
    const service = compose.slice(compose.indexOf("  dashboard-sidecar:"));
    const command = service.match(/command: >\s+sh -c "([\s\S]*?)"\s+environment:/)?.[1];
    expect(command).toBeDefined();
    // Run the emitted bootstrap order with dependency stubs: no packages,
    // ownership changes, Docker daemon or network are touched by this test.
    const result = spawnSync("/bin/sh", ["-c", [
      "chown() { :; }",
      'apk() { for package in "$@"; do [ "$package" != python3 ] || NATIVE_PYTHON_READY=1; done; return 0; }',
      'node() { [ "$NATIVE_PYTHON_READY" = 1 ] || return 127; printf "NATIVE_PTY_RUNTIME_READY\\n"; }',
      command!,
    ].join("\n")], {
      encoding: "utf8", timeout: 3000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("NATIVE_PTY_RUNTIME_READY");
  });

  it("uses a healthcheck binary that exists in the official dashboard image", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const officialDashboardBlock = artifacts.composeYaml.slice(
      artifacts.composeYaml.indexOf("  official-dashboard:"),
      artifacts.composeYaml.indexOf("  # Browser handoff sidecar")
    );

    expect(officialDashboardBlock).toContain('test: ["CMD", "curl", "-fsS", "--max-time", "3", "http://127.0.0.1:9119/api/status"]');
    expect(officialDashboardBlock).not.toContain('"python"');
    expect(officialDashboardBlock).not.toContain("urllib.request");
  });

  it("enables the gateway health API so the official dashboard can show live gateway state", () => {
    const hermesEnv = buildHermesEnvFile(baseParams);

    expect(hermesEnv).toContain("API_SERVER_ENABLED=true");
    expect(hermesEnv).toContain("API_SERVER_HOST=0.0.0.0");
    expect(hermesEnv).toContain("API_SERVER_PORT=8642");
    expect(hermesEnv).toContain("API_SERVER_KEY=webui-password");
  });

  it("marks WebUI profiles active when integrations are configured through the sidecar", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    expect(artifacts.composeYaml).toContain("- HOST_PROFILES_DIR=/home/hermes/.hermes/profiles");
    expect(artifacts.composeYaml).toContain("- MAIN_ENV_FILE=/home/hermes/.hermes/.env");
    expect(artifacts.composeYaml).toContain("- webui-state:/home/hermes/.hermes");
    expect(artifacts.sidecarServerFile).toContain("function markGatewayProfileActive(profile)");
    expect(artifacts.sidecarServerFile).toContain("gateway-profiles.d");
    expect(artifacts.sidecarServerFile).toContain("makeWebUIWritable(markerPath, 0o600)");
    expect(artifacts.sidecarServerFile).toContain("markGatewayProfileActive(profile)");
  });

  it("runs the messaging gateway as a supervised sibling service", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    expect(artifacts.composeYaml).toContain("  gateway:");
    expect(artifacts.composeYaml).toContain("container_name: agent-inst-123-gateway");
    expect(artifacts.composeYaml).toContain("restart: unless-stopped");
    expect(artifacts.composeYaml).toContain("user: \"1024:1024\"");
    expect(artifacts.composeYaml).toContain("HERMES_HOME=/home/hermes/.hermes");
    // Regression: the uid-1024 gateway must pin HOME explicitly (no passwd
    // entry → HOME defaults to "/"), or the per-platform startup lock
    // (~/.local/state → /.local) PermissionErrors and Telegram/Signal/etc
    // crash-loop. Slice the gateway service block so the assertion can't be
    // satisfied by the official-dashboard service's own HOME pin.
    const gatewayBlock = artifacts.composeYaml.slice(
      artifacts.composeYaml.indexOf("  gateway:"),
      artifacts.composeYaml.indexOf("  official-dashboard:")
    );
    expect(gatewayBlock).toContain("- HOME=/home/hermes");
    expect(artifacts.composeYaml).toContain("active_dir = base_home / \"gateway-profiles.d\"");
    expect(artifacts.composeYaml).toContain("seed_active_markers_from_existing_env()");
    expect(artifacts.composeYaml).toContain("if marker.exists():");
    // Single-profile-per-container: active_profiles() returns only the profile
    // configured for this container, so no two profiles race for one API port.
    expect(artifacts.composeYaml).toContain("return [(runtime_profile_name, base_home)]");
    expect(artifacts.composeYaml).not.toContain('active_dir.glob("*.active")');
    expect(artifacts.composeYaml).toContain("status = subprocess.run(status_cmd, cwd=agent_dir, env=env");
    expect(artifacts.composeYaml).toContain("subprocess.Popen(run_cmd");
    expect(artifacts.composeYaml).toContain("[gateway-supervisor] started gateway profile=");
    expect(artifacts.composeYaml).toContain("[gateway-supervisor] no active gateway profiles yet");
    // Regression: the supervisor restarts a running gateway when its profile
    // .env changes (a messaging credential added/removed from WebUI/dashboard)
    // so new creds take effect without WebUI needing docker access.
    expect(artifacts.composeYaml).toContain("env_sigs");
    expect(artifacts.composeYaml).toContain("[gateway-supervisor] .env changed for profile=");
    // Regression: the gateway command is launched as a new process session.
    // Shutdown/restart must signal the whole process group, otherwise the
    // Python wrapper can exit while an inner gateway process keeps a Discord
    // token/session alive and the replacement gateway reports "token already
    // in use".
    expect(artifacts.composeYaml).toContain("def stop_gateway_child(profile_name, child, reason):");
    expect(artifacts.composeYaml).toContain("os.killpg(child.pid, signal.SIGTERM)");
    expect(artifacts.composeYaml).toContain("os.killpg(child.pid, signal.SIGKILL)");
    expect(artifacts.composeYaml).toContain('stop_gateway_child(profile_name, child, "env_changed")');
    expect(artifacts.composeYaml).toContain('stop_gateway_child(profile_name, child, "supervisor_shutdown")');
    expect(artifacts.composeYaml).toContain("[gateway-supervisor] stopping gateway profile=");
    // Regression: a supervisor-initiated restart/stop is a PLANNED stop, not a
    // crash. The supervisor drops a planned-stop marker naming the gateway PID
    // BEFORE SIGTERM so the gateway exits 0 cleanly (graceful Signal SSE /
    // platform teardown) instead of exit 1 with the misleading "systemd
    // Restart=on-failure can revive the gateway" log — there is no systemd in
    // this container; the supervisor loop itself is the reviver.
    expect(artifacts.composeYaml).toContain("def mark_gateway_planned_stop(profile_home):");
    expect(artifacts.composeYaml).toContain('".gateway-planned-stop.json"');
    // Marker must be written before the SIGTERM in BOTH the env-change restart
    // and the supervisor-shutdown paths.
    const envIdx = artifacts.composeYaml.indexOf("mark_gateway_planned_stop(profile_home)");
    const envStopIdx = artifacts.composeYaml.indexOf(
      'stop_gateway_child(profile_name, child, "env_changed")',
    );
    expect(envIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeLessThan(envStopIdx);
    expect(artifacts.composeYaml).toContain("mark_gateway_planned_stop(home)");
    // Regression: the default/base profile is the ONLY profile that runs a
    // gateway (api_server + cron scheduler + kanban). Running a full gateway per
    // sub-profile raced for the singleton api_server port 8642 and wedged the
    // dashboard during disposable verification; sub-profile data is preserved and
    // reached via the api_server profile switcher. The default marker is still
    // always seeded so the gateway starts even with no messaging configured.
    expect(artifacts.composeYaml).toContain('marker = active_dir / (runtime_profile_name + ".active")');
    expect(artifacts.composeYaml).not.toContain("for profile_dir in sorted");
    expect(artifacts.composeYaml).toContain("- webui-state:/home/hermes/.hermes");
    expect(artifacts.composeYaml).toContain("- agent-source:/home/hermes/.hermes/hermes-agent");
  });

  it("escapes gateway shell variables so Docker Compose does not blank them before startup", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    expect(artifacts.composeYaml).toContain('export HERMES_HOME="$$BASE_HOME"');
    expect(artifacts.composeYaml).toContain('export PATH="$$BASE_HOME/bin:$$PATH"');
    expect(artifacts.composeYaml).toContain('mkdir -p "$$BASE_HOME/gateway-profiles.d" "$$BASE_HOME/logs"');
    expect(artifacts.composeYaml).not.toContain('export HERMES_HOME="$BASE_HOME"');
    expect(artifacts.composeYaml).not.toContain('export PATH="$BASE_HOME/bin:$PATH"');
    expect(artifacts.composeYaml).not.toContain('mkdir -p "$BASE_HOME/gateway-profiles.d" "$BASE_HOME/logs"');
  });

  it("checks the gateway API server, not just the supervisor PID", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);

    const gatewayBlock = artifacts.composeYaml.slice(
      artifacts.composeYaml.indexOf("  gateway:"),
      artifacts.composeYaml.indexOf("  # NOTE: The legacy chat-durability sidecar service")
    );

    expect(gatewayBlock).toContain("healthcheck:");
    expect(gatewayBlock).toContain("gateway-api-health");
    expect(gatewayBlock).toContain("http://127.0.0.1:8642/health");
    expect(gatewayBlock).toContain("test:\n        - CMD\n        - python\n        - -c");
    expect(gatewayBlock).toContain("retries: 30");
    expect(gatewayBlock).toContain("start_period: 120s");
    expect(gatewayBlock).not.toContain("gateway-supervisor-health");
    expect(gatewayBlock).not.toContain("/proc/1/cmdline");
    expect(gatewayBlock).not.toContain(`urllib.request.urlopen('http://127.0.0.1:8787/health'`);
  });

  it("excludes SSE chat-stream paths from gzip/zstd compression while keeping it on for everything else", () => {
    // Regression: gzip on SSE responses defeats reverse_proxy's
    // flush_interval -1 — Caddy's encoder buffers chunks for compression
    // efficiency, so chat tokens accumulate instead of streaming. The
    // outer Proxmox host Caddy fixed this in commit 1d66dd4f by removing
    // 'encode gzip' entirely (it only proxies chat traffic). The inner
    // Caddy serves the whole agent surface (UI bundle, JSON API, SSE),
    // so we keep compression on but exclude SSE paths via a request
    // matcher. If this regresses, chat responses arrive as a single
    // block at end-of-stream, looking like the /v1/responses endpoint
    // dumped the whole answer at once.
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc");

    // Compression directive must use the @notSseStream matcher. Bare
    // `encode zstd gzip` (site-wide compression) is what we're guarding
    // against — that's the regression.
    expect(caddyfile).toContain("encode @notSseStream zstd gzip");
    expect(caddyfile).not.toMatch(/^\s*encode\s+(zstd|gzip)\s+(zstd|gzip)\s*$/m);

    // Matcher must enumerate both the canonical AND legacy plural SSE
    // paths so legacy clients still bypass the encoder before the
    // rewrite directive folds them onto the canonical path. (The rewrite
    // happens later in the request lifecycle; encode's matcher reads
    // the as-received path.)
    expect(caddyfile).toContain("@sseStream path /api/chat/stream* /api/chats/stream*");
    expect(caddyfile).toContain("@notSseStream not path /api/chat/stream* /api/chats/stream*");
  });

  it("no longer emits the legacy chat-jobs sidecar block (module removed from fork)", () => {
    // The Python `sidecar` module was dropped from the WebUI fork, so the
    // builder must not emit the `@chatJobsBearer` route or the sidecar
    // container. Requests to /api/chat-jobs/* now 404 through the WebUI
    // @authBearer handler instead of 502'ing into a crashlooping container.
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc");

    expect(caddyfile).not.toContain("@chatJobsBearer");
    expect(caddyfile).not.toContain("agent-inst-123-sidecar:8788");
    expect(caddyfile).not.toContain("agent-inst-123-sidecar:");
  });

  it("keeps legacy plural chat API clients working through Caddy rewrites", () => {
    const caddyfile = buildWebUICaddyfile("agent.example.com", "agent-inst-123", "test-token-abc");

    expect(caddyfile).toContain("@legacyChatStart path /api/chats/start");
    expect(caddyfile).toContain("rewrite @legacyChatStart /api/chat/start");
    expect(caddyfile).toContain("@legacyChatStream path /api/chats/stream");
    expect(caddyfile).toContain("rewrite @legacyChatStream /api/chat/stream");
    expect(caddyfile).toContain("@legacyChatStreamStatus path /api/chats/stream/status");
    expect(caddyfile).toContain("rewrite @legacyChatStreamStatus /api/chat/stream/status");
    expect(caddyfile).toContain("@legacyChatCancel path /api/chats/cancel");
    expect(caddyfile).toContain("rewrite @legacyChatCancel /api/chat/cancel");
    expect(caddyfile).toContain("@legacyChatSteer path /api/chats/steer");
    expect(caddyfile).toContain("rewrite @legacyChatSteer /api/chat/steer");
  });

  it("seeds agent source, reloads host caddy, and checks health inside the container", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams);

    // Provision mode keeps the inspect-skip guard so baked Proxmox templates
    // cold-start without re-resolving the per-platform manifest digest.
    expect(script).toContain(
      "docker image inspect ghcr.io/ashneil12/vanilla-hermes-agent:stable >/dev/null 2>&1 || docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable"
    );
    expect(script).toContain(
      "docker image inspect ghcr.io/ashneil12/hermes-webui:stable >/dev/null 2>&1 || docker compose pull"
    );
    expect(script).not.toContain("docker image inspect undefined");
    expect(script).toContain("-v agent-inst-123_agent-source:/target");
    expect(script).toContain("cp -a /opt/hermes/. /target/");
    expect(script).toContain('find /target/.venv -type f \\( -path "*/bin/*"');
    expect(script).toContain(
      "s|/opt/hermes|/home/hermes/.hermes/hermes-agent|g"
    );
    expect(script).toContain("Install durable Hermes CLI shims in the persisted WebUI PATH");
    expect(script).toContain("Install durable Python package-manager shims");
    expect(script).toContain("-v agent-inst-123_webui-state:/state");
    expect(script).toContain("ln -sfn \"$target\" /state/bin/hermes");
    expect(script).toContain("ln -sfn \"$target\" /state/bin/hermes-cli");
    expect(script).toContain("cat > /state/bin/pip");
    expect(script).toContain("ln -sfn pip /state/bin/pip3");
    expect(script).toContain("cat > /state/pip.conf");
    expect(script).toContain("export HOME=/home/hermes");
    expect(script).toContain('export HERMES_HOME="/home/hermes/.hermes"');
    expect(script).toContain('mkdir -p "$HOME/.local/bin"');
    expect(script).toContain('target="/home/hermes/.hermes/hermes-agent/.venv/bin/hermes"');
    expect(script).toContain('target="/home/hermes/.hermes/hermes-agent/hermes"');
    expect(script).toContain('ln -sfn "$target" "$HOME/.local/bin/hermes"');
    expect(script).toContain('ln -sfn "$target" "$HOME/.local/bin/hermes-cli"');
    expect(script).toContain("docker compose up -d --remove-orphans");
    expect(script).not.toContain("docker compose up -d --remove-orphans --force-recreate");
    expect(script).not.toContain("docker image prune");
    expect(script).toContain("cat > sidecar_server.js");
    expect(script).toContain("no /opt/hermes compose file present; skipping reload");
    expect(script).toContain("no caddy service in /opt/hermes compose; skipping reload");
    expect(script).toContain("docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile");
    expect(script).toContain("docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile");
    expect(script).toContain("docker exec agent-inst-123 python");
    expect(script.lastIndexOf("Install durable Hermes CLI shims in the persisted WebUI PATH")).toBeGreaterThan(
      script.indexOf('urllib.request.urlopen("http://127.0.0.1:8787/health"')
    );
    expect(script).toContain("docker exec --user 1024 agent-inst-123 sh -lc 'export HOME=/home/hermes; export HERMES_HOME=\"/home/hermes/.hermes\"; test -x \"$(command -v hermes)\" && test -x \"$(command -v hermes-cli)\"'");
    expect(script).toContain("[webui-python-durability-check]");
    expect(script).toContain("python -m site --user-base");
    expect(script).toContain("command -v pip");
  });

  it("installs a VM-local agent-runtime watchdog that resolves the live webfree topology and repairs without touching user sessions", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams);

    expect(script).toContain("cat > /usr/local/bin/hermes-webui-watchdog-inst-123 <<'__HERMES_WEBUI_WATCHDOG__'");
    expect(script).toContain("/usr/local/bin/hermes-webui-watchdog-inst-123");
    expect(script).toContain("/etc/systemd/system/hermes-webui-watchdog-inst-123.service");
    expect(script).toContain("/etc/systemd/system/hermes-webui-watchdog-inst-123.timer");
    expect(script).toContain("__HERMES_WEBUI_WATCHDOG_SERVICE__");
    expect(script).toContain("__HERMES_WEBUI_WATCHDOG_TIMER__");
    expect(script).toContain("OnUnitActiveSec=2min");

    // Isolate the baked watchdog body so topology assertions don't pick up the
    // bootstrap loop's own (legacy) bare-container probes that live later in the
    // same script.
    const open = "<<'__HERMES_WEBUI_WATCHDOG__'\n";
    const start = script.indexOf(open) + open.length;
    const watchdog = script.slice(start, script.indexOf("\n__HERMES_WEBUI_WATCHDOG__\n", start));

    expect(watchdog).toContain(
      'log "detected unhealthy agent runtime (container=$CONTAINER service=$SERVICE); repairing persistent state"'
    );
    expect(watchdog).toContain("/usr/local/bin/hermes-memory-guard");
    expect(watchdog).toContain("systemctl start hermes-memory-guard.service");
    expect(watchdog).toContain(
      "status={{.State.Status}} running={{.State.Running}} restarting={{.State.Restarting}} exit={{.State.ExitCode}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"
    );
    expect(watchdog).toContain('docker logs --tail=120 "$CONTAINER" 2>/dev/null || true');
    expect(watchdog).toContain("Repair WebUI persistent state cache ownership before container start");
    expect(watchdog).toContain("/state/cache/uv/tools");

    // Resolves the live runtime compose service from the guest (not the drifted
    // hermes_instances.webfree flag) and derives the container from it, then
    // force-recreates the service that actually exists (gateway on webfree, webui
    // on legacy).
    expect(watchdog).toContain(
      'SERVICE="$({ docker compose config --services 2>/dev/null || true; } | grep -qx gateway && echo gateway || echo webui)"'
    );
    expect(watchdog).toContain("CONTAINER='agent-inst-123-gateway'");
    expect(watchdog).toContain("CONTAINER='agent-inst-123'");
    expect(watchdog).toContain('docker compose up -d --force-recreate --no-deps "$SERVICE"');
    // Must NOT scan running containers for -official-dashboard: a dead gateway
    // behind a live dashboard surface would otherwise mask as healthy.
    expect(watchdog).not.toContain("agent-inst-123-official-dashboard");

    // The broken legacy path is gone: no hard-coded `webui` service, and no bare
    // :8787 in-container python probe (the webfree gateway serves /health on
    // :8642). Recovery is confirmed via the container's own docker HEALTHCHECK.
    expect(watchdog).not.toContain("--no-deps webui");
    expect(watchdog).not.toContain('urllib.request.urlopen("http://127.0.0.1:8787');
    expect(watchdog).not.toContain("docker compose down --volumes");
  });

  it("update mode always pulls fresh images, force-recreates containers, and prunes stale runtime layers", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    // No inspect-skip — :stable is a moving tag and we want the new digest.
    // (The convergence gate's `docker image inspect ... --format '{{.Id}}'` is
    // a different, post-pull use: it reads the freshly-pulled digest to verify
    // the running containers actually swapped onto it — that is NOT a pull skip.)
    expect(script).not.toContain(
      "docker image inspect ghcr.io/ashneil12/vanilla-hermes-agent:stable >/dev/null 2>&1 || docker pull"
    );
    expect(script).toContain("docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable");
    expect(script).not.toMatch(
      /docker image inspect ghcr\.io\/ashneil12\/hermes-webui:stable >\/dev\/null 2>&1 \|\| docker compose pull/
    );
    // Force-recreate ensures webui+sidecar restart and re-import the new
    // agent-source even when the webui image digest didn't change.
    expect(script).toContain("docker compose up -d --remove-orphans --force-recreate");
    // Unused images older than the rollback window get cleaned up; this catches
    // tagged previous :stable images, not only dangling layers.
    expect(script).toContain("prune_dangling_docker_images");
    expect(script).toContain('docker image ls -a --filter dangling=true -q');
    expect(script).toContain("prune_old_unused_hermes_agent_images");
    expect(script).toContain('docker image rm "$image_ref"');
    // LKG is excluded before age checks, while dangling rows are removed by
    // image ID because their <none> repository/tag reference is not usable.
    expect(script).toContain('*:hermes-last-known-good) continue ;;');
    expect(script).toContain(
      '*:"<none>"|"<none>":*) docker image rm "$image_id" 2>/dev/null || true ;;',
    );
    expect(script).not.toContain('*:"<none>"|"<none>":*|*:hermes-last-known-good)');
    expect(script).not.toContain('*:<none>|"<none>:"*)');
    expect(script).toContain("hermes_volume_safe_update_cleanup post-success");
    // `-f` (not `-af`) keeps tagged-but-unused images like the LKG tag alive.
    expect(script).toContain("docker image prune -f ");
    expect(script).not.toContain("docker image prune -af");
    expect(script).not.toContain("docker system prune --volumes");
    expect(script).toContain("ctr -n moby content prune references");
  });

  it("installs low-memory swap guard before WebUI can run dependency installs", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams);

    expect(script).toContain("cat > /usr/local/bin/hermes-memory-guard");
    expect(script).toContain("modprobe zram");
    expect(script).toContain("swapon -p 100 /dev/zram0");
    expect(script).toContain("Before=docker.service");
    expect(script).toContain("HERMES_DISK_SWAP_MB");
    expect(script.indexOf("systemctl enable --now hermes-memory-guard.service")).toBeLessThan(
      script.indexOf("docker compose up -d --remove-orphans")
    );
  });

  it("creates the external Hermes Docker network before compose starts", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const provisionScript = buildWebUIBootstrapScript(artifacts, baseParams);
    const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    for (const script of [provisionScript, updateScript]) {
      expect(script).toContain("docker network create hermes_net >/dev/null 2>&1 || true");
      expect(script.indexOf("docker network create hermes_net")).toBeLessThan(
        script.indexOf("docker compose up -d")
      );
    }
  });

  it("repairs host clock sync before WebUI provision and update compose starts", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const provisionScript = buildWebUIBootstrapScript(artifacts, baseParams);
    const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    for (const script of [provisionScript, updateScript]) {
      expect(script).toContain("hermes_ensure_time_sync()");
      expect(script).toContain("/var/log/hermes-time-sync.log");
      expect(script).toContain("timedatectl set-timezone UTC");
      expect(script).toContain("timedatectl set-ntp true");
      expect(script).toContain("hwclock --systohc --utc");
      expect(script.indexOf("hermes_ensure_time_sync")).toBeLessThan(
        script.indexOf("docker compose up -d")
      );
    }
  });

  it("update mode preserves the persisted WebUI model config and provider env", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).not.toContain("cp /seed/config.yaml /state/config.yaml");
    expect(script).toContain("cp /state/config.yaml /seed/config.yaml");
    expect(script).toContain('cp /seed/hermes.env "$webui_env_tmp"');
    expect(script).toContain("cp /state/.env /seed/.env");
    expect(script).toContain("cp /state/.env /seed/hermes.env");
    expect(script).toContain(
      "rm -f /tmp/hermes-generated.env /tmp/hermes-compose-generated.env /state/models_dev_cache.json /state/webui/models_cache.json"
    );
    expect(script).toContain("Preserve existing WebUI state during update");
  });

  it("update mode repairs managed Venice provider drift in persisted config before preserving it", () => {
    const managedVeniceParams: WebUIDeployParams = {
      ...baseParams,
      dashboardProvider: "venice",
      inferenceProvider: "custom",
      defaultModel: "deepseek-v4-pro",
      baseUrl: "https://app.hermesos.test/api/managed-venice/v1",
    };
    const artifacts = buildWebUIProvisioningArtifacts(managedVeniceParams);
    const script = buildWebUIBootstrapScript(artifacts, managedVeniceParams, { mode: "update" });

    expect(script).toContain("Repair managed Venice provider drift in persisted config.yaml");
    expect(script).toContain("managed_venice_base_url='https://app.hermesos.test/api/managed-venice/v1'");
    expect(script).toContain("managed_venice_default_model='deepseek-v4-pro'");
    expect(script).toContain('provider: \\"custom\\"');
    expect(script).toContain("base_url: ");
    expect(script).toContain("config.yaml.pre-managed-venice-repair.");
    expect(script).toContain("[webui-update] managed Venice config repaired");

    const repairIdx = script.indexOf("Repair managed Venice provider drift in persisted config.yaml");
    const preserveIdx = script.indexOf("cp /state/config.yaml /seed/config.yaml");
    expect(repairIdx).toBeGreaterThan(0);
    expect(preserveIdx).toBeGreaterThan(0);
    expect(repairIdx).toBeLessThan(preserveIdx);

    const nonManagedScript = buildWebUIBootstrapScript(
      buildWebUIProvisioningArtifacts(baseParams),
      baseParams,
      { mode: "update" }
    );
    expect(nonManagedScript).not.toContain("Repair managed Venice provider drift in persisted config.yaml");
  });

  it("update mode repairs dashboard-managed toolchain env in persisted WebUI state", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).toContain("Repair dashboard-managed toolchain env keys");
    expect(script).toContain("API_SERVER_ENABLED API_SERVER_HOST API_SERVER_PORT TERMINAL_ENV");
    expect(script).toContain("managed_env_keys='PATH GH_CONFIG_DIR XDG_CONFIG_HOME");
    expect(script).toContain("cp /seed/hermes.env /tmp/hermes-generated.env");
    expect(script).toContain('sed -i "s|^${managed_env_key}=.*|${managed_env_line}|" "$webui_env_tmp"');
    expect(script).toContain('printf "\\n%s\\n" "$managed_env_line" >> "$webui_env_tmp"');
    expect(script).toContain("cp /state/.env /seed/hermes.env");
    // Atomic publish: build on a temp on the same volume and rename it over
    // /state/.env (which the gateway reloads every turn) — never edit in place,
    // and skip the write when nothing changed.
    expect(script).toContain('mv -f "$webui_env_tmp" /state/.env');
    expect(script).toContain('cmp -s "$webui_env_tmp" /state/.env');
    expect(script).not.toContain('sed -i "s|^${managed_env_key}=.*|${managed_env_line}|" /state/.env');
  });

  it("update mode strips the retired WebUI password auth env from persisted state before compose reads it", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).toContain("Remove retired WebUI password-auth env keys from persisted state");
    expect(script).toContain("retired_env_keys='HERMES_WEBUI_PASSWORD'");
    expect(script).toContain("for retired_env_key in $retired_env_keys; do");
    expect(script).toContain('sed -i "/^${retired_env_key}=/d" "$webui_env_tmp"');

    const stripIdx = script.indexOf("retired_env_keys='HERMES_WEBUI_PASSWORD'");
    const copyToComposeEnvIdx = script.indexOf("cp /state/.env /seed/.env");
    expect(stripIdx).toBeGreaterThan(0);
    expect(copyToComposeEnvIdx).toBeGreaterThan(0);
    expect(stripIdx).toBeLessThan(copyToComposeEnvIdx);
  });

  it("update mode scrubs leaked canary messaging probe tokens from persisted agent state", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).toContain("Remove leaked canary messaging probe credentials from persisted state");
    expect(script).toContain("TELEGRAM_BOT_TOKEN");
    expect(script).toContain("CANARY_SHAPE_PROBE");
    expect(script).toContain("canary_probe_env_keys='TELEGRAM_BOT_TOKEN'");
    expect(script).toContain('sed -i "/^${canary_probe_env_key}=.*CANARY_SHAPE_PROBE/d" "$webui_env_tmp"');

    const scrubIdx = script.indexOf("canary_probe_env_keys='TELEGRAM_BOT_TOKEN'");
    const publishIdx = script.indexOf('mv -f "$webui_env_tmp" /state/.env');
    expect(scrubIdx).toBeGreaterThan(0);
    expect(publishIdx).toBeGreaterThan(0);
    expect(scrubIdx).toBeLessThan(publishIdx);
  });

  it("update mode scrubs stale model-pin env keys from persisted state before publishing /state/.env", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    // The official-dashboard's _resolve_model() reads HERMES_MODEL /
    // HERMES_INFERENCE_MODEL before config.yaml, so a stale provisioning-time
    // pin in the preserved /state/.env bricks the model switcher. Redeploy
    // scrubs it so config.yaml (the live source of truth) wins.
    expect(script).toContain("Remove stale model-pin env keys from persisted state");
    expect(script).toContain("stale_model_pin_env_keys='HERMES_MODEL HERMES_INFERENCE_MODEL'");
    expect(script).toContain("for stale_model_pin_env_key in $stale_model_pin_env_keys; do");
    expect(script).toContain('sed -i "/^${stale_model_pin_env_key}=/d" "$webui_env_tmp"');

    // Must run on the temp env before the atomic publish back to /state/.env.
    const scrubIdx = script.indexOf("stale_model_pin_env_keys='HERMES_MODEL HERMES_INFERENCE_MODEL'");
    const publishIdx = script.indexOf('mv -f "$webui_env_tmp" /state/.env');
    expect(scrubIdx).toBeGreaterThan(0);
    expect(publishIdx).toBeGreaterThan(0);
    expect(scrubIdx).toBeLessThan(publishIdx);
  });

  it("logs the resolved runtime PATH if WebUI toolchain verification fails", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).toContain("for required_bin in hermes hermes-cli git node npm");
    expect(script).toContain("[webui-toolchain-check] missing required commands:");
    expect(script).toContain("[webui-toolchain-check] PATH=$PATH");
    expect(script).toContain("[webui-hermes-cli-check] Hermes CLI failed to start");
    expect(script).toContain("[webui-hermes-cli-check] resolved hermes=");
    expect(script).toContain(
      "sed -n '/^\\(PATH\\|PYTHONUSERBASE\\|PIP_CONFIG_FILE\\|PIP_CACHE_DIR\\|NPM_CONFIG_PREFIX\\|UV_TOOL_BIN_DIR\\)=/p'"
    );
  });

  it("installs missing WebUI developer tools after container recreate", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).toContain("Install WebUI developer tools inside recreated container");
    expect(script).toContain("apt-get install -y --no-install-recommends git nodejs npm ca-certificates");
    expect(script).toContain("apk add --no-cache git nodejs npm ca-certificates");
    expect(script).toContain("[webui-toolchain-bootstrap] missing after install:");
  });

  it("can use a cached provision agent image while updates pull the fresh update image", () => {
    const provisionImage = "ghcr.io/ashneil12/vanilla-hermes-agent:template-cache";
    const updateImage = "ghcr.io/ashneil12/vanilla-hermes-agent:stable";

    withEnv(
      {
        HERMES_WEBUI_AGENT_IMAGE: undefined,
        HERMES_WEBUI_AGENT_PROVISION_IMAGE: provisionImage,
        HERMES_WEBUI_AGENT_UPDATE_IMAGE: updateImage,
      },
      () => {
        const artifacts = buildWebUIProvisioningArtifacts(baseParams);
        const provisionScript = buildWebUIBootstrapScript(artifacts, baseParams);
        const updateScript = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

        expect(provisionScript).toContain(
          `docker image inspect ${provisionImage} >/dev/null 2>&1 || docker pull ${provisionImage}`
        );
        expect(provisionScript).toContain(`${provisionImage} -lc`);
        expect(provisionScript).not.toContain(`docker pull ${updateImage}`);

        expect(updateScript).toContain(`docker pull ${updateImage}`);
        expect(updateScript).toContain(`${updateImage} -lc`);
        expect(updateScript).not.toContain(provisionImage);
      }
    );
  });

  it("does not let the legacy HERMES_DOCKER_IMAGE pin override WebUI agent source updates", () => {
    withEnv(
      {
        HERMES_DOCKER_IMAGE: "ghcr.io/ashneil12/vanilla-hermes-agent:v0.12.x-ash-001",
        HERMES_WEBUI_AGENT_IMAGE: undefined,
        HERMES_WEBUI_AGENT_PROVISION_IMAGE: undefined,
        HERMES_WEBUI_AGENT_UPDATE_IMAGE: undefined,
      },
      () => {
        const artifacts = buildWebUIProvisioningArtifacts(baseParams);
        const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

        expect(script).toContain("docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable");
        expect(script).not.toContain("v0.12.x-ash-001");
      }
    );
  });

  it("patches sslip placeholder hostnames during fresh-server provisioning", () => {
    const artifacts = buildWebUIProvisioningArtifacts({
      ...baseParams,
      fqdn: "0-0-0-0.sslip.io",
    });
    const script = buildWebUIBootstrapScript(artifacts, {
      ...baseParams,
      fqdn: "0-0-0-0.sslip.io",
    });

    expect(script).toContain("Resolving public IP dynamically for 0-0-0-0.sslip.io placeholder");
    expect(script).toContain("sed -i");
  });

  it("uses OpenAI-compatible key env for custom providers like CrofAI", () => {
    const envFile = buildHermesEnvFile(baseParams);

    expect(envFile).toContain("HERMES_INFERENCE_PROVIDER=custom");
    expect(envFile).toContain("OPENAI_API_KEY=provider-key");
    // config.yaml owns the model; HERMES_MODEL must not be pinned in the .env
    // (it would win over config.yaml in the dashboard's _resolve_model()).
    expect(envFile).not.toContain("HERMES_MODEL=");
    expect(envFile).toContain("GH_CONFIG_DIR=/home/hermes/.hermes/gh");
    expect(envFile).toContain("XDG_CONFIG_HOME=/home/hermes/.hermes/.config");
    // XDG state/data/cache pinned into the writable HERMES_HOME volume so the
    // gateway's per-platform startup lock never falls back to an uncreatable
    // ~/.local (regression guard for the Telegram "/.local" crash-loop).
    expect(envFile).toContain("XDG_STATE_HOME=/home/hermes/.hermes/.local/state");
    expect(envFile).toContain("XDG_DATA_HOME=/home/hermes/.hermes/.local/share");
    expect(envFile).toContain("XDG_CACHE_HOME=/home/hermes/.hermes/.cache");
    expect(envFile).toContain("PYTHONUSERBASE=/home/hermes/.hermes/python");
    expect(envFile).toContain("PIP_CONFIG_FILE=/home/hermes/.hermes/pip.conf");
    expect(envFile).toContain("NPM_CONFIG_PREFIX=/home/hermes/.hermes/npm");
    expect(envFile).toContain("UV_TOOL_DIR=/home/hermes/.hermes/uv/tools");
    expect(envFile).toContain(expectedWebUIPath);
    expect(envFile).toContain("BUN_INSTALL=/home/hermes/.hermes/bun");
  });

  it("seeds both OpenAI-compatible and native Gemini key aliases for Gemini WebUI agents", () => {
    const geminiParams = {
      ...baseParams,
      inferenceProvider: "custom",
      dashboardProvider: "gemini",
      defaultModel: "gemini-3.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    };

    const hermesEnv = buildHermesEnvFile(geminiParams);
    const composeEnv = buildWebUIComposeEnv(geminiParams);

    expect(hermesEnv).toContain("HERMES_INFERENCE_PROVIDER=custom");
    expect(hermesEnv).toContain("OPENAI_API_KEY=provider-key");
    expect(hermesEnv).toContain("GEMINI_API_KEY=provider-key");
    expect(hermesEnv).toContain("OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/");
    // config.yaml owns the model — no HERMES_MODEL pin in the persisted .env.
    expect(hermesEnv).not.toContain("HERMES_MODEL=");
    expect(composeEnv).toContain("OPENAI_API_KEY=provider-key");
    expect(composeEnv).toContain("GEMINI_API_KEY=provider-key");
  });

  it("persists OpenAI provider keys in compose env for recreate-safe WebUI agents", () => {
    const envFile = buildWebUIComposeEnv({
      ...baseParams,
      inferenceProvider: "openai",
      defaultModel: "gpt-5.4-pro",
    });

    expect(envFile).toContain("HERMES_INFERENCE_PROVIDER=openai");
    expect(envFile).toContain("HERMES_WEBUI_DEFAULT_MODEL=gpt-5.4-pro");
    expect(envFile).toContain("OPENAI_API_KEY=provider-key");
    expect(envFile).not.toContain("OPENROUTER_API_KEY=provider-key");
  });

  describe("dashboard callback vars (HERMES_DASHBOARD_URL + API_SERVER_KEY)", () => {
    // Without these two vars, the in-VM `ru` shell function built by
    // buildInstanceUpdateReporterShell silently no-ops, the dashboard
    // never gets the "update succeeded" callback, and the row sits at
    // status="redeploying" until someone visits the dashboard. Regression
    // test for 2026-05-17 fleet-stuck-at-redeploying incident.
    it("seeds HERMES_DASHBOARD_URL from NEXT_PUBLIC_APP_URL so the in-VM ru callback can reach the dashboard", () => {
      withEnv({ NEXT_PUBLIC_APP_URL: "https://hermesos.cloud/" }, () => {
        const envFile = buildWebUIComposeEnv(baseParams);
        expect(envFile).toContain("HERMES_DASHBOARD_URL=https://hermesos.cloud");
      });
    });

    it("falls back to https://hivra.cloud when NEXT_PUBLIC_APP_URL is unset", () => {
      withEnv({ NEXT_PUBLIC_APP_URL: undefined }, () => {
        const envFile = buildWebUIComposeEnv(baseParams);
        expect(envFile).toContain("HERMES_DASHBOARD_URL=https://hivra.cloud");
      });
    });

    it("writes API_SERVER_KEY=webuiPassword so the ru bearer matches the dashboard auth check", () => {
      const envFile = buildWebUIComposeEnv(baseParams);
      expect(envFile).toContain("API_SERVER_KEY=webui-password");
    });

    // The fleet-wide reason redeploys emitted NO update-report telemetry: the
    // update-mode stateSeedCommand does `cp /state/.env /seed/.env`, replacing the
    // compose .env (which buildWebUIComposeEnv populated with both callback keys)
    // with the agent runtime env (which has NEITHER). So the in-VM `ru` callback
    // read an .env missing both keys and silently no-op'd on every redeploy.
    //
    // This used to be re-seeded by a two-key `sed`+`printf` special case. Those two
    // were never the only casualties — the same copy dropped HERMES_INSTANCE_ID and
    // HERMES_DASHBOARD_BASIC_AUTH_* too — so the special case was generalised into a
    // replay of the whole generated compose env. Both callback keys are in that env
    // with the same values, so the guarantee is unchanged; assert it through the
    // generalised path.
    it("update mode restores HERMES_DASHBOARD_URL + API_SERVER_KEY into .env after the agent-env clobber", () => {
      withEnv({ NEXT_PUBLIC_APP_URL: "https://hivra.cloud" }, () => {
        const artifacts = buildWebUIProvisioningArtifacts(baseParams);
        const script = buildWebUIBootstrapScript(artifacts, baseParams, {
          mode: "update",
        });
        // Both callback keys are carried by the generated compose env...
        expect(artifacts.envFile).toContain("HERMES_DASHBOARD_URL=https://hivra.cloud");
        expect(artifacts.envFile).toContain("API_SERVER_KEY=webui-password");
        // ...which is snapshotted before the clobber and replayed after it.
        const snapshotIdx = script.indexOf("cp /seed/.env /tmp/hermes-compose-generated.env");
        const clobberIdx = script.indexOf("cp /state/.env /seed/.env");
        const reseedIdx = script.indexOf("cat /tmp/hermes-compose-generated.env >> /seed/.env");
        expect(snapshotIdx).toBeGreaterThan(-1);
        expect(clobberIdx).toBeGreaterThan(snapshotIdx);
        expect(reseedIdx).toBeGreaterThan(clobberIdx);
      });
    });

    it("provision mode keeps both callback keys in the compose .env and never clobbers it with the agent env", () => {
      const artifacts = buildWebUIProvisioningArtifacts(baseParams);
      const script = buildWebUIBootstrapScript(artifacts, baseParams, {
        mode: "provision",
      });
      expect(script).not.toContain("cp /state/.env /seed/.env");
    });
  });

  describe("HERMES_OAUTH_PROVIDER (first-launch OAuth gate signal)", () => {
    it("emits HERMES_OAUTH_PROVIDER=nous for Nous Portal Auth signups (custom inference, dashboard=nous)", () => {
      const envFile = buildWebUIComposeEnv({
        ...baseParams,
        inferenceProvider: "custom",
        dashboardProvider: "nous",
        baseUrl: "https://inference-api.nousresearch.com/v1",
        defaultModel: "Hermes-3-Llama-3.1-405B",
      });
      expect(envFile).toContain("HERMES_OAUTH_PROVIDER=nous");
    });

    it("does NOT emit HERMES_OAUTH_PROVIDER for openai-codex because Codex uses the dashboard device-code flow", () => {
      const envFile = buildWebUIComposeEnv({
        ...baseParams,
        inferenceProvider: "openai-codex",
        dashboardProvider: "codex",
        defaultModel: "gpt-5.5",
      });
      expect(envFile).not.toContain("HERMES_OAUTH_PROVIDER=openai-codex");
    });

    it("does NOT emit HERMES_OAUTH_PROVIDER for api-key providers", () => {
      const envFile = buildWebUIComposeEnv({
        ...baseParams,
        inferenceProvider: "openrouter",
        dashboardProvider: "openrouter",
      });
      expect(envFile).not.toContain("HERMES_OAUTH_PROVIDER");
    });
  });

  it("passes the managed Venice dashboard billing link to WebUI managed Venice agents", () => {
    withEnv(
      {
        NEXT_PUBLIC_APP_URL: "https://app.hermesos.test/",
      },
      () => {
        const managedVeniceParams: WebUIDeployParams = {
          ...baseParams,
          dashboardProvider: "venice",
          inferenceProvider: "custom",
          defaultModel: "deepseek-v4-pro",
          baseUrl: "https://app.hermesos.test/api/managed-venice/v1",
        };
        const envFile = buildWebUIComposeEnv(managedVeniceParams);
        const hermesEnvFile = buildHermesEnvFile(managedVeniceParams);
        const configYaml = buildWebUIConfigYaml(managedVeniceParams);

        expect(envFile).toContain("OPENAI_API_KEY=provider-key");
        expect(envFile).toContain("OPENAI_BASE_URL=https://app.hermesos.test/api/managed-venice/v1");
        expect(envFile).toContain("HERMES_WEBUI_DEFAULT_MODEL=deepseek-v4-pro");
        expect(envFile).not.toContain("HERMES_WEBUI_DEFAULT_MODEL=@venice:deepseek-v4-pro");
        expect(hermesEnvFile).toContain("HERMES_INFERENCE_PROVIDER=custom");
        expect(hermesEnvFile).toContain("OPENAI_API_KEY=provider-key");
        expect(hermesEnvFile).not.toContain("DEEPSEEK_API_KEY");
        expect(configYaml).toContain('provider: "custom"');
        expect(configYaml).not.toContain('provider: "deepseek"');
        expect(envFile).toContain(
          "HERMES_MANAGED_VENICE_ENABLE_URL=https://app.hermesos.test/dashboard/billing?managedVenice=deposit&wallet=hermesos"
        );

        // Clean-slate (deploy-card "Managed (Venice)? = OFF") guard: even if a
        // managed-Venice-shaped baseUrl somehow rode along, an `unconfigured`
        // deploy must NOT stamp the enable-url. The managed path is only ever
        // reached when the dashboard actually minted a proxy key (Managed=ON),
        // and clean-slate omits provider/key entirely. See
        // CreateInstanceSchema.unconfigured contract.
        const unconfiguredCompose = buildWebUIComposeEnv({
          ...managedVeniceParams,
          // Contract field: instance-service config.unconfigured →
          // WebUIDeployParams.unconfigured.
          unconfigured: true,
        });
        expect(unconfiguredCompose).not.toContain("HERMES_MANAGED_VENICE_ENABLE_URL");
      }
    );
  });

  it("re-pins a managed-Venice box's baked base URL to the LIVE domain on redeploy (stale stored hermesos.cloud must not survive)", () => {
    // Regression for the re-bake loop: managed-Venice rows provisioned before the
    // hivra.cloud cutover still carry a stored customLlmBaseUrl on the dead
    // hermesos.cloud host, which now 301-redirects — and the agent's OpenAI client
    // won't follow a cross-origin POST redirect (the Jun-2026 managed-Venice usage
    // cliff). The runtime resolver (PR #415) fixed the dashboard's live API path,
    // but the builder used to bake the stored URL verbatim, so every redeploy
    // re-baked the dead host. The builder must re-derive the proxy URL from the
    // LIVE NEXT_PUBLIC_APP_URL on every (re)deploy.
    withEnv(
      {
        NEXT_PUBLIC_APP_URL: "https://hivra.cloud",
      },
      () => {
        const staleManagedParams: WebUIDeployParams = {
          ...baseParams,
          dashboardProvider: "venice",
          inferenceProvider: "custom",
          defaultModel: "deepseek-v4-pro",
          // Stale pre-cutover host baked into the row.
          baseUrl: "https://hermesos.cloud/api/managed-venice/v1",
          // Managed proxy key — only valid against our gateway, never api.venice.ai.
          llmApiKey: "hven_live_examplekey",
        };

        const composeEnv = buildWebUIComposeEnv(staleManagedParams);
        const hermesEnv = buildHermesEnvFile(staleManagedParams);

        // Both baked base URLs must point at the LIVE domain, not the stale host.
        expect(composeEnv).toContain(
          "OPENAI_BASE_URL=https://hivra.cloud/api/managed-venice/v1"
        );
        expect(hermesEnv).toContain(
          "OPENAI_BASE_URL=https://hivra.cloud/api/managed-venice/v1"
        );
        expect(hermesEnv).toContain(
          "VENICE_BASE_URL=https://hivra.cloud/api/managed-venice/v1"
        );
        // The dead host must not survive anywhere in the baked managed env.
        expect(composeEnv).not.toContain("hermesos.cloud/api/managed-venice");
        expect(hermesEnv).not.toContain("hermesos.cloud/api/managed-venice");
      }
    );
  });

  it("writes per-agent Bankr wallet config and env aliases for WebUI agents", () => {
    const bankr = {
      walletAddress: "0x000000000000000000000000000000000000ba5e",
      apiKey: "bk_agent_wallet_key",
      walletId: "wlt_agent_123",
      withdrawalDestination: "0x000000000000000000000000000000000000feed",
    };
    const artifacts = buildWebUIProvisioningArtifacts({
      ...baseParams,
      bankr,
    });

    expect(artifacts.configYaml).toContain("bankr:");
    expect(artifacts.configYaml).toContain(`walletAddress: "${bankr.walletAddress}"`);
    expect(artifacts.configYaml).toContain(`apiKey: "${bankr.apiKey}"`);
    expect(artifacts.configYaml).toContain(`walletId: "${bankr.walletId}"`);
    expect(artifacts.configYaml).toContain(`withdrawalDestination: "${bankr.withdrawalDestination}"`);

    expect(artifacts.hermesEnvFile).toContain(`BANKR_AGENT_WALLET_ADDRESS=${bankr.walletAddress}`);
    expect(artifacts.hermesEnvFile).toContain(`BANKR_WALLET_ADDRESS=${bankr.walletAddress}`);
    expect(artifacts.hermesEnvFile).toContain(`BANKR_AGENT_API_KEY=${bankr.apiKey}`);
    expect(artifacts.hermesEnvFile).toContain(`BANKR_API_KEY=${bankr.apiKey}`);
    expect(artifacts.hermesEnvFile).toContain(`BANKR_AGENT_WALLET_ID=${bankr.walletId}`);
    expect(artifacts.hermesEnvFile).toContain(
      `BANKR_AGENT_WITHDRAWAL_DESTINATION=${bankr.withdrawalDestination}`
    );
  });

  it("keeps unsupported OpenAI-compatible providers on runtime env/config instead of WebUI provider keys", () => {
    const veniceParams: WebUIDeployParams = {
      ...baseParams,
      inferenceProvider: "custom",
      defaultModel: "deepseek-v4-pro",
      baseUrl: "https://api.venice.ai/api/v1",
    };

    expect(resolveWebUIProviderEnvVar(veniceParams.inferenceProvider)).toBe("OPENAI_API_KEY");
    expect(buildHermesEnvFile(veniceParams)).toContain("OPENAI_API_KEY=provider-key");
    expect(buildWebUIProvisioningArtifacts(veniceParams).configYaml).toContain(
      'base_url: "https://api.venice.ai/api/v1"'
    );
  });

  it("injects Codex OAuth auth into WebUI state without treating it as an API key", () => {
    const codexParams: WebUIDeployParams = {
      ...baseParams,
      inferenceProvider: "openai-codex",
      llmApiKey: "",
      defaultModel: "gpt-5.5",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      codexAuthBundle: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        lastRefresh: "2026-04-26T00:00:00.000Z",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    };
    const artifacts = buildWebUIProvisioningArtifacts(codexParams);
    const envFile = buildHermesEnvFile(codexParams);
    const authStore = buildWebUIAuthStoreFile(codexParams);
    const script = buildWebUIBootstrapScript(artifacts, codexParams);

    expect(envFile).toContain("HERMES_INFERENCE_PROVIDER=openai-codex");
    expect(envFile).not.toContain("OPENROUTER_API_KEY=");
    expect(envFile).toContain("GH_CONFIG_DIR=/home/hermes/.hermes/gh");
    expect(envFile).toContain("XDG_CONFIG_HOME=/home/hermes/.hermes/.config");
    expect(envFile).toContain("PIPX_BIN_DIR=/home/hermes/.hermes/bin");
    expect(envFile).toContain(expectedWebUIPath);
    expect(envFile).toContain("GOPATH=/home/hermes/.hermes/go");
    expect(envFile).toContain("DENO_INSTALL=/home/hermes/.hermes/deno");
    expect(authStore).toContain('"openai-codex"');
    expect(script).toContain("auth.json.inject");
    expect(script).toContain("/state/auth.json");
    expect(script).toContain("/state/auth.lock");
  });
});

describe("persisted signal-cli daemon (Signal platform durability)", () => {
  // Why this exists: the Signal adapter needs an external Java signal-cli
  // daemon. A tenant's agent apt-installing a JRE into the ephemeral
  // container layer dies on the next image-update recreate, and prod agent
  // containers have no sudo to self-heal (regression from a disposable verification run).
  // The builder must (a) stage the persisted-volume bootstrap script,
  // (b) mount it into the gateway container, and (c) have the
  // gateway-supervisor manage the daemon off SIGNAL_* env.
  const composeParams = {
    ...baseParams,
    image: "ghcr.io/ashneil12/hermes-webui:stable",
    agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest",
  };

  it("mounts the staged signal-daemon.sh read-only into the gateway container", () => {
    const compose = buildWebUICompose(composeParams);
    expect(compose).toContain("- ./signal-daemon.sh:/opt/hermes-platform/signal-daemon.sh:ro");
  });

  it("supervisor manages the daemon only for loopback SIGNAL_HTTP_URLs and never races an existing daemon", () => {
    const compose = buildWebUICompose(composeParams);
    expect(compose).toContain("manage_signal_daemon");
    // Loopback gate: a remote SIGNAL_HTTP_URL means the tenant runs their
    // own daemon; the supervisor must leave it alone.
    expect(compose).toContain('host in ("127.0.0.1", "localhost")');
    // Reachability probe mirrors the adapter's own health check endpoint
    // (gateway/platforms/signal.py expects HTTP 200 from /api/v1/check), so
    // legacy in-volume watchdog daemons are detected and not double-bound.
    expect(compose).toContain("/api/v1/check");
    // Container path must be rendered, not leak the TS placeholder.
    expect(compose).not.toContain("WEBUI_SIGNAL_DAEMON_CONTAINER_PATH");
    // Supervisor shutdown must also stop the managed daemon child.
    expect(compose).toContain('stop_gateway_child("signal-daemon", signal_child, "supervisor_shutdown")');
  });

  it("supervisor restarts the daemon when messaging credentials change", () => {
    const compose = buildWebUICompose(composeParams);
    expect(compose).toContain('stop_gateway_child("signal-daemon", child, "env_changed")');
    expect(compose).toContain('stop_gateway_child("signal-daemon", child, "signal_unconfigured")');
  });

  it("stages signal-daemon.sh in both provision and update bootstrap scripts", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    for (const mode of ["provision", "update"] as const) {
      const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode });
      expect(script).toContain("cat > signal-daemon.sh <<'__HERMES_EOF__'");
      expect(script).toContain("signal-cli");
    }
  });
});

describe("clean-slate / unconfigured deploy (deploy-card Managed=OFF, BYOK after boot)", () => {
  // Deploy-card redesign: "Managed (Venice)? = OFF" deploys an UNCONFIGURED box
  // — no inference provider, no key, no model seeded. The agent boots with
  // nothing configured so its native onboarding overlay fires (setup.status →
  // provider_configured=false) and the user pastes a key / connects a provider
  // AFTER the box is up. This is what kills the keyless-provider init brick (a
  // half-seeded provider name with no key → "Provider '…' no API key" wedge).
  //
  // CONTRACT (shared across all deploy-card agents):
  //   - CreateInstanceSchema carries optional `unconfigured: boolean` (default false).
  //   - Intent persists in config.unconfigured (NOT a provider-column sentinel —
  //     instance.provider stays at the benign "openrouter" default so
  //     PROVIDER_ID_MAP lookups / redeploy never throw; it's simply unused).
  //   - WebUIDeployParams carries optional `unconfigured?: boolean`, sourced from
  //     config.unconfigured at the WebUIDeployParams construction site.
  //   - When p.unconfigured is true, the builders SKIP all provider/model/key
  //     seeding, and a clean-slate deploy must NOT mint a managed-Venice proxy key.
  //
  // Because provider stays "openrouter" on the row, unconfiguredParams keeps a
  // provider+key+model set (mirroring the real row) and the ONLY discriminator
  // vs. the configured regression block below is the `unconfigured` flag.
  const unconfiguredParams: WebUIDeployParams = {
    ...baseParams,
    // provider/model/key are still present on the row (benign "openrouter"
    // default), but the flag tells the builder to ignore them and seed nothing.
    inferenceProvider: "openrouter",
    dashboardProvider: "openrouter",
    defaultModel: "deepseek-v3.2",
    baseUrl: undefined,
    unconfigured: true,
  };

  describe("buildHermesEnvFile (persisted /state/.env)", () => {
    it("emits NO HERMES_INFERENCE_PROVIDER and NO provider key line for a clean-slate deploy", () => {
      const envFile = buildHermesEnvFile(unconfiguredParams);
      expect(envFile).not.toContain("HERMES_INFERENCE_PROVIDER=");
      // No provider API-key line of any flavor leaks into the env.
      expect(envFile).not.toContain("OPENROUTER_API_KEY=");
      expect(envFile).not.toContain("OPENAI_API_KEY=");
      expect(envFile).not.toContain("ANTHROPIC_API_KEY=");
      expect(envFile).not.toContain("provider-key");
      // And no model pin (config.yaml owns the model when configured; here it
      // is absent entirely so onboarding can seed it later).
      expect(envFile).not.toContain("HERMES_MODEL=");
    });
  });

  describe("buildWebUIConfigYaml (model + provider source of truth)", () => {
    it("emits NO model: block (no default/provider) for a clean-slate deploy", () => {
      const configYaml = buildWebUIConfigYaml(unconfiguredParams);
      expect(configYaml).not.toContain("model:");
      expect(configYaml).not.toContain('provider: "openrouter"');
      expect(configYaml).not.toContain('default: "deepseek-v3.2"');
    });
  });

  describe("buildWebUIComposeEnv (recreate-safe outer .env)", () => {
    it("emits NO provider or provider-key for a clean-slate deploy", () => {
      const composeEnv = buildWebUIComposeEnv(unconfiguredParams);
      expect(composeEnv).not.toContain("HERMES_INFERENCE_PROVIDER=");
      expect(composeEnv).not.toContain("OPENROUTER_API_KEY=");
      expect(composeEnv).not.toContain("OPENAI_API_KEY=");
      expect(composeEnv).not.toContain("provider-key");
    });

    it("does NOT mint / stamp a managed-Venice enable-url for a clean-slate deploy", () => {
      // A managed-Venice-shaped baseUrl must never trigger the enable-url when
      // the deploy is unconfigured — the managed path is Managed=ON only.
      const composeEnv = buildWebUIComposeEnv({
        ...unconfiguredParams,
        dashboardProvider: "venice",
        inferenceProvider: "custom",
        baseUrl: "https://app.hermesos.test/api/managed-venice/v1",
        unconfigured: true,
      });
      expect(composeEnv).not.toContain("HERMES_MANAGED_VENICE_ENABLE_URL");
      expect(composeEnv).not.toContain("VENICE_API_KEY=");
    });
  });
});

describe("configured BYOK deploy (regression guard — Managed=OFF must still seed when a key IS provided pre-redesign)", () => {
  // Mirror of the clean-slate block: the DEFAULT (no `unconfigured` flag, or
  // explicitly false) BYOK path must keep emitting provider + key + the
  // config.yaml model block exactly as before. Guards against an over-broad
  // skip branch that strips configured deploys too.
  it("still emits HERMES_INFERENCE_PROVIDER + provider key in buildHermesEnvFile", () => {
    const envFile = buildHermesEnvFile({
      ...baseParams,
      inferenceProvider: "openrouter",
      defaultModel: "deepseek-v3.2",
      baseUrl: undefined,
    });
    expect(envFile).toContain("HERMES_INFERENCE_PROVIDER=openrouter");
    expect(envFile).toContain("OPENROUTER_API_KEY=provider-key");
  });

  it("still emits the config.yaml model: block (default + provider)", () => {
    const configYaml = buildWebUIConfigYaml({
      ...baseParams,
      inferenceProvider: "openrouter",
      defaultModel: "deepseek-v3.2",
      baseUrl: undefined,
    });
    expect(configYaml).toContain("model:");
    expect(configYaml).toContain('default: "deepseek-v3.2"');
    expect(configYaml).toContain('provider: "openrouter"');
  });

  it("still persists the provider key in buildWebUIComposeEnv for recreate safety", () => {
    const composeEnv = buildWebUIComposeEnv({
      ...baseParams,
      inferenceProvider: "openrouter",
      defaultModel: "deepseek-v3.2",
      baseUrl: undefined,
    });
    expect(composeEnv).toContain("HERMES_INFERENCE_PROVIDER=openrouter");
    expect(composeEnv).toContain("OPENROUTER_API_KEY=provider-key");
  });

  it("an explicit unconfigured=false deploy behaves identically to the default configured path", () => {
    const envFile = buildHermesEnvFile({
      ...baseParams,
      inferenceProvider: "openrouter",
      defaultModel: "deepseek-v3.2",
      baseUrl: undefined,
      unconfigured: false,
    });
    expect(envFile).toContain("HERMES_INFERENCE_PROVIDER=openrouter");
    expect(envFile).toContain("OPENROUTER_API_KEY=provider-key");
  });
});

describe("buildWebUIConfigYaml — auxiliary compression model + context engine", () => {
  it("omits both blocks when neither is set (default: inherit main / agent default)", () => {
    const yaml = buildWebUIConfigYaml(baseParams);
    expect(yaml).not.toContain("auxiliary:");
    expect(yaml).not.toContain("context:");
  });

  it("emits auxiliary.compression.{provider,model}, collapsing the provider id like the model block", () => {
    // crof is an OpenAI-compatible provider → collapses to `custom`, exactly how
    // the main model: block expresses it. The cheap compression model rides along.
    const yaml = buildWebUIConfigYaml({
      ...baseParams,
      compressionProvider: "crof",
      compressionModel: "deepseek-v3.2-lite",
    });
    expect(yaml).toContain("auxiliary:");
    expect(yaml).toContain("  compression:");
    expect(yaml).toContain('    provider: "custom"');
    expect(yaml).toContain('    model: "deepseek-v3.2-lite"');
  });

  it("inherits the main provider when a compression model is set with no explicit provider", () => {
    const yaml = buildWebUIConfigYaml({
      ...baseParams,
      inferenceProvider: "anthropic",
      dashboardProvider: "anthropic",
      compressionModel: "claude-haiku-4-5",
    });
    expect(yaml).toContain('    provider: "anthropic"');
    expect(yaml).toContain('    model: "claude-haiku-4-5"');
  });

  it("emits NO auxiliary block when only a provider is set but the model is blank (blank == inherit main)", () => {
    const yaml = buildWebUIConfigYaml({
      ...baseParams,
      compressionProvider: "anthropic",
      compressionModel: "",
    });
    expect(yaml).not.toContain("auxiliary:");
  });

  it("emits context.engine when the engine is set (both values)", () => {
    const sliding = buildWebUIConfigYaml({ ...baseParams, contextEngine: "sliding" });
    expect(sliding).toContain("context:");
    expect(sliding).toContain('  engine: "sliding"');

    const compressor = buildWebUIConfigYaml({ ...baseParams, contextEngine: "compressor" });
    expect(compressor).toContain('  engine: "compressor"');
  });

  it("pins the sliding tuning when the engine is explicitly sliding", () => {
    // Regression: choosing "sliding" explicitly used to emit ONLY `engine:`,
    // so the box stored `sliding: {}` and silently inherited the agent's
    // _SLIDING_DEFAULTS — i.e. picking the engine in the UI produced LESS
    // configuration than not picking it at all (the operatoros fallback pinned
    // every knob). Values match those defaults, so this pins behavior rather
    // than changing it: an upstream default change can no longer retune a live
    // box's context engine with no config diff.
    const yaml = buildWebUIConfigYaml({ ...baseParams, contextEngine: "sliding" });
    expect(yaml).toContain("  sliding:");
    expect(yaml).toContain("    tail_messages: 10");
    expect(yaml).toContain("    fold_batch: 5");
    expect(yaml).toContain("    max_blocks: 8");
    expect(yaml).toContain("    hard_tail_factor: 3");
    expect(yaml).toContain("    spill_bytes: 8000");
    // The full-rewrite dedup threshold is the expensive knob — pin it hardest.
    expect(yaml).toContain("    full_rewrite_tokens: 10000");
  });

  it("does NOT emit sliding tuning when the engine is compressor", () => {
    const yaml = buildWebUIConfigYaml({ ...baseParams, contextEngine: "compressor" });
    expect(yaml).toContain('  engine: "compressor"');
    expect(yaml).not.toContain("  sliding:");
    expect(yaml).not.toContain("full_rewrite_tokens");
  });


  it("keeps context.engine on clean-slate boxes but drops the aux model (aux needs a configured main model)", () => {
    // context.engine is orthogonal to provider config (like approvals/plugins);
    // the aux compression model rides with the model: block, which unconfigured drops.
    const yaml = buildWebUIConfigYaml({
      ...baseParams,
      unconfigured: true,
      contextEngine: "sliding",
      compressionProvider: "anthropic",
      compressionModel: "claude-haiku-4-5",
    });
    expect(yaml).not.toContain("model:");
    expect(yaml).not.toContain("auxiliary:");
    expect(yaml).toContain('  engine: "sliding"');
  });
});

describe("buildWebUIConfigYaml — legacy Operator OS update compatibility", () => {
  // Existing rows may retain a pinned external image. Their update path must
  // preserve the legacy config, while fresh provisioning fails closed.
  const operatorosParams: WebUIDeployParams = {
    ...baseParams,
    agentImage: "ghcr.io/ashneil12/operatoros-agent:stable",
  };

  it("emits the full autonomy config on an Operator OS box", () => {
    const yaml = buildWebUIConfigYaml(operatorosParams, "update");
    // mission mode on + cost ceilings
    expect(yaml).toContain("mission:");
    expect(yaml).toContain("  enabled: true");
    expect(yaml).toContain("    token_ceiling: 2000000");
    expect(yaml).toContain("    board_token_ceiling: 8000000");
    // the four organs + evo, appended (hivra_approval_relay preserved)
    expect(yaml).toContain("    - observability/hivra_approval_relay");
    expect(yaml).toContain("    - operatoros-organs");
    expect(yaml).toContain("    - evo");
    // per-run token budget + outbox RED gate
    expect(yaml).toContain("budget:");
    expect(yaml).toContain("  max_prompt_tokens_per_run: 300000");
    expect(yaml).toContain("outbox:");
    expect(yaml).toContain('    - "deploy_*"');
    expect(yaml).toContain('    - "provision_*"');
    expect(yaml).toContain('    - "cronjob"');
    // approvals full YOLO merged into the one approvals block
    expect(yaml).toContain('  mode: "off"');
    expect(yaml).toContain('  cron_mode: "off"');
    expect(yaml).toContain("  gateway_timeout: 3600");
    // delegation auto-approve + deliberately UNCAPPED fan-out. These caps must
    // be generated here, not hand-patched onto a box: this generator rewrites
    // config.yaml on every settings-save, so a hand-added value silently
    // reverts to the shared defaults (3 wide / 1 deep = flat).
    expect(yaml).toContain("delegation:");
    expect(yaml).toContain("  subagent_auto_approve: true");
    expect(yaml).toContain("  max_concurrent_children: 64");
    expect(yaml).toContain("  max_spawn_depth: 6");
    // agent completion-runtime flags
    expect(yaml).toContain("  completion_guard: true");
    expect(yaml).toContain("  tool_use_enforcement: true");
    expect(yaml).toContain("  intent_ack_continuation: true");
    expect(yaml).toContain("  verify_on_stop: true");
    // lean compression / tool-output / web / context-file caps
    expect(yaml).toContain("compression:");
    expect(yaml).toContain("  threshold: 0.35");
    expect(yaml).toContain("  proactive_prune_threshold: 40000");
    expect(yaml).toContain("tool_output:");
    expect(yaml).toContain("  max_bytes: 20000");
    expect(yaml).toContain("  extract_char_limit: 8000");
    expect(yaml).toContain("context_file_max_chars: 12000");
    // sliding context engine is the operatoros default
    expect(yaml).toContain("context:");
    expect(yaml).toContain('  engine: "sliding"');
    expect(yaml).toContain("    tail_messages: 10");
  });

  it("keeps every merged block single (no duplicate top-level YAML keys)", () => {
    const yaml = buildWebUIConfigYaml(operatorosParams, "update");
    const lineCount = (key: string) => yaml.split("\n").filter((l) => l === key).length;
    expect(lineCount("approvals:")).toBe(1);
    expect(lineCount("plugins:")).toBe(1);
    expect(lineCount("agent:")).toBe(1);
    expect(lineCount("context:")).toBe(1);
    expect(lineCount("web:")).toBe(1);
  });

  it("does NOT emit the autonomy config on a vanilla (non-operatoros) box", () => {
    const yaml = buildWebUIConfigYaml({
      ...baseParams,
      agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
    });
    expect(yaml).not.toContain("mission:");
    expect(yaml).not.toContain("- operatoros-organs");
    expect(yaml).not.toContain("budget:");
    expect(yaml).not.toContain("outbox:");
    expect(yaml).not.toContain("delegation:");
    expect(yaml).not.toContain("completion_guard:");
    expect(yaml).not.toContain('  mode: "off"');
    expect(yaml).not.toContain("context_file_max_chars:");
    // context.engine stays at the agent default unless the user picks one
    expect(yaml).not.toContain("context:");
    // the relay plugin + gateway_timeout survive unchanged
    expect(yaml).toContain("    - observability/hivra_approval_relay");
    expect(yaml).toContain("  gateway_timeout: 3600");
  });

  it("rejects a fresh environment override and permits it only for legacy updates", () => {
    withEnv(
      { HERMES_WEBUI_AGENT_PROVISION_IMAGE: "ghcr.io/ashneil12/operatoros-agent:stable" },
      () => {
        expect(() => buildWebUIConfigYaml(baseParams)).toThrow(
          "New Operator OS provisioning is unavailable"
        );
      }
    );
    withEnv(
      { HERMES_WEBUI_AGENT_UPDATE_IMAGE: "ghcr.io/ashneil12/operatoros-agent:stable" },
      () => {
        const yaml = buildWebUIConfigYaml(baseParams, "update");
        expect(yaml).toContain("mission:");
        expect(yaml).toContain("    - operatoros-organs");
      }
    );
  });

  it("lets a user-set context engine win over the sliding default (no clobber)", () => {
    const yaml = buildWebUIConfigYaml(
      { ...operatorosParams, contextEngine: "compressor" },
      "update"
    );
    expect(yaml).toContain('  engine: "compressor"');
    expect(yaml).not.toContain('  engine: "sliding"');
    expect(yaml.split("\n").filter((l) => l === "context:").length).toBe(1);
    // Compressor must not drag the sliding tuning along with it.
    expect(yaml).not.toContain("  sliding:");
    // the rest of the autonomy preset is unaffected by the engine override
    expect(yaml).toContain("mission:");
  });

  it("emits the sliding tuning exactly once when operatoros ALSO selects sliding", () => {
    // Both the explicit branch and the operatoros fallback can produce this
    // block. They must never both fire — a duplicated `sliding:` key is
    // invalid YAML and would break config load on a live box.
    const yaml = buildWebUIConfigYaml(
      { ...operatorosParams, contextEngine: "sliding" },
      "update"
    );
    expect(yaml.split("\n").filter((l) => l === "context:").length).toBe(1);
    expect(yaml.split("\n").filter((l) => l === "  sliding:").length).toBe(1);
    expect(
      yaml.split("\n").filter((l) => l.includes("full_rewrite_tokens")).length
    ).toBe(1);
  });

  it("keeps the aux-model UI setting's auxiliary.compression alongside the operatoros compression tuning", () => {
    const yaml = buildWebUIConfigYaml(
      {
        ...operatorosParams,
        compressionProvider: "anthropic",
        compressionModel: "claude-haiku-4-5",
      },
      "update"
    );
    // aux (the cheap summarizer model — the UI setting) is preserved, not clobbered
    expect(yaml).toContain("auxiliary:");
    expect(yaml).toContain('    model: "claude-haiku-4-5"');
    // top-level operatoros compression tuning is a DIFFERENT key and also present
    expect(yaml).toContain("compression:");
    expect(yaml).toContain("  threshold: 0.35");
  });
});

describe("approval-relay wiring", () => {
  // The hivra_approval_relay agent plugin runs inside the official-dashboard
  // container -- the one serving the workspace iframe's /api/ws, and therefore
  // the one that owns the blocking approval wait. It needs three things, and
  // all three have to reach THAT container specifically.
  it("puts HERMES_INSTANCE_ID in .env, which official-dashboard reads via env_file", () => {
    const env = buildWebUIComposeEnv(baseParams);
    expect(env).toContain("HERMES_INSTANCE_ID=inst-123");
    // Its two companions, already present -- the relay needs all three.
    expect(env).toContain("API_SERVER_KEY=webui-password");
    expect(env).toMatch(/^HERMES_DASHBOARD_URL=\S+$/m);
  });

  it("declares HERMES_INSTANCE_ID for official-dashboard, not just the gateway service", () => {
    // The gateway service gets it via its `environment:` block; official-dashboard
    // has no such entry, so .env is the only path that reaches both.
    const compose = buildWebUICompose({
      ...baseParams,
      image: "webui:test",
      agentImage: "agent:test",
    });
    const dashboardBlock = compose.slice(compose.indexOf("official-dashboard:"));
    expect(dashboardBlock).toContain("env_file: .env");
    expect(dashboardBlock).not.toContain("HERMES_INSTANCE_ID=");
  });

  it("enables the relay plugin in config.yaml (plugins are opt-in, no env override)", () => {
    const yaml = buildWebUIConfigYaml(baseParams);
    expect(yaml).toContain("plugins:");
    expect(yaml).toContain("    - observability/hivra_approval_relay");
  });

  it("parks a blocked approval for an hour instead of the agent's 300s default", () => {
    const yaml = buildWebUIConfigYaml(baseParams);
    expect(yaml).toContain("approvals:");
    expect(yaml).toContain("  gateway_timeout: 3600");
  });

  it("keeps the relay wired on clean-slate BYOK boxes", () => {
    // `unconfigured` drops the model/web blocks; approvals + plugins are
    // orthogonal to provider config and must survive.
    const yaml = buildWebUIConfigYaml({ ...baseParams, unconfigured: true });
    expect(yaml).not.toContain("model:");
    expect(yaml).toContain("  gateway_timeout: 3600");
    expect(yaml).toContain("    - observability/hivra_approval_relay");
  });
});

describe("Daytona key -> box .env", () => {
  it("emits DAYTONA_API_KEY into the agent env only when a key is saved", () => {
    const withKey = buildHermesEnvFile({ ...baseParams, daytonaApiKey: "dtn_abc123" });
    expect(withKey).toContain("DAYTONA_API_KEY=dtn_abc123");

    expect(buildHermesEnvFile(baseParams)).not.toContain("DAYTONA_API_KEY");
  });
});

describe("advanced terminal backend -> gateway runtime", () => {
  it.each([
    [undefined, false, undefined, "local"],
    ["local", true, undefined, "local"],
    ["docker", true, undefined, "docker"],
    ["docker", false, undefined, "local"],
    ["modal", false, undefined, "modal"],
    ["daytona", false, "key", "daytona"],
    ["daytona", false, undefined, "local"],
  ] as const)("keeps fresh YAML and env consistent for backend %s with Docker access %s", (terminalBackend, gatewayDockerAccess, daytonaApiKey, expected) => {
    const params = { ...baseParams, terminalBackend, gatewayDockerAccess, daytonaApiKey };
    expect(buildHermesEnvFile(params)).toContain(`TERMINAL_ENV=${expected}\n`);
    expect(buildWebUIConfigYaml(params)).toContain(`terminal:\n  backend: "${expected}"\n`);
  });

  it.each(["provision", "update"] as const)("runs the actual narrow YAML repair before compose startup for %s settings apply", (mode) => {
    const params: WebUIDeployParams = {
      ...baseParams,
      agentImage: "agent:test",
      terminalBackend: "docker",
      gatewayDockerAccess: true,
    };
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(params), params, {
      mode,
      ...(mode === "update" ? { applyTerminalBackend: true } : {}),
    });
    expect(script).toContain(WEBUI_TERMINAL_CONFIG_SYNC_PYTHON);
    expect(script).toContain("docker run --rm -i --network none --user 0:0");
    expect(script).toContain("agent:test - 'docker' /state/config.yaml /seed/config.yaml <<'HERMES_TERMINAL_CONFIG_PY'");
    const syncOffset = script.indexOf("<<'HERMES_TERMINAL_CONFIG_PY'");
    expect(syncOffset).toBeGreaterThan(script.indexOf("docker pull agent:test"));
    expect(syncOffset).toBeLessThan(script.indexOf("timeout 180s docker compose up -d"));
  });

  it("preserves native backend choices on ordinary image updates, redeploys and recovery", () => {
    const params = { ...baseParams, terminalBackend: "local" as const, gatewayDockerAccess: true };
    const artifacts = buildWebUIProvisioningArtifacts(params);
    for (const applyTerminalBackend of [undefined, false]) {
      const script = buildWebUIBootstrapScript(artifacts, params, { mode: "update", applyTerminalBackend });
      expect(script).not.toContain("HERMES_TERMINAL_CONFIG_PY");
      expect(script).not.toContain(WEBUI_TERMINAL_CONFIG_SYNC_PYTHON);
      expect(script).toContain("cp /state/config.yaml /seed/config.yaml");
    }
  });

  it("defaults to local execution and disables strict sandbox enforcement", () => {
    const envFile = buildHermesEnvFile(baseParams);

    expect(envFile).toContain("TERMINAL_ENV=local");
    expect(envFile).toContain("TERMINAL_STRICT_BACKEND=false");
  });

  it("applies Docker only when this dedicated VM also exposes its guest socket", () => {
    const enabled = buildHermesEnvFile({
      ...baseParams,
      terminalBackend: "docker",
      gatewayDockerAccess: true,
    });
    expect(enabled).toContain("TERMINAL_ENV=docker");
    expect(enabled).toContain("TERMINAL_STRICT_BACKEND=true");

    const failClosed = buildHermesEnvFile({
      ...baseParams,
      terminalBackend: "docker",
      gatewayDockerAccess: false,
    });
    expect(failClosed).toContain("TERMINAL_ENV=local");
    expect(failClosed).toContain("TERMINAL_STRICT_BACKEND=false");
  });

  it("applies cloud sandboxes without Docker access and rejects keyless Daytona", () => {
    const modal = buildHermesEnvFile({ ...baseParams, terminalBackend: "modal" });
    expect(modal).toContain("TERMINAL_ENV=modal");
    expect(modal).toContain("TERMINAL_STRICT_BACKEND=true");

    const daytona = buildHermesEnvFile({
      ...baseParams,
      terminalBackend: "daytona",
      daytonaApiKey: "dtn_abc123",
    });
    expect(daytona).toContain("TERMINAL_ENV=daytona");
    expect(daytona).toContain("TERMINAL_STRICT_BACKEND=true");

    const keyless = buildHermesEnvFile({ ...baseParams, terminalBackend: "daytona" });
    expect(keyless).toContain("TERMINAL_ENV=local");
    expect(keyless).toContain("TERMINAL_STRICT_BACKEND=false");
  });

  it("repairs both backend values during update-mode redeploys", () => {
    expect(WEBUI_MANAGED_RUNTIME_ENV_KEYS).toEqual(
      expect.arrayContaining(["TERMINAL_ENV", "TERMINAL_STRICT_BACKEND"]),
    );

    const params: WebUIDeployParams = {
      ...baseParams,
      terminalBackend: "docker",
      gatewayDockerAccess: true,
    };
    const artifacts = buildWebUIProvisioningArtifacts(params);
    const script = buildWebUIBootstrapScript(artifacts, params, { mode: "update" });

    expect(artifacts.hermesEnvFile).toContain("TERMINAL_ENV=docker");
    expect(artifacts.hermesEnvFile).toContain("TERMINAL_STRICT_BACKEND=true");
    expect(script).toContain("TERMINAL_ENV TERMINAL_STRICT_BACKEND");
  });
});

describe("managed runtime env keys — fleet clobber guard", () => {
  it("never emits a managed key with an empty or placeholder value when unset", () => {
    // The update path repairs every WEBUI_MANAGED_RUNTIME_ENV_KEYS entry into the
    // box's persisted /state/.env, skipping ONLY keys whose line is missing from
    // the generated env (`[ -n "$managed_env_line" ] || continue`). An
    // unconditionally-emitted `KEY=` for an unset value is a present, non-empty
    // LINE — so the repair would sed a live value on every box in the fleet down
    // to an empty string. That makes conditional emission a safety precondition
    // for list membership, not a style choice: this asserts the two halves stay in
    // sync, since the danger only materialises for someone ADDING a key later.
    // baseParams sets no optional keys, so this is the everything-unset case.
    const env = buildHermesEnvFile(baseParams);

    for (const key of WEBUI_MANAGED_RUNTIME_ENV_KEYS) {
      const line = env.split("\n").find((l) => l.startsWith(`${key}=`));
      if (!line) continue; // absent -> repair skips it -> nothing to clobber

      const value = line.slice(key.length + 1);
      expect({ key, value }).toEqual({ key, value: expect.stringMatching(/.+/) });
      // A stringified undefined/null is just as destructive as an empty value —
      // it overwrites a working secret with garbage that reads as "configured".
      expect(["undefined", "null"]).not.toContain(value);
    }
  });
});

describe("clearing managed runtime env keys the user removed", () => {
  it("emits a clear pass that only fires for keys absent from the generated env", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });

    expect(script).toContain(`clearable_env_keys='${WEBUI_CLEARABLE_RUNTIME_ENV_KEYS.join(" ")}'`);
    // A key still present in the generated env must be left to the upsert pass —
    // the `continue` is what stops this from deleting live values every redeploy.
    expect(script).toContain('if grep -q "^${clearable_env_key}=" /tmp/hermes-generated.env; then');
    expect(script).toContain('sed -i "/^${clearable_env_key}=/d" "$webui_env_tmp"');
  });

  it("does not put BANKR_* anywhere near the clear pass", () => {
    const artifacts = buildWebUIProvisioningArtifacts(baseParams);
    const script = buildWebUIBootstrapScript(artifacts, baseParams, { mode: "update" });
    const clearLine = script
      .split("\n")
      .find((l) => l.startsWith("clearable_env_keys="));

    expect(clearLine).toBeDefined();
    expect(clearLine).not.toContain("BANKR");
  });
});
