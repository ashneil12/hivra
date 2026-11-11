/** @jest-environment node */

jest.mock("server-only", () => ({}));

jest.mock("../home-connector", () => ({ userOwnsActiveConnector: jest.fn() }));

import { userOwnsActiveConnector } from "../home-connector";
import {
  buildUserProxmoxEnvironment,
  InfrastructureNetworkError,
  resolveValidatedSshDestination,
} from "../connection-runtime";

describe("resolveValidatedSshDestination", () => {
  it("resolves a public hostname once and returns the checked socket address", async () => {
    const lookup = jest.fn().mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);

    await expect(
      resolveValidatedSshDestination("pve.example.test", { lookup }),
    ).resolves.toEqual({
      hostname: "pve.example.test",
      address: "203.0.113.10",
      family: 4,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    const lookup = jest.fn().mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "10.240.0.5", family: 4 },
    ]);

    await expect(
      resolveValidatedSshDestination("mixed.example.test", { lookup }),
    ).rejects.toMatchObject<Partial<InfrastructureNetworkError>>({
      code: "ssh_host_forbidden",
    });
  });

  it("allows RFC1918 targets only when the self-hosted operator explicitly opts in", async () => {
    await expect(
      resolveValidatedSshDestination("10.240.0.5", {
        env: { HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS: "true" },
      }),
    ).resolves.toMatchObject({ address: "10.240.0.5", family: 4 });
  });

  it.each(["127.0.0.1", "169.254.169.254", "::1", "fe80::1"])(
    "always rejects local or metadata destination %s",
    async (address) => {
      await expect(
        resolveValidatedSshDestination(address, {
          env: { HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS: "true" },
        }),
      ).rejects.toMatchObject<Partial<InfrastructureNetworkError>>({
        code: "ssh_host_forbidden",
      });
    },
  );

  it.each([
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "0:0:0:0:0:ffff:a9fe:a9fe",
  ])("always rejects mapped loopback or link-local destination %s", async (address) => {
    await expect(
      resolveValidatedSshDestination(address, {
        env: { HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS: "true" },
      }),
    ).rejects.toMatchObject<Partial<InfrastructureNetworkError>>({
      code: "ssh_host_forbidden",
    });
  });

  it("allows a fully expanded mapped RFC1918 address only with the private-network opt-in", async () => {
    const mappedPrivate = "0:0:0:0:0:ffff:a00:1";
    await expect(resolveValidatedSshDestination(mappedPrivate)).rejects.toMatchObject({
      code: "ssh_host_forbidden",
    });
    await expect(
      resolveValidatedSshDestination(mappedPrivate, {
        env: { HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS: "true" },
      }),
    ).resolves.toMatchObject({ address: mappedPrivate, family: 6 });
  });

  it("rejects a DNS answer containing a fully expanded mapped loopback", async () => {
    const lookup = jest.fn().mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "0:0:0:0:0:ffff:7f00:1", family: 6 },
    ]);

    await expect(
      resolveValidatedSshDestination("mapped.example.test", {
        lookup,
        env: { HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS: "true" },
      }),
    ).rejects.toMatchObject({ code: "ssh_host_forbidden" });
  });

  it("returns a stable unresolvable error without exposing resolver details", async () => {
    const lookup = jest.fn().mockRejectedValue(new Error("internal resolver detail"));

    await expect(
      resolveValidatedSshDestination("missing.example.test", { lookup }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "ssh_host_unresolvable",
        message: "SSH host could not be resolved.",
      }),
    );
  });
});

describe("buildUserProxmoxEnvironment", () => {
  it("builds a fresh, fail-closed SSH environment without ambient fleet values", () => {
    const env = buildUserProxmoxEnvironment(
      {
        id: "connection-1",
        sshHost: "pve.example.test",
        sshPort: 2222,
        sshUser: "root",
        sshHostFingerprintSha256: "ab".repeat(32),
        sshPrivateKey: "private-key",
        node: "pve",
        templateId: 9000,
        vmidStart: 300,
        vmidEnd: 399,
      },
      { hostname: "pve.example.test", address: "203.0.113.10", family: 4 },
    );

    expect(env).toEqual({
      HIVRA_USER_INFRA_CONNECTION: "true",
      HERMES_PROXMOX_TARGET_ENV_RESOLVED: "true",
      PROXMOX_EXEC_MODE: "ssh",
      PROXMOX_ALLOW_SSH_AGENT: "false",
      PROXMOX_SSH_HOST: "203.0.113.10",
      PROXMOX_SSH_PORT: "2222",
      PROXMOX_SSH_USER: "root",
      PROXMOX_SSH_PRIVATE_KEY: "private-key",
      PROXMOX_SSH_HOST_FINGERPRINT: "ab".repeat(32),
      PROXMOX_NODE: "pve",
      PROXMOX_TEMPLATE_ID: "9000",
      PROXMOX_VMID_START: "300",
      PROXMOX_VMID_END: "399",
    });
    expect(env).not.toHaveProperty("PROXMOX_SSH_KEY_PATH");
    expect(env).not.toHaveProperty("PROXMOX_API_TOKEN");
  });
});

