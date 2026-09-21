jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  resolveProxmoxHostEnv: jest.fn((_hostConfig, env) => ({
    ...env,
    PROXMOX_SSH_HOST: "198.51.100.2",
    HERMES_PROXMOX_HOST_ENV_RESOLVED: "true",
  })),
}));

import { supabaseAdmin } from "@/lib/supabase";
import { resolveProxmoxHostEnv, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import * as sshModule from "@/lib/hetzner/ssh";

const {
  ensureManagedHostFingerprint,
  lookupManagedHostFingerprint,
  persistManagedHostFingerprint,
} = sshModule;

type QueryResult = { data?: unknown; error: { message: string } | null };

function makeSelectBuilder(result: QueryResult, needsNeq = false) {
  return {
    eq: jest.fn().mockReturnValue(
      needsNeq
        ? { neq: jest.fn().mockResolvedValue(result) }
        : Promise.resolve(result)
    ),
  };
}

function makeUpdateBuilder(result: QueryResult, needsNeq = false) {
  return {
    eq: jest.fn().mockReturnValue(
      needsNeq
        ? { neq: jest.fn().mockResolvedValue(result) }
        : Promise.resolve(result)
    ),
  };
}

describe("SSH fingerprint schema compatibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PROXMOX_SSH_HOST;
    delete process.env.PROXMOX_PRIVATE_SUBNET_PREFIX;
    delete process.env.PROXMOX_VM_SSH_USER;
    delete process.env.PROXMOX_VM_SSH_KEY_PATH;
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.PROXMOX_FIXTURENODE2_PRIVATE_SUBNET_PREFIX;
    delete process.env.PROXMOX_FIXTURENODE2_VM_SSH_USER;
    delete process.env.PROXMOX_FIXTURENODE2_VM_SSH_KEY_PATH;
  });

  it("routes Proxmox private guest IP commands through the Proxmox host bastion", async () => {
    process.env.PROXMOX_SSH_HOST = "203.0.113.10";
    process.env.PROXMOX_PRIVATE_SUBNET_PREFIX = "10.250.20";
    process.env.PROXMOX_VM_SSH_USER = "hermes";
    process.env.PROXMOX_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";

    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    await expect(
      sshModule.sshExec("10.250.20.50", "docker ps", { timeoutMs: 8_000 })
    ).resolves.toEqual({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    expect(runProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining('"$VM_SSH_USER@$PRIVATE_IP"'),
      process.env,
      8_000
    );
    const script = (runProxmoxHostScript as jest.Mock).mock.calls[0][0] as string;
    expect(script).toContain("PRIVATE_IP='10.250.20.50'");
    expect(script).toContain("VM_SSH_USER='hermes'");
    expect(script).toContain("VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
    expect(script).toContain("-o LogLevel=ERROR");
    expect(script).toContain('"sudo bash -s"');
  });

  it("uses the instance Proxmox host routing metadata when provided for private guest SSH", async () => {
    process.env.PROXMOX_SSH_HOST = "203.0.113.10";
    process.env.PROXMOX_PRIVATE_SUBNET_PREFIX = "10.250.20";
    process.env.PROXMOX_VM_SSH_USER = "hermes";
    process.env.PROXMOX_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";

    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    const options = {
      timeoutMs: 8_000,
      proxmoxHostConfig: { hostId: "host-fixturenode2", hostSlug: "fixturenode2", failClosed: true },
    } as Parameters<typeof sshModule.sshExec>[2] & {
      proxmoxHostConfig: { hostId: string; hostSlug: string; failClosed: boolean };
    };

    await expect(
      sshModule.sshExec("10.250.20.50", "docker ps", options)
    ).resolves.toEqual({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    expect(resolveProxmoxHostEnv).toHaveBeenCalledWith(
      { hostId: "host-fixturenode2", hostSlug: "fixturenode2", failClosed: true },
      process.env
    );
    expect(runProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("PRIVATE_IP='10.250.20.50'"),
      expect.objectContaining({
        PROXMOX_SSH_HOST: "198.51.100.2",
        HERMES_PROXMOX_HOST_ENV_RESOLVED: "true",
      }),
      8_000
    );
  });

  it("infers the Proxmox host from host-specific private subnet env when only a guest IP is provided", async () => {
    delete process.env.PROXMOX_SSH_HOST;
    delete process.env.PROXMOX_PRIVATE_SUBNET_PREFIX;
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode2,fixturenode3";
    process.env.PROXMOX_FIXTURENODE2_PRIVATE_SUBNET_PREFIX = "10.250.21";
    process.env.PROXMOX_FIXTURENODE2_VM_SSH_USER = "hermes";
    process.env.PROXMOX_FIXTURENODE2_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";

    (resolveProxmoxHostEnv as jest.Mock).mockImplementationOnce((_hostConfig, env) => ({
      ...env,
      PROXMOX_SSH_HOST: "198.51.100.134",
      PROXMOX_VM_SSH_USER: env.PROXMOX_FIXTURENODE2_VM_SSH_USER,
      PROXMOX_VM_SSH_KEY_PATH: env.PROXMOX_FIXTURENODE2_VM_SSH_KEY_PATH,
      HERMES_PROXMOX_HOST_ENV_RESOLVED: "true",
    }));
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    expect(sshModule.isProxmoxPrivateGuestIp("10.250.21.52")).toBe(true);
    await expect(
      sshModule.sshExec("10.250.21.52", "docker ps", { timeoutMs: 8_000 })
    ).resolves.toEqual({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    expect(resolveProxmoxHostEnv).toHaveBeenCalledWith(
      { hostSlug: "fixturenode2", failClosed: true },
      process.env
    );
    const script = (runProxmoxHostScript as jest.Mock).mock.calls[0][0] as string;
    expect(script).toContain("PRIVATE_IP='10.250.21.52'");
    expect(script).toContain("VM_SSH_USER='hermes'");
    expect(script).toContain("VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
  });

  it("routes through Proxmox when explicit host metadata is present even without ambient fixturenode1 env", async () => {
    delete process.env.PROXMOX_SSH_HOST;
    delete process.env.PROXMOX_PRIVATE_SUBNET_PREFIX;
    process.env.PROXMOX_VM_SSH_USER = "hermes";
    process.env.PROXMOX_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";

    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    const options = {
      timeoutMs: 8_000,
      proxmoxHostConfig: { hostId: "host-fixturenode2", hostSlug: "fixturenode2", failClosed: true },
    } as Parameters<typeof sshModule.sshExec>[2] & {
      proxmoxHostConfig: { hostId: string; hostSlug: string; failClosed: boolean };
    };

    await expect(
      sshModule.sshExec("10.250.30.80", "docker ps", options)
    ).resolves.toEqual({
      ok: true,
      stdout: "ok\n",
      stderr: "",
    });

    expect(runProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("PRIVATE_IP='10.250.30.80'"),
      expect.objectContaining({
        PROXMOX_SSH_HOST: "198.51.100.2",
        HERMES_PROXMOX_HOST_ENV_RESOLVED: "true",
      }),
      8_000
    );
  });

  it("keeps public Hetzner IP commands on the direct SSH path when Proxmox is configured", async () => {
    process.env.PROXMOX_SSH_HOST = "203.0.113.10";
    process.env.PROXMOX_PRIVATE_SUBNET_PREFIX = "10.250.20";

    const previousPrivateKey = process.env.HETZNER_SSH_PRIVATE_KEY_B64;
    const previousKeyPath = process.env.HETZNER_SSH_KEY_PATH;
    delete process.env.HETZNER_SSH_PRIVATE_KEY_B64;
    process.env.HETZNER_SSH_KEY_PATH = "/tmp/hermes-missing-test-key";

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => ({
      select: jest.fn(() =>
        makeSelectBuilder(
          {
            data: [],
            error: null,
          },
          table === "hermes_instances"
        )
      ),
    }));

    try {
      const result = await sshModule.sshExec("198.51.100.12", "docker ps", {
        timeoutMs: 8_000,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("No SSH private key configured");
      expect(runProxmoxHostScript).not.toHaveBeenCalled();
    } finally {
      if (previousPrivateKey === undefined) {
        delete process.env.HETZNER_SSH_PRIVATE_KEY_B64;
      } else {
        process.env.HETZNER_SSH_PRIVATE_KEY_B64 = previousPrivateKey;
      }

      if (previousKeyPath === undefined) {
        delete process.env.HETZNER_SSH_KEY_PATH;
      } else {
        process.env.HETZNER_SSH_KEY_PATH = previousKeyPath;
      }
    }
  });

  it("falls back to ID-only managed-host detection when fingerprint columns are missing", async () => {
    const hostSelects: string[] = [];
    const instanceSelects: string[] = [];

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn((columns: string) => {
            hostSelects.push(columns);
            return makeSelectBuilder(
              columns.includes("ssh_host_fingerprint_sha256")
                ? {
                    data: null,
                    error: {
                      message:
                        'column hermes_hosts.ssh_host_fingerprint_sha256 does not exist',
                    },
                  }
                : {
                    data: [{ id: "host_1" }],
                    error: null,
                  }
            );
          }),
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn((columns: string) => {
            instanceSelects.push(columns);
            return makeSelectBuilder(
              columns.includes("ssh_host_fingerprint_sha256")
                ? {
                    data: null,
                    error: {
                      message:
                        'column hermes_instances.ssh_host_fingerprint_sha256 does not exist',
                    },
                  }
                : {
                    data: [],
                    error: null,
                  },
              true
            );
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    await expect(lookupManagedHostFingerprint("203.0.113.4")).resolves.toEqual({
      managed: true,
      fingerprint: null,
    });
    expect(hostSelects).toEqual(["id, ssh_host_fingerprint_sha256", "id"]);
    expect(instanceSelects).toEqual(["id, ssh_host_fingerprint_sha256", "id"]);
  });

  it("keeps a valid host fingerprint when only the legacy instances table is missing the column", async () => {
    const hostSelects: string[] = [];
    const instanceSelects: string[] = [];

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn((columns: string) => {
            hostSelects.push(columns);
            return makeSelectBuilder({
              data: [{ id: "host_1", ssh_host_fingerprint_sha256: "a".repeat(64) }],
              error: null,
            });
          }),
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn((columns: string) => {
            instanceSelects.push(columns);
            return makeSelectBuilder(
              columns.includes("ssh_host_fingerprint_sha256")
                ? {
                    data: null,
                    error: {
                      message:
                        "column hermes_instances.ssh_host_fingerprint_sha256 does not exist",
                    },
                  }
                : {
                    data: [],
                    error: null,
                  },
              true
            );
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    await expect(lookupManagedHostFingerprint("203.0.113.4")).resolves.toEqual({
      managed: true,
      fingerprint: "a".repeat(64),
    });
    expect(hostSelects).toEqual(["id, ssh_host_fingerprint_sha256"]);
    expect(instanceSelects).toEqual(["id, ssh_host_fingerprint_sha256", "id"]);
  });

  it("keeps a valid legacy instance fingerprint when only the hosts table is missing the column", async () => {
    const hostSelects: string[] = [];
    const instanceSelects: string[] = [];

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn((columns: string) => {
            hostSelects.push(columns);
            return makeSelectBuilder(
              columns.includes("ssh_host_fingerprint_sha256")
                ? {
                    data: null,
                    error: {
                      message:
                        "column hermes_hosts.ssh_host_fingerprint_sha256 does not exist",
                    },
                  }
                : {
                    data: [{ id: "host_1" }],
                    error: null,
                  }
            );
          }),
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn((columns: string) => {
            instanceSelects.push(columns);
            return makeSelectBuilder(
              {
                data: [{ id: "instance_1", ssh_host_fingerprint_sha256: "b".repeat(64) }],
                error: null,
              },
              true
            );
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    await expect(lookupManagedHostFingerprint("203.0.113.4")).resolves.toEqual({
      managed: true,
      fingerprint: "b".repeat(64),
    });
    expect(hostSelects).toEqual(["id, ssh_host_fingerprint_sha256", "id"]);
    expect(instanceSelects).toEqual(["id, ssh_host_fingerprint_sha256"]);
  });

  it("treats missing fingerprint columns as a no-op during persistence", async () => {
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          update: jest.fn(() =>
            makeUpdateBuilder({
              error: {
                message:
                  "column hermes_hosts.ssh_host_fingerprint_sha256 does not exist",
              },
            })
          ),
        };
      }

      if (table === "hermes_instances") {
        return {
          update: jest.fn(() =>
            makeUpdateBuilder(
              {
                error: {
                  message:
                    "column hermes_instances.ssh_host_fingerprint_sha256 does not exist",
                },
              },
              true
            )
          ),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    await expect(
      persistManagedHostFingerprint("203.0.113.4", "a".repeat(64))
    ).resolves.toBeUndefined();
  });

  it("still throws on unrelated Supabase lookup errors", async () => {
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        return {
          select: jest.fn(() =>
            makeSelectBuilder({
              data: null,
              error: { message: "permission denied for table hermes_hosts" },
            })
          ),
        };
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn(() =>
            makeSelectBuilder(
              {
                data: [],
                error: null,
              },
              true
            )
          ),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    await expect(lookupManagedHostFingerprint("203.0.113.4")).rejects.toThrow(
      "Failed to look up managed host fingerprint: permission denied for table hermes_hosts"
    );
  });

  it("refreshes a managed host fingerprint when no env pin exists", async () => {
    const persistSpy = jest.fn().mockResolvedValue(undefined);

    await expect(
      sshModule.refreshManagedHostFingerprint("203.0.113.4", {
        getExpectedHostFingerprint: () => null,
        lookupManagedHostFingerprint: async () => ({
          managed: true,
          fingerprint: "a".repeat(64),
        }),
        captureHostFingerprint: async () => "b".repeat(64),
        persistManagedHostFingerprint: persistSpy,
      })
    ).resolves.toBe("b".repeat(64));
    expect(persistSpy).toHaveBeenCalledWith("203.0.113.4", "b".repeat(64));
  });

  it("skips fingerprint refresh when an explicit env pin exists", async () => {
    const captureSpy = jest.fn();

    await expect(
      sshModule.refreshManagedHostFingerprint("203.0.113.4", {
        getExpectedHostFingerprint: () => "a".repeat(64),
        captureHostFingerprint: captureSpy,
      })
    ).resolves.toBeNull();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("passes the caller timeout through when refreshing a managed host fingerprint", async () => {
    const captureSpy = jest.fn().mockResolvedValue("b".repeat(64));
    const persistSpy = jest.fn().mockResolvedValue(undefined);

    await expect(
      sshModule.refreshManagedHostFingerprint(
        "203.0.113.4",
        {
          getExpectedHostFingerprint: () => null,
          lookupManagedHostFingerprint: async () => ({
            managed: true,
            fingerprint: null,
          }),
          captureHostFingerprint: captureSpy,
          persistManagedHostFingerprint: persistSpy,
        },
        30_000
      )
    ).resolves.toBe("b".repeat(64));

    expect(captureSpy).toHaveBeenCalledWith("203.0.113.4", 30_000);
    expect(persistSpy).toHaveBeenCalledWith("203.0.113.4", "b".repeat(64));
  });

  it("reuses an already stored managed host fingerprint without recapturing it", async () => {
    const captureSpy = jest.fn();
    const ip = "198.51.100.8";

    await expect(
      ensureManagedHostFingerprint(ip, {
        getExpectedHostFingerprint: () => null,
        lookupManagedHostFingerprint: async () => ({
          managed: true,
          fingerprint: "a".repeat(64),
        }),
        captureHostFingerprint: captureSpy,
      })
    ).resolves.toBe("a".repeat(64));

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("captures and persists a missing managed host fingerprint before later SSH calls need it", async () => {
    const captureSpy = jest.fn().mockResolvedValue("b".repeat(64));
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const ip = "198.51.100.9";

    await expect(
      ensureManagedHostFingerprint(
        ip,
        {
          getExpectedHostFingerprint: () => null,
          lookupManagedHostFingerprint: async () => ({
            managed: true,
            fingerprint: null,
          }),
          captureHostFingerprint: captureSpy,
          persistManagedHostFingerprint: persistSpy,
        },
        20_000
      )
    ).resolves.toBe("b".repeat(64));

    expect(captureSpy).toHaveBeenCalledWith(ip, 20_000);
    expect(persistSpy).toHaveBeenCalledWith(ip, "b".repeat(64));
  });
});
