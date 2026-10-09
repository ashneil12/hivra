import {
  buildWebUIBootstrapScript,
  buildWebUIProvisioningArtifacts,
  type WebUIDeployParams,
} from "@/lib/services/webui-instance-builder";

const params: WebUIDeployParams = {
  instanceId: "inst-nofork-1",
  containerName: "agent-inst-nofork-1",
  fqdn: "agent.example.com",
  cpuLimit: 2,
  ramLimit: 4096,
  llmApiKey: "k".repeat(24),
  inferenceProvider: "custom",
  defaultModel: "deepseek-v3.2",
  baseUrl: "https://llm.example.com/v1",
  webuiPassword: "webui-password",
  agentImage: "hivra-local/hermes:stable",
};

describe("a control-plane update of a box that follows upstream Hermes", () => {
  const script = buildWebUIBootstrapScript(buildWebUIProvisioningArtifacts(params), params, {
    mode: "update",
    imagePolicy: { kind: "keep" },
  });

  it("reseeds the agent source from the box's own image and lays the box's overlay files over it", () => {
    expect(script).toContain('[ -d /opt/hermes/instances/inst-nofork-1/overlay/files ] && echo "-v /opt/hermes/instances/inst-nofork-1/overlay:/overlay:ro"');
    expect(script).toContain("if [ -d /overlay/files ]; then cp -a /overlay/files/. /target/; fi");
    // the overlay is copied after the image's own tree, so the image can never overwrite it
    expect(script.indexOf("cp -a /opt/hermes/. /target/")).toBeLessThan(script.indexOf("cp -a /overlay/files/. /target/"));
  });

  it("never tries to pull the local-only image from a registry", () => {
    expect(script).toContain("docker image inspect hivra-local/hermes:stable >/dev/null 2>&1 || docker pull hivra-local/hermes:stable");
    // the only pull is the fallback after "the local copy is gone"
    expect(script.match(/docker pull hivra-local\/hermes:stable/g)).toHaveLength(1);
  });
});
