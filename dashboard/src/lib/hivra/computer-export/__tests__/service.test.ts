/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScriptWithStdin: jest.fn() }));
jest.mock("../../agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
import { computerExportEligible, readComputerExportSettings, startComputerExport, validateExportPassphrase } from "../service";

describe("computer export service", () => {
  it("is off unless switched on, and clamps its limits", () => {
    expect(readComputerExportSettings({}).enabled).toBe(false);
    const s = readComputerExportSettings({ HIVRA_COMPUTER_EXPORT_ENABLED: "1", HIVRA_COMPUTER_EXPORT_KEEP_DAYS: "30", HIVRA_COMPUTER_EXPORT_MAX_GIB: "5" });
    expect(s).toMatchObject({ enabled: true, keepDays: 7, maxGiB: 5, cooldownHours: 24, bucket: null });
  });

  it("refuses to start while switched off", async () => {
    await expect(startComputerExport("user_1", "x", "long enough phrase", readComputerExportSettings({})))
      .rejects.toMatchObject({ status: 404 });
  });

  it("accepts only bound Proxmox computers", () => {
    const row = { computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true, vmid: 101, ip: "10.0.0.2" };
    expect(computerExportEligible(row)).toBe(true);
    expect(computerExportEligible({ ...row, infrastructure_binding_token_enforced: false })).toBe(false);
    expect(computerExportEligible({ ...row, computer_substrate: "gvisor" })).toBe(false);
  });

  it("wants a one-line passphrase of at least 12 characters", () => {
    expect(validateExportPassphrase("twelve chars")).toBe("twelve chars");
    expect(() => validateExportPassphrase("short")).toThrow();
    expect(() => validateExportPassphrase("long enough\nphrase")).toThrow();
  });
});
