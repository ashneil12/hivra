import { spawnSync } from "child_process";

import {
  buildWebUIBootstrapScript,
  buildWebUIProvisioningArtifacts,
  type WebUIDeployParams,
} from "../webui-instance-builder";

const REPO = "ghcr.io/example/agent";
const ALIAS = `${REPO}:stable`;
const DIGEST = `sha256:${"e".repeat(64)}`;
const REF = `${REPO}@${DIGEST}`;

const params: WebUIDeployParams = {
  instanceId: "inst-policy",
  containerName: "agent-inst-policy",
  fqdn: "agent.example.com",
  cpuLimit: 2,
  ramLimit: 4096,
  llmApiKey: "provider-key",
  inferenceProvider: "custom",
  defaultModel: "deepseek-v3.2",
  baseUrl: "https://crof.ai/v1",
  webuiPassword: "webui-password",
  agentImage: ALIAS,
};

function script(options: Parameters<typeof buildWebUIBootstrapScript>[2]) {
  return buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(params), params, options);
}

const bashSyntax = (text: string) => spawnSync("bash", ["-n"], { input: text, encoding: "utf8" });

describe("update script image policy", () => {
  const pinned = script({ mode: "update", imagePolicy: { kind: "pinned", ref: REF, digest: DIGEST } });

  it("pulls the exact release digest, aliases it, and never pulls the floating tag over it", () => {
    expect(pinned).toContain(`docker pull ${REF}`);
    expect(pinned).toContain(`docker tag ${REF} ${ALIAS}`);
    expect(pinned).not.toMatch(/^docker pull \S+:stable$/m);
    // A bare `compose pull` would re-pull the floating tag over the pin.
    expect(pinned).not.toContain("docker compose pull --ignore-pull-failures\n");
    expect(pinned).toContain("grep -vx -e gateway -e official-dashboard");
    expect(bashSyntax(pinned).status).toBe(0);
  });

  it("names the release before it pulls, so a release whose image cannot be pulled is the one blamed", () => {
    const named = pinned.indexOf(`HERMES_PINNED_DIGEST="${DIGEST}"`);
    expect(named).toBeGreaterThan(-1);
    expect(named).toBeLessThan(pinned.indexOf(`if ! docker pull ${REF}; then`));
  });

  it("fails the update when the release image cannot be pulled instead of keeping the old image", () => {
    const pull = pinned.indexOf(`if ! docker pull ${REF}; then`);
    expect(pull).toBeGreaterThan(-1);
    expect(pinned.slice(pull, pull + 400)).toContain("exit 1");
  });

  it("keeps the local image for a box the registry offers nothing newer", () => {
    const keep = script({ mode: "update", imagePolicy: { kind: "keep" } });
    expect(keep).toContain(`docker image inspect ${ALIAS} >/dev/null 2>&1 || docker pull ${ALIAS}`);
    expect(keep).not.toMatch(/^docker pull \S+:stable$/m);
    expect(keep).toContain("grep -vx -e gateway -e official-dashboard");
    expect(bashSyntax(keep).status).toBe(0);
  });

  it("follows the floating tag exactly as before when the registry does not govern the box", () => {
    const legacy = script({ mode: "update" });
    expect(legacy).toMatch(/^docker pull ghcr\.io\/example\/agent:stable$/m);
    expect(legacy).toContain("docker compose pull --ignore-pull-failures");
    expect(legacy).not.toContain("grep -vx -e gateway -e official-dashboard");
    expect(bashSyntax(legacy).status).toBe(0);
  });

  it("arms last-known-good before anything is overwritten and disarms only after the sessions check", () => {
    for (const text of [pinned, script({ mode: "update" })]) {
      const prelude = text.indexOf("hermes_update_snapshot_lkg\n");
      expect(prelude).toBeGreaterThan(-1);
      expect(prelude).toBeLessThan(text.indexOf("cat > docker-compose.yml <<'__HERMES_EOF__'"));
      // The live source is only touched after the point of no return marker.
      const touched = text.indexOf("HERMES_STACK_TOUCHED=1\ndocker run --rm");
      expect(touched).toBeGreaterThan(prelude);
      expect(touched).toBeLessThan(text.indexOf("timeout 180s docker compose up"));
      // Both success exits check the sessions before they say healthy.
      const verifies = [...text.matchAll(/hermes_update_verify \|\| exit 1\nhermes_update_commit\n\s*echo "WebUI healthy"/g)];
      expect(verifies).toHaveLength(2);
      expect(text).toContain("trap hermes_update_exit_trap EXIT");
    }
  });

  it("a fresh provision gets none of the update machinery", () => {
    const provision = script({ mode: "provision" });
    expect(provision).not.toContain("hermes_update_snapshot_lkg");
    expect(provision).not.toContain("trap hermes_update_exit_trap");
    expect(provision).not.toContain("HERMES_STACK_TOUCHED");
    expect(provision).not.toContain("hermes_update_verify");
    expect(bashSyntax(provision).status).toBe(0);
  });

  it("an operatoros or other pinned runtime image keeps its own repository for the last-known-good tag", () => {
    const other = buildWebUIBootstrapScript(
      buildWebUIProvisioningArtifacts({ ...params, agentImage: "registry.example:5000/team/agent:tag" }),
      { ...params, agentImage: "registry.example:5000/team/agent:tag" },
      { mode: "update" }
    );
    expect(other).toContain('HERMES_LKG_TAG="registry.example:5000/team/agent:hermes-last-known-good"');
  });
});
