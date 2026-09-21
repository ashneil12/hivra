import { createServer } from "@/lib/hetzner/client";
import { sshExec } from "@/lib/hetzner/ssh";
import * as webuiBuilder from "@/lib/services/webui-instance-builder";
import { provisionHetznerInstance } from "../hetzner-instance-service";

jest.mock("@/lib/hetzner/client", () => ({
  createServer: jest.fn(),
  deleteServer: jest.fn(),
  getServer: jest.fn(),
  mapHetznerStatus: jest.fn(),
  waitForAction: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
  captureHostFingerprint: jest.fn(),
}));

jest.mock("@/lib/services/hetzner-instance-builders", () => {
  const actual = jest.requireActual("@/lib/services/hetzner-instance-builders");
  return {
    ...actual,
    buildAgentDeployScript: jest.fn(() => "#!/bin/bash\necho ok\n"),
    pickServerType: jest.fn(() => "cx22"),
    renderCompressedAgentBootstrapForUserData: jest.fn(() => "compressed-bootstrap"),
    renderHostUserData: jest.fn(() => "#!/usr/bin/env bash"),
    resolveGatewayConfiguration: jest.fn(() => ({
      fqdn: "agent.example.com",
      gatewayUrl: "https://agent.example.com",
    })),
  };
});

function stringifyMockCalls(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .flat()
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .join(" ");
}

function buildBaseParams() {
  return {
    userId: "user-123",
    instanceId: "inst-123",
    cpuLimit: 2,
    ramLimit: 4096,
    name: "Agent 1",
    provider: "openai",
    apiKey: "provider-key",
    model: "gpt-5.4-mini",
    subdomain: "agent-1",
  };
}

describe("provisionHetznerInstance security hardening", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("redacts existing-host SSH failures before logging and returns a safe error", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "client_secret=super-secret",
      error: "",
    });

    const result = await provisionHetznerInstance({
      ...buildBaseParams(),
      hostId: "host-123",
      hostHetznerServerId: 1001,
      hostIp: "203.0.113.10",
    });

    const consoleOutput = stringifyMockCalls(consoleErrorSpy);

    expect(result).toEqual({
      ok: false,
      error: "Failed to deploy to the existing host.",
    });
    expect(consoleOutput).toContain("[REDACTED]");
    expect(consoleOutput).not.toContain("super-secret");

    consoleErrorSpy.mockRestore();
  });

  it("redacts provisioning failures before logging and returns a safe error", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (createServer as jest.Mock).mockRejectedValue(
      new Error("request to https://generativelanguage.googleapis.com/v1beta/models?key=super-secret failed")
    );

    const result = await provisionHetznerInstance(buildBaseParams());

    const consoleOutput = stringifyMockCalls(consoleErrorSpy);

    expect(result).toEqual({
      ok: false,
      error: "Failed to provision the Hetzner instance.",
    });
    expect(consoleOutput).toContain("key=[REDACTED]");
    expect(consoleOutput).not.toContain("super-secret");

    consoleErrorSpy.mockRestore();
  });

  it("preserves the user_data size failure signal without returning raw provider output", async () => {
    (createServer as jest.Mock).mockRejectedValue(
      new Error("user_data length 40000 exceeds 32768 bytes")
    );

    const result = await provisionHetznerInstance(buildBaseParams());

    expect(result).toEqual({
      ok: false,
      error: "Hetzner user_data length exceeds 32768 bytes.",
    });
  });

  it("deploys the WebUI backend to an existing host without starting a per-instance caddy", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok",
      stderr: "",
      error: "",
    });

    const result = await provisionHetznerInstance({
      ...buildBaseParams(),
      hostId: "host-123",
      hostHetznerServerId: 1001,
      hostIp: "203.0.113.10",
      provider: "crof",
      backend: "webui",
      agentSettings: {
        enableRootAccess: true,
        maxIterations: 60,
        toolProgressMode: "full",
        compressionThreshold: 0.5,
        sessionResetMode: "both",
      },
    });

    const deployScript = (sshExec as jest.Mock).mock.calls[0][1] as string;

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        serverId: 1001,
        hostId: "host-123",
        gatewayUrl: "https://agent.example.com",
      })
    );
    expect(deployScript).toContain("ghcr.io/ashneil12/hermes-webui:stable");
    // webui-free cutover: edge Caddy reverse-proxies the official Hermes dashboard
    // (:9119) + the dashboard sidecar (:9090, asserted below), not the legacy
    // webui app on :8787.
    expect(deployScript).toContain("reverse_proxy agent-inst-123-official-dashboard:9119");
    expect(deployScript).not.toContain("reverse_proxy agent-inst-123:8787");
    expect(deployScript).toContain("OPENAI_API_KEY=provider-key");
    expect(deployScript).toContain("docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile");
    expect(deployScript).toContain("container_name: agent-inst-123-official-dashboard");
    expect(deployScript).toContain("DASHBOARD_UPSTREAM_URL=http://agent-inst-123-official-dashboard:9119");
    expect(deployScript).toContain("reverse_proxy agent-inst-123-dashboard-sidecar:9090");
    expect(deployScript).toContain("API_SERVER_ENABLED=true");
    expect(deployScript).toContain("API_SERVER_PORT=8642");
    expect(deployScript).toContain("API_SERVER_KEY=");
    expect(deployScript).not.toContain("container_name: agent-inst-123-caddy");
    expect(deployScript).not.toContain("agent-web");
    expect(deployScript).not.toContain("HERMES_GUEST_DOCKER_GID");
    expect(sshExec).toHaveBeenCalledWith(
      "203.0.113.10",
      expect.any(String),
      { timeoutMs: 480_000 }
    );
  });

  it("passes Docker access to WebUI when provisioning an opted-in dedicated VM", async () => {
    const artifactSpy = jest.spyOn(webuiBuilder, "buildWebUIProvisioningArtifacts");
    (createServer as jest.Mock).mockRejectedValue(new Error("stop after script construction"));

    await provisionHetznerInstance({
      ...buildBaseParams(),
      backend: "webui",
      agentSettings: {
        enableRootAccess: true,
        maxIterations: 60,
        toolProgressMode: "full",
        compressionThreshold: 0.5,
        sessionResetMode: "both",
      },
    });

    expect(artifactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayDockerAccess: true,
      })
    );

    artifactSpy.mockRestore();
  });
});
