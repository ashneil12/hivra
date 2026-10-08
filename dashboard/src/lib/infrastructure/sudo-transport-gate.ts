/**
 * Release gate T43 (docs/superpowers/specs/2026-09-24-server-enrollment-command.md,
 * section 9.2). Proxmox provisioning resolves on a marker and leaves a
 * `nohup … &` child running; under sudo that child may live in sudo's own
 * session and die when the channel closes. Until the disposable-runner test
 * (dashboard/scripts/test-server-enroll-host.py) shows the child survives an
 * early channel close with use_pty on and off, Proxmox preflight and
 * preparation refuse sudo connections, and no switch to the hivra user is
 * offered on a server that runs Proxmox VE. Linux Sandbox and inspection
 * don't use early finish and are not gated.
 */
export const PROXMOX_SUDO_TRANSPORT_READY: boolean = false;

export const PROXMOX_NEEDS_ROOT_COPY = "Proxmox launches need a root login for now.";
