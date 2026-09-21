import {
  buildWebUICaddyAuthMigrationProbeCommand,
  buildWebUICaddyAuthMigrationRemoteScript,
  isWebUICaddyAuthFullyMigrated,
} from "../../scripts/migrate-webui-caddy-auth";

describe("migrate-webui-caddy-auth", () => {
  it("does not treat Caddy bearer auth as fully migrated while legacy WebUI password env remains", () => {
    expect(
      isWebUICaddyAuthFullyMigrated("CADDY_MIGRATED\nWEBUI_PASSWORD_PRESENT\n")
    ).toBe(false);
    expect(
      isWebUICaddyAuthFullyMigrated("CADDY_MIGRATED\nWEBUI_PASSWORD_ABSENT\n")
    ).toBe(true);
  });

  it("probes both Caddy auth and the retired password env before skipping an instance", () => {
    const probe = buildWebUICaddyAuthMigrationProbeCommand({
      instanceId: "inst_123",
      containerName: "agent-inst_123",
    });

    expect(probe).toContain("@authBearer header Authorization");
    expect(probe).toContain("HERMES_WEBUI_PASSWORD");
    expect(probe).toContain("docker volume inspect agent-inst_123_webui-state");
    expect(probe).toContain("WEBUI_PASSWORD_PRESENT");
  });

  it("removes HERMES_WEBUI_PASSWORD from both compose env and persisted WebUI state", () => {
    const remoteScript = buildWebUICaddyAuthMigrationRemoteScript({
      instanceId: "inst_123",
      containerName: "agent-inst_123",
      caddyfileBase64: "Y2FkZHk=",
    });

    expect(remoteScript).toContain("docker volume inspect agent-inst_123_webui-state");
    expect(remoteScript).toContain("sed -i '/^HERMES_WEBUI_PASSWORD=/d' \"$ENVF\"");
    expect(remoteScript).toContain("sed -i '/^HERMES_WEBUI_PASSWORD=/d' \"$STATE_ENVF\"");
    expect(remoteScript).toContain("docker rm -f agent-inst_123");
  });
});
