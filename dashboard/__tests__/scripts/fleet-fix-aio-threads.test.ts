import { execFileSync } from "child_process";

jest.mock("../../src/lib/services/proxmox-instance-service", () => ({
  getProxmoxInfrastructure: jest.fn(),
  resolveProxmoxHostEnv: jest.fn(),
  resolveProxmoxTargetCandidateIds: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));
jest.mock("@supabase/supabase-js", () => ({ createClient: jest.fn() }));
import { createClient } from "@supabase/supabase-js";
import { runProxmoxHostScript } from "../../src/lib/services/proxmox-instance-service";
import { parseArgs, rewriteScsi0, buildApplyScript } from "../../scripts/fleet-fix-aio-threads";

describe("existing VM aio repair", () => {
  it("can be imported without loading credentials or contacting infrastructure", () => {
    expect(createClient).not.toHaveBeenCalled();
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
  });
  it("defaults to dry-run and preserves explicit dry-run even alongside apply", () => {
    expect(parseArgs([])).toMatchObject({ apply: false, dryRun: true, maxParallel: 1 });
    expect(parseArgs(["--apply", "--dry-run"])).toMatchObject({ dryRun: true });
    expect(parseArgs(["--apply", "--host", "your-host", "--max-parallel", "100"])).toMatchObject({ apply: true, dryRun: false, hostFilter: "your-host", maxParallel: 3 });
  });
  it("preserves the exact disk and unrelated options while replacing aio", () => {
    const before = "local-lvm:vm-202-disk-0,size=30G,discard=on,ssd=1,cache=none,aio=io_uring";
    const result = rewriteScsi0(before);
    expect(result).toEqual({ rewritten: before.replace("aio=io_uring", "aio=threads"), changed: true });
    expect(rewriteScsi0(result.rewritten)).toEqual({ rewritten: result.rewritten, changed: false });
    expect(rewriteScsi0("local-lvm:vm-202-disk-0,discard=on").rewritten).toBe("local-lvm:vm-202-disk-0,discard=on,aio=threads");
  });
  it("generates valid shell and avoids reboot and trim for stopped VMs", () => {
    const script = buildApplyScript({ vmid: 202, newScsi0: "local-lvm:vm-202-disk-0,aio=threads", shouldReboot: false, runTrim: true });
    execFileSync("bash", ["-n"], { input: script });
    expect(script).toContain("qm set 202 --scsi0");
    expect(script).not.toContain("qm reboot");
    expect(script).not.toContain("fstrim");
  });
});
