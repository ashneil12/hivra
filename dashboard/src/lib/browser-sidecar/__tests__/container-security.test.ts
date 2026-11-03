import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import {
  BROWSER_SIDECAR_SECCOMP_FILE,
  browserSidecarSeccompProfileJson,
} from "@/lib/browser-sidecar/container-security";
import {
  buildWebUIBootstrapScript,
  buildWebUICompose,
  buildWebUIProvisioningArtifacts,
  type WebUIDeployParams,
} from "@/lib/services/webui-instance-builder";

// The browser sidecar's Chromium runs with its sandbox ON and never falls back
// to --no-sandbox, so the box must give the container a seccomp profile that
// allows Chromium's user namespaces. Without it the agent's browser does not
// start at all (the sidecar's /health turns 503).

const params: WebUIDeployParams = {
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
const images = { image: "ghcr.io/ashneil12/hermes-webui:stable", agentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest" };
const sidecarProfilePath = join(__dirname, "..", "..", "..", "..", "..", "services", "browser-sidecar", "docker", "seccomp-chromium.json");

function sidecarService(compose: string): Record<string, unknown> | undefined {
  return (load(compose) as { services: Record<string, Record<string, unknown>> }).services["browser-sidecar"];
}

describe("browser sidecar container security", () => {
  it("keeps the dashboard's seccomp profile identical to the sidecar image's", () => {
    expect(JSON.parse(browserSidecarSeccompProfileJson())).toEqual(
      JSON.parse(readFileSync(sidecarProfilePath, "utf8"))
    );
    expect(readFileSync(join(__dirname, "..", "seccomp-chromium.json"), "utf8")).toBe(
      readFileSync(sidecarProfilePath, "utf8")
    );
  });

  it("gives the sidecar the Chromium seccomp profile and no-new-privileges, and nothing broader", () => {
    const service = sidecarService(buildWebUICompose({ ...params, ...images, browserSidecarEnabled: true }))!;
    expect(service.security_opt).toEqual([
      `seccomp=/opt/hermes/instances/inst-123/${BROWSER_SIDECAR_SECCOMP_FILE}`,
      "no-new-privileges:true",
    ]);
    expect(service.privileged).toBeUndefined();
    expect(service.cap_add).toBeUndefined();
    expect(JSON.stringify(service.security_opt)).not.toMatch(/unconfined/);
  });

  it("writes the profile beside the compose before compose starts the sidecar", () => {
    const p = { ...params, browserSidecarEnabled: true };
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(p), p, { mode: "update" });
    const write = script.indexOf(`cat > ${BROWSER_SIDECAR_SECCOMP_FILE} <<'__HERMES_EOF__'\n`);
    const composeUp = script.indexOf("docker compose up -d");
    expect(write).toBeGreaterThan(script.indexOf('cd "$INSTANCE_DIR"'));
    expect(composeUp).toBeGreaterThan(write);
    const body = script.slice(write).split("\n__HERMES_EOF__")[0].split("\n").slice(1).join("\n");
    expect(JSON.parse(body)).toEqual(JSON.parse(readFileSync(sidecarProfilePath, "utf8")));
  });

  it("emits no sidecar security settings and removes a stale profile when the sidecar is off", () => {
    const p = { ...params, browserSidecarEnabled: false };
    expect(sidecarService(buildWebUICompose({ ...p, ...images }))).toBeUndefined();
    const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(p), p, { mode: "update" });
    expect(script).toContain(`rm -f ${BROWSER_SIDECAR_SECCOMP_FILE}\n`);
    expect(script).not.toContain(`cat > ${BROWSER_SIDECAR_SECCOMP_FILE}`);
  });
});
