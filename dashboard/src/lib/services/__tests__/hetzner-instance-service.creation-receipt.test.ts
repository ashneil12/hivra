/**
 * F090 regression: a Hetzner server must be recorded against its instance as
 * soon as createServer returns, before the create action is awaited. Without
 * that receipt, a request killed while the action is awaited leaves a billable
 * server that no row points at.
 */

import { createServer, deleteServer, waitForAction } from "@/lib/hetzner/client";
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
  captureHostFingerprint: jest.fn().mockResolvedValue("fingerprint"),
}));

jest.mock("@/lib/services/hetzner-instance-builders", () => {
  const actual = jest.requireActual("@/lib/services/hetzner-instance-builders");
  return {
    ...actual,
    buildAgentDeployScript: jest.fn(() => "#!/bin/bash\necho ok\n"),
    pickServerType: jest.fn(() => "cx22"),
    renderCompressedAgentBootstrapForUserData: jest.fn(() => "compressed-bootstrap"),
    renderHostUserData: jest.fn(() => "#!/usr/bin/env bash"),
  };
});

jest.mock("../cloudflare-dns", () => ({
  getCloudflareDnsConfig: jest.fn(() => null),
  mintInstanceDns: jest.fn(),
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
}));

const SERVER_ID = 42;
const CREATE_ACTION_ID = 7;
const SERVER_IPV4 = "203.0.113.4";

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

describe("provisionHetznerInstance creation receipt (F090)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (createServer as jest.Mock).mockResolvedValue({
      server: { id: SERVER_ID, public_net: { ipv4: { ip: SERVER_IPV4 } } },
      action: { id: CREATE_ACTION_ID },
    });
    (deleteServer as jest.Mock).mockResolvedValue(undefined);
    (waitForAction as jest.Mock).mockResolvedValue(undefined);
  });

  it("records the new server id before it waits on the create action", async () => {
    const onServerCreated = jest.fn().mockResolvedValue(undefined);

    const result = await provisionHetznerInstance({ ...buildBaseParams(), onServerCreated });

    expect(result).toEqual(expect.objectContaining({ ok: true, serverId: SERVER_ID }));
    expect(onServerCreated).toHaveBeenCalledTimes(1);
    expect(onServerCreated).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: SERVER_ID, ipv4: SERVER_IPV4 })
    );
    expect(waitForAction).toHaveBeenCalledWith(CREATE_ACTION_ID);
    expect(onServerCreated.mock.invocationCallOrder[0]).toBeLessThan(
      (waitForAction as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it("deletes the just-created server and fails when the receipt cannot be written", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const onServerCreated = jest.fn().mockRejectedValue(new Error("db unavailable"));

    const result = await provisionHetznerInstance({ ...buildBaseParams(), onServerCreated });

    expect(result).toEqual({
      ok: false,
      error: "Failed to provision the Hetzner instance.",
    });
    expect(deleteServer).toHaveBeenCalledWith(SERVER_ID);
    expect(waitForAction).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
