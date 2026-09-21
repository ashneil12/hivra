import { createHash } from "node:crypto";
import { parseAttachmentGuestResult, type ExpectedAttachmentGuestResult } from "./attachment-guest-result";

/** Definition only: a future bound activation worker must revalidate the guest
 * account, installation bytes/ownership and durable authority before installing
 * or starting it. This function writes no files and grants no activation.
 */
export function buildAttachedCodexServiceDefinition(stdout: string, expected: ExpectedAttachmentGuestResult) {
  const staged = parseAttachmentGuestResult(stdout, expected);
  if (!staged) throw new Error("A matching pinned staged installation is required.");
  const { installationId } = staged.identity;
  const { account, home, executable } = staged.receipt;
  const name = `hivra-attached-${installationId}`;
  const socketPath = `/run/${name}/app.sock`;
  const unitName = `${name}.service`;
  const content = `[Unit]
Description=Hivra attached Codex ${installationId}
After=network.target

[Service]
Type=exec
User=${account}
Group=${account}
WorkingDirectory=${home}
Environment=HOME=${home}
Environment=CODEX_HOME=${home}/.codex
Environment=PATH=/usr/bin:/bin
UMask=0077
RuntimeDirectory=${name}
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
ExecStartPre=/usr/bin/test ! -L ${home}/.codex
ExecStartPre=/usr/bin/mkdir -p ${home}/.codex
ExecStart=/usr/bin/env -i HOME=${home} CODEX_HOME=${home}/.codex PATH=/usr/bin:/bin ${executable} -c analytics.enabled=false app-server --listen unix://${socketPath}
Restart=no
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=15
SendSIGKILL=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${home}
PrivateTmp=yes
ProtectControlGroups=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`;
  return { unitName, unitPath: `/etc/systemd/system/${unitName}`, socketPath, content,
    sha256: createHash("sha256").update(content).digest("hex") };
}
