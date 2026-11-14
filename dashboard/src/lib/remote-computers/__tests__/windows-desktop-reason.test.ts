/** @jest-environment node */
import {
  WINDOWS_DESKTOP_REASONS,
  WINDOWS_DESKTOP_REASON_COPY,
  isWindowsDesktopReason,
  windowsDesktopReasonFor,
} from "../windows-desktop-reason";

describe("windowsDesktopReasonFor", () => {
  it.each([
    ["inspection_authority_unavailable", "host_unreachable"],
    ["host_timeout", "host_unreachable"],
    ["host_output_limit", "host_unreachable"],
    ["host_ssh", "host_unreachable"],
    ["host_remote_exit_255", "host_unreachable"],
    ["host_phase_vm_state", "host_unreachable"],
    ["host_phase_binding_tag", "host_unreachable"],
    ["guest_rdp_disabled", "rdp_unavailable"],
    ["guest_rdp_listener_unready", "rdp_unavailable"],
    ["guest_console_autologon_invalid", "rdp_unavailable"],
    ["guest_remote_exit", "guest_not_ready"],
    ["capability_marker_absent", "guest_not_ready"],
    ["qga_dispatch", "guest_not_ready"],
    ["host_phase_guest_exec", "guest_not_ready"],
    ["identity_mismatch", "guest_not_ready"],
    ["inspection_failed", "guest_not_ready"],
    ["windows_descriptor_missing", "not_prepared"],
    ["inspection_agent_unstable", "not_prepared"],
    ["inspection_unknown", "unknown"],
    ["something_else", "unknown"],
  ])("maps %s to %s", (inspection, reason) => {
    expect(windowsDesktopReasonFor(inspection)).toBe(reason);
  });
});

describe("the reason copy", () => {
  it("has one plain sentence and one action for every reason, and no technical terms or addresses", () => {
    for (const reason of WINDOWS_DESKTOP_REASONS) {
      const copy = WINDOWS_DESKTOP_REASON_COPY[reason];
      expect(copy.text.length).toBeGreaterThan(10);
      expect(["retry", "restart"]).toContain(copy.action);
      expect(copy.text).not.toMatch(/\b(?:RDP|NLA|QGA|guest agent|firewall|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/i);
    }
  });

  it("accepts only its own codes", () => {
    expect(isWindowsDesktopReason("guest_not_ready")).toBe(true);
    expect(isWindowsDesktopReason("host_timeout")).toBe(false);
    expect(isWindowsDesktopReason(undefined)).toBe(false);
  });
});
