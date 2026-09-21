jest.mock("../src/lib/services/proxmox-instance-service", () => ({
  isProxmoxProvisioningConfigured: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

import { buildBakeScript } from "../scripts/proxmox-template-bake";

describe("proxmox-template-bake", () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("expands undersized cloned template disks before booting and pulling images", () => {
    const script = buildBakeScript(
      {
        sourceTemplate: 9005,
        newTemplate: 9006,
        name: "hermes-template-baked-main-20260512-9006",
        temporaryIp: "10.250.21.199",
        diskSizeGb: 30,
        thinBase: false,
        apply: true,
      },
      "test-dashboard-commit"
    );

    expect(script).toContain("DISK_SIZE_GB='30'");
    expect(script).toContain("Could not determine cloned scsi0 disk size");
    expect(script).toContain('qm resize "$NEW_TEMPLATE" scsi0 "${DISK_SIZE_GB}G"');
    expect(script).toContain("[bake] scsi0 is ${current_disk_size_gb}G; no disk expansion needed");
    expect(script.indexOf('qm resize "$NEW_TEMPLATE" scsi0 "${DISK_SIZE_GB}G"')).toBeLessThan(
      script.indexOf('qm start "$NEW_TEMPLATE"')
    );
  });
});
