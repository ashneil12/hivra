import {
  getHermesGuestSshTarget,
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  getReleasedProxmoxInfrastructure,
  isProxmoxBackedInstanceRow,
  isProxmoxReleaseSafeForDbOnlyDelete,
  resolveProxmoxLifecycleTarget,
  stripProxmoxInfrastructure,
} from "../proxmox-infrastructure";

describe("proxmox infrastructure routing", () => {
  it("uses the persisted Proxmox node as the host slug for legacy rows without hostSlug", () => {
    const infrastructure = getProxmoxInfrastructure({
      infrastructure: {
        provider: "proxmox",
        node: "fixturenode2",
        vmid: 209,
        privateIpv4: "10.250.21.59",
        gatewayHost: "00000000000000000000.hermesos.cloud",
        templateVmid: 9004,
      },
    });

    expect(infrastructure).toEqual(
      expect.objectContaining({
        node: "fixturenode2",
        vmid: 209,
      })
    );
    expect(getProxmoxHostRoutingConfigFromInfrastructure(infrastructure)).toEqual({
      hostId: null,
      hostSlug: "fixturenode2",
      envPrefix: null,
      failClosed: true,
    });
  });

  it("keeps explicit hostSlug ahead of node when both are present", () => {
    expect(
      getProxmoxHostRoutingConfigFromInfrastructure({
        node: "fixturenode2",
        hostSlug: "fixturelegacy",
      })
    ).toEqual({
      hostId: null,
      hostSlug: "fixturelegacy",
      envPrefix: null,
      failClosed: true,
    });
  });
});

describe("resolveProxmoxLifecycleTarget", () => {
  it("returns the config infrastructure when present", () => {
    const target = resolveProxmoxLifecycleTarget({
      config: {
        infrastructure: {
          provider: "proxmox",
          node: "fixturenode2",
          vmid: 209,
          privateIpv4: "10.250.21.59",
          gatewayHost: "00000000000000000000.hermesos.cloud",
        },
      },
      proxmox_node: "fixturenode2",
      proxmox_vmid: 209,
      ipv4_address: "10.250.21.59",
      gateway_url: "https://00000000000000000000.hermesos.cloud",
    });

    expect(target).toEqual(
      expect.objectContaining({
        provider: "proxmox",
        node: "fixturenode2",
        vmid: 209,
        privateIpv4: "10.250.21.59",
        gatewayHost: "00000000000000000000.hermesos.cloud",
      })
    );
  });

  it("falls back to DB columns when config.infrastructure is missing", () => {
    // Zombie repro: the row has infrastructure_provider='proxmox' and the
    // DB columns set, but config.infrastructure was never written. Without
    // this fallback the DELETE handler would silently mark the row deleted
    // and leave the VM running — exactly the bug behind the 2026-05-08 zombies.
    const target = resolveProxmoxLifecycleTarget({
      config: { agentSettings: {} },
      infrastructure_provider: "proxmox",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      ipv4_address: "10.250.20.50",
      gateway_url: "https://00000000000000000000.agents.hermesos.cloud",
    });

    expect(target).toEqual({
      provider: "proxmox",
      node: "fixturenode1",
      vmid: 200,
      privateIpv4: "10.250.20.50",
      gatewayHost: "00000000000000000000.agents.hermesos.cloud",
    });
  });

  it("returns null when neither config.infrastructure nor DB columns are sufficient", () => {
    expect(
      resolveProxmoxLifecycleTarget({
        config: null,
        proxmox_vmid: null,
        ipv4_address: null,
        gateway_url: null,
      })
    ).toBeNull();
  });

  it("returns null when proxmox_vmid is set but gateway_url is missing", () => {
    expect(
      resolveProxmoxLifecycleTarget({
        config: {},
        proxmox_node: "fixturenode1",
        proxmox_vmid: 200,
        ipv4_address: "10.250.20.50",
        gateway_url: null,
      })
    ).toBeNull();
  });

  it("normalizes gateway_url to a bare host", () => {
    const target = resolveProxmoxLifecycleTarget({
      config: {},
      proxmox_node: "fixturenode3",
      proxmox_vmid: 304,
      ipv4_address: "10.250.20.84",
      gateway_url: "https://a10066031b8bdc1d93d8.198-51-100-52.sslip.io/",
    });
    expect(target?.gatewayHost).toBe("a10066031b8bdc1d93d8.198-51-100-52.sslip.io");
  });
});

describe("isProxmoxBackedInstanceRow", () => {
  it("returns true when infrastructure_provider is proxmox", () => {
    expect(
      isProxmoxBackedInstanceRow({ infrastructure_provider: "proxmox" })
    ).toBe(true);
  });

  it("returns true when proxmox_vmid is set", () => {
    expect(isProxmoxBackedInstanceRow({ proxmox_vmid: 200 })).toBe(true);
  });

  it("returns true when config.infrastructure exists", () => {
    expect(
      isProxmoxBackedInstanceRow({
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 200,
            privateIpv4: "10.250.20.50",
            gatewayHost: "x.hermesos.cloud",
          },
        },
      })
    ).toBe(true);
  });

  it("returns false for hetzner-only rows", () => {
    expect(
      isProxmoxBackedInstanceRow({
        infrastructure_provider: "hetzner",
        config: {},
        proxmox_vmid: null,
      })
    ).toBe(false);
  });
});

