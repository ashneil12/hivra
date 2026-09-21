import { createHash } from "node:crypto";
import { buildAttachedCodexServiceDefinition } from "../attachment-native-service";
import captured from "./fixtures/attachment-network-staging-result.json";

const expected = { identity: { ...captured.identity, architecture: "x86_64" as const }, bootId: captured.bootId };

it("defines only the private pinned account/runtime and an installation-specific Unix listener", () => {
  const definition = buildAttachedCodexServiceDefinition(JSON.stringify(captured), expected);
  expect(definition.unitName).toBe(`hivra-attached-${captured.identity.installationId}.service`);
  expect(definition.unitPath).toBe(`/etc/systemd/system/${definition.unitName}`);
  expect(definition.content).toContain(`User=${captured.receipt.account}\nGroup=${captured.receipt.account}\n`);
  expect(definition.content).toContain(`ExecStart=/usr/bin/env -i HOME=${captured.receipt.home} CODEX_HOME=${captured.receipt.home}/.codex PATH=/usr/bin:/bin ${captured.receipt.executable} -c analytics.enabled=false app-server --listen unix://${definition.socketPath}\n`);
  expect(Buffer.byteLength(definition.socketPath)).toBeLessThan(108);
  expect(definition.content).toContain(`ReadWritePaths=${captured.receipt.home}\n`);
  expect(definition.content).toContain("RuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=no\n");
  expect(definition.content).toContain(`ExecStartPre=/usr/bin/test ! -L ${captured.receipt.home}/.codex\nExecStartPre=/usr/bin/mkdir -p ${captured.receipt.home}/.codex\n`);
  expect(definition.content).toContain("Restart=no\nKillMode=control-group\n");
  expect(definition.content).toContain("TimeoutStopSec=15\nSendSIGKILL=yes\nNoNewPrivileges=yes\n");
  expect(definition.content).toContain("ProtectSystem=strict\nProtectHome=yes\n");
  expect(definition.content).not.toMatch(/ws:\/\/|0\.0\.0\.0|127\.0\.0\.1|sudo|bux|rm /);
  expect(definition.sha256).toBe(createHash("sha256").update(definition.content).digest("hex"));
});

it("requires the exact staged identity, boot, executable, home and unprivileged receipt", () => {
  for (const value of [null, { ...captured, phase: "ready" }, { ...captured, bootId: captured.identity.sourceId },
    { ...captured, receipt: { ...captured.receipt, uid: 0 } },
    { ...captured, receipt: { ...captured.receipt, home: "/root" } },
    { ...captured, receipt: { ...captured.receipt, executable: "/bin/sh" } },
    { ...captured, receipt: { ...captured.receipt, account: "root\nExecStart=/bin/sh" } }]) {
    expect(() => buildAttachedCodexServiceDefinition(JSON.stringify(value), expected)).toThrow();
  }
});