describe("a machine reached through the home connector", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const NAME = `${ID}.connector.hivra.invalid`;
  const ON = { HIVRA_HOME_CONNECTOR_ENABLED: "true", HOST_RELAY_URL: "https://relay.example.test", HOST_RELAY_SECRET: "test-relay-secret-with-at-least-32-characters" };

  it("is refused by default and never resolved through DNS", async () => {
    const lookup = jest.fn();
    await expect(resolveValidatedSshDestination(NAME, { env: {}, lookup })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    await expect(resolveValidatedSshDestination(NAME, { env: { HIVRA_HOME_CONNECTOR_ENABLED: "true" }, lookup })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("is accepted only as the reserved name, when the flag and relay are on, for the user who owns it", async () => {
    const lookup = jest.fn();
    (userOwnsActiveConnector as jest.Mock).mockResolvedValue(true);
    await expect(resolveValidatedSshDestination(NAME, { env: ON, lookup, userId: "owner" })).resolves.toEqual({ hostname: NAME, address: NAME, family: 0, connectorId: ID });
    expect(userOwnsActiveConnector).toHaveBeenCalledWith("owner", ID);
    await expect(resolveValidatedSshDestination("bad.connector.hivra.invalid", { env: ON, lookup, userId: "owner" })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses another user's connector, an unknown caller, and a failed ownership check", async () => {
    const owns = userOwnsActiveConnector as jest.Mock;
    owns.mockResolvedValue(false);
    await expect(resolveValidatedSshDestination(NAME, { env: ON, userId: "someone-else" })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    owns.mockClear();
    owns.mockResolvedValue(true);
    await expect(resolveValidatedSshDestination(NAME, { env: ON })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    expect(owns).not.toHaveBeenCalled();
    owns.mockRejectedValue(new Error("db down"));
    await expect(resolveValidatedSshDestination(NAME, { env: ON, userId: "owner" })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
  });

  it("does not weaken private address refusal, with or without the flag", async () => {
    await expect(resolveValidatedSshDestination("192.168.1.20", { env: ON })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    await expect(resolveValidatedSshDestination("10.0.0.4", { env: ON })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
    await expect(resolveValidatedSshDestination("127.0.0.1", { env: { ...ON, HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS: "true" } })).rejects.toMatchObject({ code: "ssh_host_forbidden" });
  });

  it("marks the SSH environment for the relay transport and keeps the pinned fingerprint", () => {
    const env = buildUserProxmoxEnvironment({
      id: "c1", sshHost: NAME, sshPort: 22, sshUser: "root",
      sshHostFingerprintSha256: "SHA256:" + "A".repeat(43), sshPrivateKey: "key",
    }, { hostname: NAME, address: NAME, family: 0, connectorId: ID });
    expect(env).toMatchObject({ PROXMOX_SSH_HOST: NAME, PROXMOX_SSH_TRANSPORT: "connector", PROXMOX_SSH_CONNECTOR_ID: ID });
    expect(env.PROXMOX_SSH_HOST_FINGERPRINT).toBeTruthy();
  });

  it("leaves an ordinary host's environment unchanged", () => {
    const env = buildUserProxmoxEnvironment({
      id: "c1", sshHost: "pve.example.test", sshPort: 22, sshUser: "root",
      sshHostFingerprintSha256: "SHA256:" + "A".repeat(43), sshPrivateKey: "key",
    }, { hostname: "pve.example.test", address: "203.0.113.10", family: 4 });
    expect(env.PROXMOX_SSH_TRANSPORT).toBeUndefined();
  });
});
