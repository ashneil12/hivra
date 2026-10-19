/** @jest-environment node */
import { computerKindLabel, isComputerRow, linkLabel, linkSource, linkTarget, targetBusyReason } from "../eligibility";

const ubuntu = { id: "c1", type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm",
  infrastructure_binding_token_enforced: true, status: "running" };

describe("agent link eligibility", () => {
  it("tells computers from agents", () => {
    expect(isComputerRow(ubuntu)).toBe(true);
    expect(isComputerRow({ id: "a", type: "claude-code" })).toBe(false);
    expect(isComputerRow({ id: "s", type: "linux-terminal", computer_substrate: "gvisor" })).toBe(true);
  });

  it("offers Proxmox and My cloud agents as sources, not DigitalOcean or computers", () => {
    expect(linkSource({ id: "a", type: "claude-code", computer_substrate: "proxmox-kvm" })).toEqual({ ok: true, lane: "proxmox" });
    expect(linkSource({ id: "a", type: "openclaw", computer_substrate: null })).toEqual({ ok: true, lane: "proxmox" });
    expect(linkSource({ id: "a", type: "codex", computer_substrate: "provider-vm" })).toEqual({ ok: true, lane: "provider" });
    expect(linkSource({ id: "a", type: "hermes", computer_substrate: "do-managed-session" }).ok).toBe(false);
    expect(linkSource(ubuntu).ok).toBe(false);
  });

  it("offers bound Linux computers on Proxmox and sandboxes as targets, nothing else", () => {
    expect(linkTarget(ubuntu)).toEqual({ ok: true, lane: "proxmox" });
    expect(linkTarget({ ...ubuntu, computer_profile: "omarchy" })).toEqual({ ok: true, lane: "proxmox" });
    expect(linkTarget({ id: "s", type: "linux-terminal", computer_substrate: "gvisor" })).toEqual({ ok: true, lane: "gvisor" });
    expect(linkTarget({ ...ubuntu, infrastructure_binding_token_enforced: false }).ok).toBe(false);
    expect(linkTarget({ ...ubuntu, computer_profile: "windows" }).ok).toBe(false);
    expect(linkTarget({ ...ubuntu, computer_substrate: "provider-vm" }).ok).toBe(false);
    expect(linkTarget({ id: "a", type: "claude-code", computer_substrate: "proxmox-kvm" }).ok).toBe(false);
  });

  it("says why a linked computer can't run a command now", () => {
    expect(targetBusyReason(ubuntu)).toBeNull();
    expect(targetBusyReason({ ...ubuntu, status: "stopped" })).toMatch(/stopped/);
  });

  it("keeps names one plain line", () => {
    expect(linkLabel("Studio\n# `rm -rf` <b>")).toBe("Studio rm -rf b");
    expect(linkLabel("   ")).toBe("Computer");
    expect(linkLabel("x".repeat(100))).toHaveLength(60);
    expect(computerKindLabel({ id: "o", computer_profile: "omarchy" })).toBe("Omarchy desktop");
  });
});
