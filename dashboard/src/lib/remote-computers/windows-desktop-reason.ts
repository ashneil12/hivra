// Why the fast Windows desktop couldn't open, as one coarse code the page can
// turn into one plain sentence and one action. The route maps its private
// inspection diagnostics to these codes and sends only the code: never a host
// name, address, credential or raw diagnostic. Client-safe and pure.

export const WINDOWS_DESKTOP_REASONS = [
  "guest_not_ready",
  "rdp_unavailable",
  "host_unreachable",
  "not_prepared",
  "unknown",
] as const;
export type WindowsDesktopReason = (typeof WINDOWS_DESKTOP_REASONS)[number];

export function isWindowsDesktopReason(value: unknown): value is WindowsDesktopReason {
  return typeof value === "string" && (WINDOWS_DESKTOP_REASONS as readonly string[]).includes(value);
}

/**
 * The coarse reason for one of the route's inspection failure tokens (the
 * allowlisted output of its failure parser). Anything unrecognised is
 * "unknown".
 */
export function windowsDesktopReasonFor(inspectionReason: string): WindowsDesktopReason {
  // The host or its authority couldn't be reached or answered badly.
  if (inspectionReason === "inspection_authority_unavailable"
    || inspectionReason === "inspection_record_failed"
    || inspectionReason === "host_timeout"
    || inspectionReason === "host_output_limit"
    || inspectionReason === "host_ssh"
    || inspectionReason.startsWith("host_remote_exit_")
    || inspectionReason === "host_phase_vm_state"
    || inspectionReason === "host_phase_vm_config"
    || inspectionReason === "host_phase_binding_tag") return "host_unreachable";
  // The computer isn't in a state to be inspected at all.
  if (inspectionReason === "windows_descriptor_missing"
    || inspectionReason === "inspection_agent_unstable") return "not_prepared";
  // Windows' Remote Desktop itself is off, blocked or misconfigured.
  if (inspectionReason.startsWith("guest_rdp_")
    || inspectionReason.startsWith("guest_console_autologon_")
    || inspectionReason.startsWith("guest_firewall_")) return "rdp_unavailable";
  // Windows hasn't finished starting, or its guest agent isn't answering.
  if (inspectionReason === "guest_remote_exit"
    || inspectionReason === "identity_mismatch"
    || inspectionReason.startsWith("capability_marker_")
    || inspectionReason.startsWith("qga_")
    || inspectionReason.startsWith("guest_")
    || inspectionReason === "host_phase_guest_ip_binding"
    || inspectionReason === "host_phase_guest_exec"
    || inspectionReason === "inspection_failed") return "guest_not_ready";
  return "unknown";
}

export type WindowsDesktopReasonAction = "retry" | "restart";

/** One sentence and one action per reason. */
export const WINDOWS_DESKTOP_REASON_COPY: Record<WindowsDesktopReason, { text: string; action: WindowsDesktopReasonAction }> = {
  guest_not_ready: {
    text: "Windows is still starting up. Give it a minute, then try again.",
    action: "retry",
  },
  rdp_unavailable: {
    text: "Windows isn't accepting remote desktop connections right now. Restarting the computer usually fixes this.",
    action: "restart",
  },
  host_unreachable: {
    text: "Hivra can't reach this computer right now. Try again in a moment.",
    action: "retry",
  },
  not_prepared: {
    text: "This computer isn't ready for the fast desktop yet. Restart it, then try again.",
    action: "restart",
  },
  unknown: {
    text: "The Windows desktop couldn't open. Try again.",
    action: "retry",
  },
};
