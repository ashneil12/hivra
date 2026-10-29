import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDestroyScript,
  ERROR_PURGE_PROVIDER_MUTATION_ENABLED,
  runPurgeErrorHivraAgentsSweep,
} from "../purge-error-agents";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { deleteBoxTunnel } from "@/lib/services/cloudflare-tunnel";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/services/cloudflare-tunnel", () => ({
  deleteBoxTunnel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("runPurgeErrorHivraAgentsSweep", () => {
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps the legacy destructive provider sweep hard-disabled", async () => {
    expect(ERROR_PURGE_PROVIDER_MUTATION_ENABLED).toBe(false);

    const summary = await runPurgeErrorHivraAgentsSweep();

    expect(summary).toEqual({ scanned: 0, purged: 0, skipped: 0, results: [] });
    expect(mockedFrom).not.toHaveBeenCalled();
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
    expect(logHivraAgentEvent).not.toHaveBeenCalled();
  });

  it("cannot bypass the authority fuse through the targeted-agent option", async () => {
    const summary = await runPurgeErrorHivraAgentsSweep({
      agentId: "00000000-0000-4000-8000-000000001038",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(summary).toEqual({ scanned: 0, purged: 0, skipped: 0, results: [] });
    expect(mockedFrom).not.toHaveBeenCalled();
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
  });
});

describe("buildDestroyScript ownership gate", () => {
  const ALLOCATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  // Runs the generated script under bash with a stub `qm` on PATH. The stub
  // reports the given provider tags and records every qm call it receives.
  function runAgainstStubQm(providerTags: string) {
    const dir = mkdtempSync(join(tmpdir(), "purge-gate-"));
    const callLog = join(dir, "qm-calls.log");
    writeFileSync(
      join(dir, "qm"),
      `#!/bin/sh
echo "$1" >> "${callLog}"
case "$1" in
  status) exit 0 ;;
  config) echo "tags: ${providerTags}" ;;
esac
exit 0
`,
    );
    chmodSync(join(dir, "qm"), 0o755);
    const result = spawnSync("bash", ["-c", buildDestroyScript(4242, ALLOCATION_ID)], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [];
    return { status: result.status, stderr: result.stderr, calls };
  }

  it("refuses to stop or destroy a VM whose tags carry a different ownership tag", () => {
    const result = runAgainstStubQm("hivra-op-ffffffffffffffffffffffffffffffff;other");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to destroy");
    expect(result.calls).toEqual(["status", "config"]);
  });

  it("refuses when the VM carries no tags at all", () => {
    const result = runAgainstStubQm("");

    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual(["status", "config"]);
  });
});
