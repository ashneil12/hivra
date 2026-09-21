/** @jest-environment node */

import {
  managedHivraProvisionerChannelConfiguration,
  managedHivraProvisionerChannelForServerEnvironment,
  parseManagedHivraProvisionerChannel,
  persistedManagedHivraProvisionerChannel,
} from "../managed-provisioner-channel";

describe("managed provisioner channel", () => {
  it("keeps default and Canary bundles in fixed separate directories", () => {
    expect(managedHivraProvisionerChannelConfiguration("default")).toMatchObject({
      runtime: { provisionerDirectory: "/root/hivra-provisioner" },
      rollbackRoot: "/root/.hivra-provisioner-rollbacks",
      uploadTemplate: "/root/.hivra-provisioner-upload.XXXXXXXX",
    });
    expect(managedHivraProvisionerChannelConfiguration("canary")).toMatchObject({
      runtime: { provisionerDirectory: "/root/hivra-provisioner-canary" },
      rollbackRoot: "/root/.hivra-provisioner-canary-rollbacks",
      uploadTemplate: "/root/.hivra-provisioner-canary-upload.XXXXXXXX",
    });
  });

  it("selects Canary only from the exact trusted Vercel target", () => {
    expect(managedHivraProvisionerChannelForServerEnvironment({ VERCEL_TARGET_ENV: "canary" }))
      .toBe("canary");
    for (const targetEnvironment of [undefined, "", "production", "preview", "development"]) {
      expect(managedHivraProvisionerChannelForServerEnvironment({
        VERCEL_TARGET_ENV: targetEnvironment,
      })).toBe("default");
    }
  });

  it("selects isolated delivery for the dedicated Canary production slot", () => {
    const channel = managedHivraProvisionerChannelForServerEnvironment({
      VERCEL_TARGET_ENV: "production", HIVRA_MANAGED_PROVISIONER_CHANNEL: "canary",
    });
    expect(channel).toBe("canary");
    expect(managedHivraProvisionerChannelConfiguration(channel).runtime.provisionerDirectory)
      .toBe("/root/hivra-provisioner-canary");
    expect(persistedManagedHivraProvisionerChannel("default")).toBe("default");
  });

  it.each(["", "Canary", " canary ", "/root/hivra-provisioner", "unknown"])("rejects invalid server override %s", override => {
    expect(() => managedHivraProvisionerChannelForServerEnvironment({
      VERCEL_TARGET_ENV: "production", HIVRA_MANAGED_PROVISIONER_CHANNEL: override,
    })).toThrow("Unsupported managed Hivra provisioner deployment channel");
  });

  it("rejects contradictory Canary/default configuration and unknown targets even with an override", () => {
    for (const env of [
      { VERCEL_TARGET_ENV: "canary", HIVRA_MANAGED_PROVISIONER_CHANNEL: "default" },
      { VERCEL_TARGET_ENV: "staging", HIVRA_MANAGED_PROVISIONER_CHANNEL: "canary" },
    ]) expect(() => managedHivraProvisionerChannelForServerEnvironment(env)).toThrow();
  });

  it("fails closed for unknown deployment and persisted channel values", () => {
    for (const VERCEL_TARGET_ENV of ["staging", "Canary", " canary "]) {
      expect(() => managedHivraProvisionerChannelForServerEnvironment({ VERCEL_TARGET_ENV }))
        .toThrow("Unsupported managed Hivra provisioner deployment channel");
    }
    expect(parseManagedHivraProvisionerChannel("staging")).toBeNull();
    expect(persistedManagedHivraProvisionerChannel("staging")).toBeNull();
  });

  it("keeps only missing legacy rows on the default channel", () => {
    expect(persistedManagedHivraProvisionerChannel(undefined)).toBe("default");
    expect(persistedManagedHivraProvisionerChannel(null)).toBe("default");
    expect(persistedManagedHivraProvisionerChannel("default")).toBe("default");
    expect(persistedManagedHivraProvisionerChannel("canary")).toBe("canary");
  });
});
