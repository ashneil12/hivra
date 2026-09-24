import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEEPSEEK_CANARY_ORIGIN,
  DEEPSEEK_CANARY_VERSION,
  launchDeepSeekCanary,
  loadDeepSeekCanaryBundleManifest,
  parseDeepSeekCanaryArgs,
  type DeepSeekCanaryLedger,
} from "../../scripts/deepseek-proxmox-canary";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
  type HostScriptResult,
} from "../../src/lib/services/proxmox-instance-service";
import { createBoxTunnel } from "../../src/lib/services/cloudflare-tunnel";
import { deleteBoxTunnelVerified } from "../../src/lib/services/cloudflare-tunnel-cleanup";

jest.mock("../../src/lib/services/proxmox-instance-service", () => ({
  isProxmoxProvisioningConfigured: jest.fn(() => true),
  resolveProxmoxTargetConfiguration: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));
jest.mock("../../src/lib/services/cloudflare-tunnel", () => ({
  createBoxTunnel: jest.fn(),
  getTunnelConfig: jest.fn(() => ({})),
}));
jest.mock("../../src/lib/services/cloudflare-tunnel-cleanup", () => ({
  deleteBoxTunnelVerified: jest.fn(async () => undefined),
}));

const TUNNEL = {
  token: "fixture-token",
  url: "https://deepseek.example.com",
  tunnelId: "00000000-0000-4000-8000-000000001006",
  hostname: "deepseek.example.com",
};

const targetEnv = {
  NEXT_PUBLIC_APP_URL: DEEPSEEK_CANARY_ORIGIN,
  HIVRA_DEEPSEEK_LAB_TARGETS: "fixturenode11",
  HIVRA_DEEPSEEK_LAB_TARGET_FIXTURENODE11_VMID_START: "1180",
  HIVRA_DEEPSEEK_LAB_TARGET_FIXTURENODE11_VMID_END: "1189",
  PROXMOX_EXEC_MODE: "ssh",
  PROXMOX_SSH_HOST_FINGERPRINT: "SHA256:fixture",
  PROXMOX_PRIVATE_SUBNET_PREFIX: "10.252.20",
  PROXMOX_PRIVATE_GATEWAY: "10.252.20.1",
  PROXMOX_VMID_START: "1180",
  PROXMOX_VMID_END: "1189",
};

type HostStep = "launch" | "bundle-check" | "teardown";

function hostStep(script: string): HostStep {
  if (script.includes("HIVRA_DEEPSEEK_BUNDLE_CHECK_LOCK_TIMEOUT")) return "bundle-check";
  if (script.includes("HIVRA_DEEPSEEK_CLAIM_RACE")) return "launch";
  if (script.includes("qm destroy")) return "teardown";
  throw new Error("unexpected host script");
}

describe("DeepSeek Canary launch records only a release that stayed in place", () => {
  let root = "";
  let ledgerPath = "";
  let checkoutManifest = "";
  let steps: HostStep[] = [];
  let scripts: string[] = [];
  let log: jest.SpyInstance;

  beforeAll(async () => {
    checkoutManifest = await loadDeepSeekCanaryBundleManifest();
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deepseek-launch-wiring-"));
    ledgerPath = join(root, "ledger.json");
    steps = [];
    scripts = [];
    log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.mocked(resolveProxmoxTargetConfiguration).mockReturnValue({ env: targetEnv } as never);
    jest.mocked(createBoxTunnel).mockImplementation(async (_slug, opts) => {
      await opts?.journal?.beforeCreate({ hostname: TUNNEL.hostname });
      await opts?.journal?.created({ tunnelId: TUNNEL.tunnelId, hostname: TUNNEL.hostname });
      return TUNNEL as never;
    });
  });

  afterEach(() => {
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  function hostResponds(bundleCheck: HostScriptResult): void {
    jest.mocked(runProxmoxHostScript).mockImplementation(async (script: string) => {
      const step = hostStep(script);
      steps.push(step);
      scripts.push(script);
      if (step === "launch") {
        const receipt = { vmid: 1182, ip: "10.252.20.82", agent_kind: "deepseek-harness", chat_url: TUNNEL.url, ready: true };
        return { ok: true, stdout: `${JSON.stringify(receipt)}\n`, stderr: "" };
      }
      if (step === "bundle-check") return bundleCheck;
      return { ok: true, stdout: 'HIVRA_DEEPSEEK_CLEAN {"vmid":1182}\n', stderr: "" };
    });
  }

  function args() {
    return parseDeepSeekCanaryArgs([
      "--launch", "--target", "fixturenode11", "--expected-hostname", "fixturenode11",
      "--ledger", ledgerPath, "--vmid", "1182", "--octet", "82",
    ]);
  }

  function readLedger(): DeepSeekCanaryLedger {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as DeepSeekCanaryLedger;
  }

  it("records the pinned release only after the bundle is confirmed in place", async () => {
    hostResponds({
      ok: true,
      stdout: `HIVRA_DEEPSEEK_BUNDLE_ADMITTED {"provisionerVersion":"${DEEPSEEK_CANARY_VERSION}"}\n`,
      stderr: "",
    });
    await launchDeepSeekCanary(args());
    expect(steps).toEqual(["launch", "bundle-check"]);
    for (const script of scripts) expect(script).toContain(`EXPECTED_BUNDLE_MANIFEST='${checkoutManifest}'`);
    expect(readLedger()).toMatchObject({ phase: "launched", launch: { url: TUNNEL.url } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`"provisionerVersion":"${DEEPSEEK_CANARY_VERSION}"`));
  });

  it("tears the computer down instead of recording it when the bundle changed during setup", async () => {
    hostResponds({ ok: false, stdout: "", stderr: "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH\n" });
    await expect(launchDeepSeekCanary(args())).rejects.toThrow("HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH");
    expect(steps).toEqual(["launch", "bundle-check", "teardown"]);
    expect(deleteBoxTunnelVerified).toHaveBeenCalledWith(
      { tunnelId: TUNNEL.tunnelId, hostname: TUNNEL.hostname },
      expect.anything(),
    );
    const ledger = readLedger();
    expect(ledger.phase).toBe("clean");
    expect(ledger.launch).toBeUndefined();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('"mode":"launched"'));
  });
});
