/** @jest-environment node */

jest.mock("server-only", () => ({}));

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