describe("stripProxmoxInfrastructure / getReleasedProxmoxInfrastructure", () => {
  it("strips config.infrastructure and stamps the release marker", () => {
    const next = stripProxmoxInfrastructure(
      {
        infrastructure: {
          provider: "proxmox",
          vmid: 425,
          privateIpv4: "10.250.20.75",
          gatewayHost: "x.hermesos.cloud",
        },
        retainedSetting: true,
      },
      "vm_missing_on_routed_host",
    );

    expect(next.infrastructure).toBeUndefined();
    expect(next.retainedSetting).toBe(true);
    const marker = getReleasedProxmoxInfrastructure(next);
    expect(marker?.reason).toBe("vm_missing_on_routed_host");
    expect(typeof marker?.at).toBe("string");
  });

  it("does not treat a single-host miss or legacy marker as teardown evidence", () => {
    for (const reason of ["vm_missing_on_routed_host", "legacy_backfill"] as const) {
      const marker = getReleasedProxmoxInfrastructure(
        stripProxmoxInfrastructure({}, reason),
      );
      expect(isProxmoxReleaseSafeForDbOnlyDelete(marker)).toBe(false);
    }
  });

  it("allows DB-only deletion only for authoritative release reasons", () => {
    for (const reason of [
      "vm_missing_across_fleet",
      "post_provision_stale_conflict",
      "dormant_reclaim",
      "post_provision_rollback",
    ] as const) {
      const marker = getReleasedProxmoxInfrastructure(
        stripProxmoxInfrastructure({}, reason),
      );
      expect(isProxmoxReleaseSafeForDbOnlyDelete(marker)).toBe(true);
    }
  });

  it("accepts all release reasons", () => {
    // The legacy_backfill value is written by a one-shot migration for rows
    // that were stripped before the marker existed. The guard must accept
    // it so those rows can finally be deleted from the dashboard.
    for (const reason of [
      "vm_missing_on_routed_host",
      "vm_missing_across_fleet",
      "post_provision_stale_conflict",
      "dormant_reclaim",
      "legacy_backfill",
    ] as const) {
      const next = stripProxmoxInfrastructure({}, reason);
      expect(getReleasedProxmoxInfrastructure(next)?.reason).toBe(reason);
    }
  });

  it("rejects unknown release reasons (defensive — only validator-known values trigger DB-only delete)", () => {
    // If a future code path stamps an unknown reason, the guard should fall
    // through to the legacy refuse-path rather than silently allowing a
    // mark-deleted on a row we don't understand.
    expect(
      getReleasedProxmoxInfrastructure({
        infrastructureReleased: { at: "2026-05-12T00:00:00Z", reason: "made_up" },
      })
    ).toBeNull();
  });

  it("returns null when the marker is missing", () => {
    expect(getReleasedProxmoxInfrastructure({})).toBeNull();
    expect(getReleasedProxmoxInfrastructure(null)).toBeNull();
    expect(getReleasedProxmoxInfrastructure({ infrastructureReleased: null })).toBeNull();
  });
});

describe("getHermesGuestSshTarget", () => {
  const id = "5e0c7a1b-2f3d-4c5e-8a9b-0c1d2e3f4a5b";

  it("carries the instance's host, stored VMID and id from config.infrastructure", () => {
    expect(
      getHermesGuestSshTarget({
        id,
        host_id: "host-12",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 1205,
            privateIpv4: "10.70.20.55",
            gatewayHost: "a.example.com",
            hostSlug: "pve12",
            hostEnvPrefix: "PROXMOX_PVE12_",
          },
        },
      })
    ).toEqual({ hostId: "host-12", hostSlug: "pve12", envPrefix: "PROXMOX_PVE12_", failClosed: true, vmid: 1205, instanceId: id });
  });

  it("falls back to the row's proxmox columns", () => {
    expect(
      getHermesGuestSshTarget({
        id,
        proxmox_vmid: 1205,
        proxmox_node: "pve12",
        ipv4_address: "10.70.20.55",
        gateway_url: "https://a.example.com",
      })
    ).toMatchObject({ hostSlug: "pve12", vmid: 1205, instanceId: id });
  });

  it("is null for a row with no Proxmox handle (Hetzner) or no id", () => {
    expect(getHermesGuestSshTarget({ id, ipv4_address: "203.0.113.10", config: {} })).toBeNull();
    expect(getHermesGuestSshTarget(null)).toBeNull();
    expect(
      getHermesGuestSshTarget({
        config: { infrastructure: { provider: "proxmox", vmid: 1205, privateIpv4: "10.70.20.55", gatewayHost: "a" } },
      })
    ).toBeNull();
  });
});
