import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { buildProxmoxTenantIsolationGuard } from "@/lib/services/proxmox-instance-service";

const hookedForwardChain = `table bridge hermes_vm_isolation {
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "tap*" oifname "tap*" drop
    iifname "fwln*" oifname "fwln*" drop
    iifname "tap*" oifname "fwln*" drop
    iifname "fwln*" oifname "tap*" drop
  }
}`;

function runGuard(params: {
  activeChain: string;
  persistedChain: string;
  persistedConfig?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "hermes-tenant-guard-"));
  const binDir = join(dir, "bin");
  const activePath = join(dir, "active-chain.txt");
  const persistedPath = join(dir, "persisted-chain.txt");
  const configPath = join(dir, "nftables.conf");
  mkdirSync(binDir);
  writeFileSync(activePath, params.activeChain);
  writeFileSync(persistedPath, params.persistedChain);
  writeFileSync(configPath, params.persistedConfig ?? hookedForwardChain);

  const systemctlPath = join(binDir, "systemctl");
  writeFileSync(systemctlPath, "#!/bin/sh\nexit 0\n");
  chmodSync(systemctlPath, 0o755);

  const nftPath = join(binDir, "nft");
  writeFileSync(
    nftPath,
    `#!/bin/sh
if [ "$1" = "-f" ]; then exit 0; fi
if [ "$1 $2 $3 $4 $5 $6" = "list chain bridge hermes_vm_isolation forward " ]; then
  if [ "\${HERMES_TEST_PERSISTED:-0}" = "1" ]; then
    cat "$HERMES_TEST_PERSISTED_CHAIN"
  else
    cat "$HERMES_TEST_ACTIVE_CHAIN"
  fi
  exit 0
fi
exit 1
`
  );
  chmodSync(nftPath, 0o755);

  const unsharePath = join(binDir, "unshare");
  writeFileSync(
    unsharePath,
    `#!/bin/sh
[ "$1" = "--net" ] || exit 2
shift
HERMES_TEST_PERSISTED=1 exec "$@"
`
  );
  chmodSync(unsharePath, 0o755);

  return spawnSync("bash", ["-c", buildProxmoxTenantIsolationGuard(configPath)], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HERMES_TEST_ACTIVE_CHAIN: activePath,
      HERMES_TEST_PERSISTED_CHAIN: persistedPath,
    },
  });
}

describe("Proxmox tenant isolation shell guard", () => {
  it("passes only when both active and persisted chains are forward-hooked", () => {
    const result = runGuard({
      activeChain: hookedForwardChain,
      persistedChain: hookedForwardChain,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("HERMES_TENANT_ISOLATION_READY");
  });

  it.each([
    ["unhooked", hookedForwardChain.replace("type filter hook forward priority filter;", "")],
    [
      "wrong hook",
      hookedForwardChain.replace("type filter hook forward", "type filter hook input"),
    ],
  ])("rejects %s active-chain rules even when all drops exist", (_label, activeChain) => {
    const result = runGuard({ activeChain, persistedChain: hookedForwardChain });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active chain is not hooked to bridge forward");
  });

  it("rejects commented-only persistent rules", () => {
    const commentedConfig = hookedForwardChain
      .split("\n")
      .map((line) => `# ${line}`)
      .join("\n");
    const result = runGuard({
      activeChain: hookedForwardChain,
      persistedChain: "",
      persistedConfig: commentedConfig,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("persisted forward chain is absent");
  });
});
