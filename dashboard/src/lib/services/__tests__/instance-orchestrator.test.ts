import { SupabaseClient } from "@supabase/supabase-js";

import { sshExec } from "@/lib/hetzner/ssh";
import { decryptApiKey } from "@/lib/crypto";
import { getProxmoxInfrastructure, resolveProxmoxHostEnv, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { applyLiveUpdate, resolveBankrRuntimeEnvPlanForUpdate, resolveInstanceIpv4 } from "../instance-orchestrator";
import { getProfileDeploymentState } from "@/lib/profile-deployment";
import { validateProviderApiKey } from "@/lib/services/provider-validation";
import { buildAgentDeployScript, getHetznerInstanceStatus, resolveGatewayConfiguration } from "@/lib/services/hetzner-instance-service";
import { buildWebUIBootstrapScript, buildWebUIProvisioningArtifacts } from "@/lib/services/webui-instance-builder";
import { resolveProviderBaseUrl } from "@/lib/services/provider-config";
import { decryptMemorySystemSecrets, getAutoUpdateConfig, getRuntimeAgentSettings } from "@/lib/instance-settings";
import { getPersonaSoulPrompt } from "@/lib/persona-souls-accessor";
import { resolveCodexDeploymentSecret } from "@/lib/codex-oauth";
import { resolveNousDeploymentSecret } from "@/lib/nous-oauth";
import {
  buildInstanceBankrAgentConfig,
  getBankrWalletForInstance,
} from "@/lib/billing/bankr-instance-wallets";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { log } from "@/lib/logger";
import {
  OPERATOR_LIVE_UPDATE,
  USER_LIVE_UPDATE,
  systemLiveUpdate,
} from "@/lib/services/live-update-initiator";
import {
  INFLIGHT_UPDATE_GATE_BUDGET_SECONDS,
  INFLIGHT_UPDATE_GATE_SLACK_SECONDS,
  buildInFlightUpdateGateScript,
} from "@/lib/services/inflight-update-gate";
import { buildIdleGatedUpdateProvisioningScript } from "@/lib/services/idle-gated-update-builder";
import { spawnSync } from "child_process";

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
}));

jest.mock("@/lib/codex-oauth", () => ({
  resolveCodexDeploymentSecret: jest.fn(),
}));

jest.mock("@/lib/nous-oauth", () => ({
  resolveNousDeploymentSecret: jest.fn(),
}));

jest.mock("@/lib/profile-deployment", () => ({
  getProfileDeploymentState: jest.fn(),
}));

jest.mock("@/lib/services/provider-validation", () => ({
  validateProviderApiKey: jest.fn(),
}));

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  buildAgentDeployScript: jest.fn(),
  getHetznerInstanceStatus: jest.fn(),
  resolveGatewayConfiguration: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  buildProxmoxTenantIsolationGuard: jest.fn(
    () => 'echo "HERMES_TEST_TENANT_ISOLATION_GUARD"\n'
  ),
  getProxmoxInfrastructure: jest.fn(),
  resolveProxmoxHostEnv: jest.fn((_config, baseEnv) => ({ ...baseEnv })),
  runProxmoxHostScript: jest.fn(),
  // Site-3 guard (d00745a7c): applyLiveUpdate derives gateway_url via these
  // two instead of raw templating `https://${gatewayHost}`. Default: pass
  // hostConfig through unchanged so callers asserting on
  // getProxmoxHostRoutingConfigFromInfrastructure's inputs still work; real
  // gateway derivation exercises resolveProxmoxGatewayUrlFromSubdomain's
  // actual subdomain-based logic below rather than stubbing it opaque.
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn((infrastructure, row) => {
    const hostId = infrastructure?.hostId ?? row?.host_id ?? null;
    const hostSlug = infrastructure?.hostSlug ?? infrastructure?.node ?? null;
    const envPrefix = infrastructure?.hostEnvPrefix ?? null;
    if (!hostId && !hostSlug && !envPrefix) return null;
    return { hostId, hostSlug, hostEnvPrefix: envPrefix };
  }),
  resolveProxmoxGatewayUrlFromSubdomain: jest.fn(({ subdomain }) => {
    // No subdomain => can't derive, matches the real function's contract
    // (never fall back to the untrusted gatewayHost).
    if (!subdomain) return null;
    return `https://${subdomain}.hermesos.cloud`;
  }),
}));

jest.mock("@/lib/services/webui-instance-builder", () => ({
  buildWebUIBootstrapScript: jest.fn(),
  buildWebUIProvisioningArtifacts: jest.fn(),
}));

jest.mock("@/lib/services/provider-config", () => ({
  PROVIDER_ID_MAP: {
    openai: "openai",
    custom_llm: "custom",
    nous: "nous",
  },
  resolveProviderBaseUrl: jest.fn(),
}));

jest.mock("@/lib/instance-settings", () => ({
  decryptMemorySystemSecrets: jest.fn(),
  getAutoUpdateConfig: jest.fn(),
  getRuntimeAgentSettings: jest.fn(),
}));

jest.mock("@/lib/billing/bankr-instance-wallets", () => {
  // The custody predicates are pure: keep them real so the clear/replace
  // decisions below run the production rules, not a stub.
  const actual = jest.requireActual("@/lib/billing/bankr-instance-wallets");
  return {
    buildInstanceBankrAgentConfig: jest.fn(),
    getBankrWalletForInstance: jest.fn(),
    bankrRuntimeWalletAddressHistory: actual.bankrRuntimeWalletAddressHistory,
    isRevokedUserConnectedWallet: actual.isRevokedUserConnectedWallet,
    isUserConnectedWalletRecord: actual.isUserConnectedWalletRecord,
  };
});

jest.mock("@/lib/billing/pro-tier", () => ({
  isProTierUser: jest.fn(),
}));

function stringifyMockCalls(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .flat()
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .join(" ");
}

function extractEmbeddedScript(script: string, path: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = script.match(new RegExp(`printf '%s' '([^']+)' \\| base64 -d > ${escapedPath}`));
  if (!match?.[1]) {
    throw new Error(`Unable to extract embedded script for ${path}`);
  }

  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("applyLiveUpdate", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (decryptApiKey as jest.Mock).mockReturnValue("plain-api-key");
    (resolveCodexDeploymentSecret as jest.Mock).mockReturnValue({ apiKey: "", authBundle: undefined });
    (resolveNousDeploymentSecret as jest.Mock).mockReturnValue({ apiKey: "plain-api-key", authBundle: undefined });
    (getAutoUpdateConfig as jest.Mock).mockReturnValue({ enabled: false, time: "06:00" });
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({});
    (getBankrWalletForInstance as jest.Mock).mockResolvedValue(null);
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValue(null);
    (isProTierUser as jest.Mock).mockResolvedValue({ ok: true, tier: "operator" });
    delete process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED;
    (decryptMemorySystemSecrets as jest.Mock).mockReturnValue(undefined);
    (validateProviderApiKey as jest.Mock).mockResolvedValue({ valid: true });
    (getProfileDeploymentState as jest.Mock).mockResolvedValue({
      profileRoutes: [],
      profilesToRestore: [],
    });
    (resolveGatewayConfiguration as jest.Mock).mockReturnValue({
      fqdn: "agent.example.com",
      gatewayUrl: "https://agent.example.com",
    });
    (buildAgentDeployScript as jest.Mock).mockReturnValue("#!/bin/bash\necho ok\n");
    (buildWebUIProvisioningArtifacts as jest.Mock).mockReturnValue({
      composeYaml: "compose",
      caddyfile: "caddy",
      envFile: "env",
      configYaml: "config",
      hermesEnvFile: "hermesenv",
    });
    (buildWebUIBootstrapScript as jest.Mock).mockReturnValue("#!/bin/bash\necho webui ok\n");
    (resolveProviderBaseUrl as jest.Mock).mockReturnValue(undefined);
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "4242\n",
      stderr: "",
    });
  });

  it("redacts secrets from SSH launch failures before logging them", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "client_secret=super-secret",
      error: "",
    });

    // The launch-failure path now stamps lifecycle_state='failed' before
    // returning, so it needs a working supabase mock (an empty {} throws).
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-123",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    const consoleOutput = stringifyMockCalls(consoleErrorSpy);

    expect(result).toEqual({
      applied: false,
      error: "client_secret=super-secret",
      initiator: USER_LIVE_UPDATE,
    });
    expect(consoleOutput).toContain("[REDACTED]");
    expect(consoleOutput).not.toContain("super-secret");

    consoleErrorSpy.mockRestore();
  });

  it("stamps lifecycle_state='failed' on a redeploy launch failure so recover-stuck-instances re-drives the row", async () => {
    // Regression for #133 (2026-06-09): a launch failure here returns BEFORE the
    // redeploying patch below, so without this stamp a previously-active row is
    // left orphaned with no recovery path — the cause of the 7 stuck instances
    // when a whole fleet-sync wave failed on a shared host. recover-stuck-instances
    // only selects lifecycle_state IN ('failed','provisioning'), so the row must be
    // marked 'failed' before we bail for the cron to ever re-drive it.
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "VM 4242 is not reachable over SSH",
      error: "",
    });

    const captured: Array<{ patch: Record<string, unknown>; eqArgs: unknown[] }> = [];
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn((patch: Record<string, unknown>) => ({
          eq: jest.fn((...eqArgs: unknown[]) => {
            captured.push({ patch, eqArgs });
            return Promise.resolve({ error: null });
          }),
        })),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-launch-fail",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    // We bail with applied:false, but only AFTER stamping the row failed.
    expect(result).toEqual({
      applied: false,
      error: "VM 4242 is not reachable over SSH",
      initiator: USER_LIVE_UPDATE,
    });
    // The failed-stamp is the only write on this path (we return before the
    // redeploying patch) and it must target THIS row with lifecycle_state='failed'
    // so recover-stuck-instances picks it back up.
    expect(captured).toHaveLength(1);
    expect(captured[0].patch).toMatchObject({
      status: "failed",
      lifecycle_state: "failed",
    });
    expect(captured[0].eqArgs).toEqual(["id", "inst-launch-fail"]);

    consoleErrorSpy.mockRestore();
  });

  it("passes Nous vault bundles through live updates without forcing an OPENAI key", async () => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("serialized-nous-session")
      .mockReturnValueOnce("gateway-secret");
    (resolveNousDeploymentSecret as jest.Mock).mockReturnValue({
      apiKey: "",
      authBundle: {
        portalBaseUrl: "https://portal.nousresearch.com",
        inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
        clientId: "hermes-cli",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
    });
    // A shared-host row must fail closed even if stale/user-controlled settings
    // request root access. The host Docker socket would cross tenant boundaries.
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({ enableRootAccess: true });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "4242\n",
      stderr: "",
    });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: updateEq,
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-456",
        user_id: "user-123",
        provider: "nous",
        host_id: "shared-host-1",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-nous",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    // The Nous OAuth bundle still resolves through resolveProviderDeploymentSecret
    // regardless of backend, so an empty session never forces an OPENAI key.
    expect(resolveNousDeploymentSecret).toHaveBeenCalledWith("serialized-nous-session");
    // Post gateway≡webfree collapse: a backend-unset row is webfree, so the WebUI
    // builder runs (not the legacy gateway buildAgentDeployScript). The resolved
    // empty Nous key flows through as an empty llmApiKey with inferenceProvider="nous"
    // — the "no forced OPENAI key" guarantee now lives on the WebUI path.
    expect(buildAgentDeployScript).not.toHaveBeenCalled();
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        inferenceProvider: "nous",
        llmApiKey: "",
        gatewayDockerAccess: false,
      })
    );
    expect(validateProviderApiKey).not.toHaveBeenCalled();
  });

  it("grants opted-in Docker access on a direct dedicated Hetzner VM", async () => {
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({ enableRootAccess: true });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "4242\n",
      stderr: "",
    });

    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-dedicated-hetzner",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 101,
        host_id: null,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayDockerAccess: true,
      })
    );
  });

  it("redacts provider validation errors before writing them to deploy logs", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    (validateProviderApiKey as jest.Mock).mockResolvedValue({
      valid: false,
      error: "request to https://generativelanguage.googleapis.com/v1beta/models?key=super-secret failed",
    });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "4242\n",
      stderr: "",
    });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: updateEq,
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-123",
        user_id: "user-123",
        provider: "gemini",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    const consoleOutput = stringifyMockCalls(consoleWarnSpy);

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    expect(consoleOutput).toContain("key=[REDACTED]");
    expect(consoleOutput).not.toContain("super-secret");

    consoleWarnSpy.mockRestore();
  });

  it("streams large Hetzner update bootstraps over SSH stdin instead of shell argv", async () => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    const largeBootstrapScript = [
      "#!/bin/bash",
      ...Array.from({ length: 20_000 }, () => "echo oversized update payload"),
    ].join("\n");
    (buildWebUIBootstrapScript as jest.Mock).mockReturnValue(largeBootstrapScript);
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "4242\n",
      stderr: "",
    });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: updateEq,
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-large",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });

    const [, launchCommand, launchOptions] = (sshExec as jest.Mock).mock.calls[0];
    expect(launchCommand).toBe("bash -s");
    expect(String(launchCommand).length).toBeLessThan(100);
    expect(launchOptions).toEqual(
      expect.objectContaining({
        timeoutMs: 30_000,
        stdin: expect.any(String),
      })
    );
    expect(launchOptions.stdin).toContain("/tmp/hermes-update-inst-large.sh");
    expect(launchOptions.stdin).toContain("/tmp/hermes-update-wrapper-inst-large.sh");
  });

  it("marks rows redeploying with lifecycle_state=provisioning so the recovery cron picks them up", async () => {
    // Regression for 2026-05-17 incident: the inline status write here was
    // missing lifecycle_state, so recover-stuck-instances (filtered by
    // lifecycle_state IN failed/provisioning) never saw the 124 rows the
    // fleet-sync cron had marked redeploying. Locks in that the patch we
    // send carries both status AND lifecycle_state from buildInstanceLifecyclePatch.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });

    const captured: Array<Record<string, unknown>> = [];
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn((patch: Record<string, unknown>) => {
          captured.push(patch);
          return { eq: jest.fn().mockResolvedValue({ error: null }) };
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-lifecycle",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      status: "redeploying",
      lifecycle_state: "provisioning",
      gateway_url: "https://agent.example.com",
    });
    expect(captured[0]).toHaveProperty("updated_at");
    expect(captured[0]).toHaveProperty("last_lifecycle_transition_at");
    // Stamp the fleet-sync cursor on launch success so the daily :stable
    // sweep advances to the next-oldest cohort instead of re-rolling this VM.
    expect(captured[0]).toHaveProperty("last_synced_at");
    expect(typeof captured[0].last_synced_at).toBe("string");
  });

  it("wraps background manual updates with dashboard status reporting", async () => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "4242\n",
      stderr: "",
    });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: updateEq,
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-789",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });

    const [, launchCommand, launchOptions] = (sshExec as jest.Mock).mock.calls[0];
    expect(launchCommand).toBe("bash -s");
    const innerScript = String(launchOptions?.stdin ?? "");
    const wrapperScript = extractEmbeddedScript(
      innerScript,
      "/tmp/hermes-update-wrapper-inst-789.sh"
    );

    expect(wrapperScript).toContain("/api/u/inst-789");
    expect(wrapperScript).toContain('--data-urlencode "r=$2"');
    expect(wrapperScript).toContain("?s=$1&t=manual");
    expect(wrapperScript).toContain('ru "succeeded" "completed" || true');
    expect(wrapperScript).toContain(
      'ru "failed" "exit_status_${status}" "/tmp/hermes-update-inst-789.log" || true'
    );
    expect(wrapperScript).toContain("echo W >&2");
  });

  it("launches Proxmox-backed live updates through the Proxmox host into the guest VM", async () => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "agent-proxmox.example.com",
    });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: updateEq,
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-proxmox",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: null,
        host_id: null,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 201,
            privateIpv4: "10.250.20.51",
            gatewayHost: "agent-proxmox.example.com",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    expect(sshExec).not.toHaveBeenCalled();
    expect(runProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("10.250.20.51"),
      expect.anything(),
      90_000
    );
    expect(runProxmoxHostScript).toHaveBeenCalledWith(
      expect.stringContaining("VMID='201'"),
      expect.anything(),
      90_000
    );
    // Post gateway≡webfree collapse: a backend-unset Proxmox row is webfree, so the
    // WebUI builder runs (not the legacy gateway buildAgentDeployScript). The guest
    // VM's inner Caddy must bind plain :80, so the WebUI builder gets fqdn="localhost"
    // (public TLS lives on the Proxmox host Caddy; using the public hostname here loops
    // /health on a 308 HTTPS redirect).
    expect(buildAgentDeployScript).not.toHaveBeenCalled();
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        fqdn: "localhost",
      })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "inst-proxmox");

    // Single-tenant VM guard must be present in the wrapper that lands in the guest
    // VM, so a misrouted deploy aborts before it can drop a peer Caddyfile alongside
    // the legitimate tenant's. Decode bastion → inner → wrapper to inspect.
    const bastionScript = String((runProxmoxHostScript as jest.Mock).mock.calls[0][0]);
    const innerB64 = bastionScript.match(/printf '%s' '([^']+)' \| base64 -d \| "\$\{GUEST_SSH\[@\]\}"/)?.[1];
    const innerScript = innerB64 ? Buffer.from(innerB64, "base64").toString("utf8") : "";
    const wrapperScript = extractEmbeddedScript(
      innerScript,
      "/tmp/hermes-update-wrapper-inst-proxmox.sh"
    );
    expect(wrapperScript).toContain("/opt/hermes/instances");
    expect(wrapperScript).toContain("! -name \"inst-proxmox\"");
    expect(wrapperScript).toContain('ru "failed" "stray_tenant_dir_collision"');
  });

  it("keeps the SSH readiness wait inside the host-script timeout so the unreachable-VM diagnostic can fire", async () => {
    // A powered-off VM drops packets instead of sending RST, so every readiness
    // probe burns its full ConnectTimeout. If the loop's worst case outruns the
    // runProxmoxHostScript cap, the cap fires first and `applyLiveUpdate` reports
    // "Proxmox SSH operation timed out after 90000ms" — hiding the "VM <id> is not
    // reachable over SSH at <ip>" message that actually names the fault. That is
    // what happened on 2026-07-16: measured against a real stopped VM the old
    // `seq 1 12` loop took 97s against a 90s cap, so the diagnostic was dead code
    // and a powered-off VM looked like a Proxmox SSH fault. Derive the budget from
    // the emitted script rather than hard-coding it, so retuning the loop must keep
    // the invariant true.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "agent-proxmox.example.com",
    });

    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-proxmox",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: null,
        host_id: null,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 201,
            privateIpv4: "10.250.20.51",
            gatewayHost: "agent-proxmox.example.com",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    const call = (runProxmoxHostScript as jest.Mock).mock.calls[0];
    const script = String(call[0]);
    const timeoutMs = Number(call[2]);

    const attempts = Number(script.match(/SSH_READY_ATTEMPTS=(\d+)/)?.[1]);
    const connectTimeoutS = Number(script.match(/ConnectTimeout=(\d+)/)?.[1]);
    const sleepS = Number(script.match(/-lt "\$SSH_READY_ATTEMPTS" \]; then sleep (\d+)/)?.[1]);
    expect(attempts).toBeGreaterThan(0);
    expect(connectTimeoutS).toBeGreaterThan(0);
    expect(sleepS).toBeGreaterThan(0);
    // Before any SSH the host waits for the VM's guest agent, which attests the
    // host key the connection is pinned to; that wait shares the same cap.
    const agentAttempts = Number(script.match(/HERMES_GUEST_AGENT_ATTEMPTS=(\d+)/)?.[1]);
    const agentPingS = Number(script.match(/timeout (\d+) qm guest cmd "\$VMID" ping/)?.[1]);
    const agentSleepS = Number(script.match(/-lt "\$HERMES_GUEST_AGENT_ATTEMPTS" \]; then sleep (\d+)/)?.[1]);
    expect(agentAttempts).toBeGreaterThan(0);
    expect(agentPingS).toBeGreaterThan(0);
    expect(agentSleepS).toBeGreaterThan(0);

    // No sleep after the final attempt — it would only delay the diagnostic.
    // 10s is left for the qm config/status/guest exec calls between the waits.
    const agentWorstCaseS = agentAttempts * agentPingS + (agentAttempts - 1) * agentSleepS;
    const sshWorstCaseS = attempts * connectTimeoutS + (attempts - 1) * sleepS;
    expect((agentWorstCaseS + sshWorstCaseS + 10) * 1000).toBeLessThan(timeoutMs);

    // The diagnostic the budget exists to protect must still be emitted, and must
    // name the VM and IP rather than leaving the caller with a bare timeout.
    expect(script).toContain('echo "VM $VMID is not reachable over SSH at $PRIVATE_IP" >&2');
  });

  it("resolves the bastion host env from the instance's host (not HERMES_PROXMOX_TARGET)", async () => {
    // Without per-instance host binding, runProxmoxHostScript falls back to the
    // single global HERMES_PROXMOX_TARGET. With fixturenodea+fixturenodea sharing 10.250.20.0/24
    // and overlapping VMIDs, that misroutes updates to the wrong VM.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 304,
      privateIpv4: "10.250.20.84",
      gatewayHost: "agent-fixturenode1.example.com",
      hostSlug: "fixturenode1",
    });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-fixturenode1",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: null,
        host_id: null,
        proxmox_node: "fixturenode1",
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 304,
            privateIpv4: "10.250.20.84",
            hostSlug: "fixturenode1",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    // resolveProxmoxHostEnv should have been asked to resolve the env for fixturenodea's
    // routing (slug/hostId/envPrefix derived from the instance, not from the
    // global HERMES_PROXMOX_TARGET env). `failClosed:true` so a slug that has
    // no matching PROXMOX_<SLUG>_* env throws instead of silently inheriting
    // the ambient PROXMOX_* values (2026-05-17 `fixturelegacy` regression).
    expect(resolveProxmoxHostEnv).toHaveBeenCalledWith(
      expect.objectContaining({ hostSlug: "fixturenode1", failClosed: true }),
      expect.anything()
    );
    // The env passed to runProxmoxHostScript must be the resolved one (object
    // returned from resolveProxmoxHostEnv), not raw process.env, so the
    // downstream call uses fixturenodea's PROXMOX_SSH_HOST instead of falling back
    // through resolveProxmoxTargetConfigurationUnlessHostResolved.
    const [, scriptEnv] = (runProxmoxHostScript as jest.Mock).mock.calls[0];
    expect(scriptEnv).not.toBe(process.env);
  });

  it("surfaces a structured error when the host slug has no matching PROXMOX_<SLUG>_* env", async () => {
    // Regression for 2026-05-17: eleven fixturenodea webui rows had `config.infrastructure.node="fixturelegacy"`
    // (a slug that never existed in Vercel env). With the old `failClosed:false`, resolveProxmoxHostEnv
    // silently returned process.env unchanged, runProxmoxHostScript then offered the stale ambient
    // PROXMOX_SSH_PRIVATE_KEY_B64 (last rotated 17d ago, pre the 2026-05-15 fixturenodea keyrotation), and
    // every redeploy returned "Live redeploy launch failed" — the underlying ssh2 "All configured
    // authentication methods failed" never reached the caller because it was masked by SSH-layer
    // language. With `failClosed:true`, the bad routing throws BEFORE the SSH attempt and we return
    // `{applied:false, error: "...has no matching environment overrides"}` synchronously.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 308,
      privateIpv4: "10.250.20.88",
      gatewayHost: "agent-fixturelegacy.example.com",
      node: "fixturelegacy",
    });
    (resolveProxmoxHostEnv as jest.Mock).mockImplementationOnce(() => {
      throw new Error(
        "Proxmox host routing config for fixturelegacy has no matching environment overrides"
      );
    });

    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-fixturelegacy",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: null,
        host_id: null,
        proxmox_node: null,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 308,
            privateIpv4: "10.250.20.88",
            gatewayHost: "agent-fixturelegacy.example.com",
            node: "fixturelegacy",
          },
        },
      },
      "10.250.20.88",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toMatchObject({ applied: false, error: expect.stringContaining("fixturelegacy") });
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("does not emit the single-tenant guard for non-Proxmox (multi-tenant) hosts", async () => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-hetzner",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    const innerScript = String((sshExec as jest.Mock).mock.calls[0]?.[2]?.stdin ?? "");
    const wrapperScript = extractEmbeddedScript(
      innerScript,
      "/tmp/hermes-update-wrapper-inst-hetzner.sh"
    );
    expect(wrapperScript).not.toContain("stray_tenant_dir_collision");
  });

  it("uses the WebUI bootstrap (not the gateway agent script) when instance.backend === 'webui'", async () => {
    // Regression for the auto-update gap surfaced 2026-05-01: applyLiveUpdate
    // was Proxmox-aware but always built the legacy gateway-agent deploy
    // script, so clicking "Update" on a WebUI-backed instance would have
    // deployed the wrong containers (`agent` + `agent-web` instead of
    // `webui` + `sidecar`) and broken the running agent. The fix branches
    // on instance.backend so WebUI runtimes get the right bootstrap.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 205,
      privateIpv4: "10.250.20.55",
      gatewayHost: "agent-webui.example.com",
    });
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({
      tavilyApiKey: "tav-key",
      firecrawlApiKey: "fc-key",
      enableRootAccess: true,
      terminalBackend: "docker",
    });
    const bankrAgentConfig = {
      walletAddress: "0x000000000000000000000000000000000000ba5e",
      apiKey: "bk_agent_wallet_key",
      walletId: "wlt_agent_123",
      withdrawalDestination: null,
    };
    (getBankrWalletForInstance as jest.Mock).mockResolvedValue({ id: "wallet-row" });
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValue(bankrAgentConfig);

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-webui",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        cpu_limit: 2,
        ram_limit: 4096,
        config: {
          model: "kimi-k2.5",
          infrastructure: {
            provider: "proxmox",
            vmid: 205,
            privateIpv4: "10.250.20.55",
            gatewayHost: "agent-webui.example.com",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    // Critically: the WebUI builder must run; the gateway builder must NOT.
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledTimes(1);
    expect(buildWebUIBootstrapScript).toHaveBeenCalledTimes(1);
    expect(buildAgentDeployScript).not.toHaveBeenCalled();
    expect((runProxmoxHostScript as jest.Mock).mock.calls[0]?.[0]).toContain(
      "HERMES_TEST_TENANT_ISOLATION_GUARD"
    );

    // The WebUI builder must receive the right shape: stable webui password
    // (so already-issued bearer tokens keep working), per-row container
    // name, and the agent settings the row carries. For Proxmox specifically
    // the guest VM's inner Caddy must bind plain :80; TLS lives on the
    // public Proxmox host Caddy, so using the public hostname here causes
    // Caddy to issue a 308 HTTPS redirect loop for /health.
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-webui",
        containerName: "agent-inst-webui",
        fqdn: "localhost",
        cpuLimit: 2,
        ramLimit: 4096,
        defaultModel: "kimi-k2.5",
        webuiPassword: "gateway-secret",
        tavilyApiKey: "tav-key",
        firecrawlApiKey: "fc-key",
        bankr: bankrAgentConfig,
        gatewayDockerAccess: true,
        terminalBackend: "docker",
      })
    );
  });

  it("nulls personaSoulPrompt and pins the persisted operatoros image for an Operator OS WebUI update", async () => {
    // Regression for the Operator OS reversion bug: applyLiveUpdate resolved a
    // persona soul from the stored systemPrompt with no operatoros gate (a
    // leaked Bea soul would be re-seeded over the box's autonomy SOUL) and
    // passed no agentImage, so resolveWebUIAgentImage fell back to the env
    // default and every update regenerated compose on the vanilla image.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 206,
      privateIpv4: "10.250.20.56",
      gatewayHost: "agent-operatoros.example.com",
    });
    // A REAL authored soul as the stored prompt base — the un-gated path would
    // resolve it (persona-souls-accessor is unmocked here), so personaSoulPrompt
    // coming back null proves the flavor gate, not an unresolvable prompt.
    const beaSoul = getPersonaSoulPrompt("bea");
    expect(beaSoul.trim().length).toBeGreaterThan(500);
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({ systemPrompt: beaSoul });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    const result = await applyLiveUpdate(
      {
        id: "inst-operatoros",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          agentFlavor: "operatoros",
          webuiAgentImage: "ghcr.io/ashneil12/operatoros-agent:stable",
          infrastructure: {
            provider: "proxmox",
            vmid: 206,
            privateIpv4: "10.250.20.56",
            gatewayHost: "agent-operatoros.example.com",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        personaSoulPrompt: null,
        agentImage: "ghcr.io/ashneil12/operatoros-agent:stable",
      }),
      "update"
    );
  });

  it("fails closed when a legacy Operator OS row has no pinned image", async () => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 208,
      privateIpv4: "10.250.20.58",
      gatewayHost: "agent-operatoros-noimage.example.com",
    });
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({ systemPrompt: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await expect(applyLiveUpdate(
      {
        id: "inst-operatoros-noimage",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          agentFlavor: "operatoros",
          infrastructure: {
            provider: "proxmox",
            vmid: 208,
            privateIpv4: "10.250.20.58",
            gatewayHost: "agent-operatoros-noimage.example.com",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    )).rejects.toThrow("missing its pinned runtime image");

    expect(buildWebUIProvisioningArtifacts).not.toHaveBeenCalled();
  });

  it("still resolves the welcome persona soul on update for a non-operatoros WebUI row", async () => {
    // Companion guard: the operatoros gate must not over-fire — a plain
    // persona box keeps its authored soul re-seeded on the update path.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 207,
      privateIpv4: "10.250.20.57",
      gatewayHost: "agent-bea.example.com",
    });
    const beaSoul = getPersonaSoulPrompt("bea");
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({ systemPrompt: beaSoul });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-bea",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 207,
            privateIpv4: "10.250.20.57",
            gatewayHost: "agent-bea.example.com",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        personaSoulPrompt: beaSoul,
      })
    );
    // No persisted image → no override; resolveWebUIAgentImage keeps its
    // existing env-fallback behavior for vanilla boxes.
    const webUIParams = (buildWebUIProvisioningArtifacts as jest.Mock).mock.calls[0][0];
    expect(webUIParams.agentImage).toBeUndefined();
  });

  it("drops persisted browser-sidecar opt-in during WebUI live update unless the deployment gate is enabled", async () => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({
      browserSidecarEnabled: true,
    });
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-webui-sidecar-gated",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          model: "kimi-k2.5",
        },
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(isProTierUser).not.toHaveBeenCalled();
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSidecarEnabled: false,
      })
    );
  });

  it("keeps persisted browser-sidecar opt-in during WebUI live update when the deployment gate is enabled", async () => {
    process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED = "1";
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({
      browserSidecarEnabled: true,
    });
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-webui-sidecar-enabled",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          model: "kimi-k2.5",
        },
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(isProTierUser).toHaveBeenCalledWith("user-123");
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSidecarEnabled: true,
      })
    );
  });

  it("drops persisted browser-sidecar opt-in during WebUI live update when the tier no longer qualifies", async () => {
    process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED = "1";
    (isProTierUser as jest.Mock).mockResolvedValue({
      ok: false,
      tier: "credit_base",
      reason: "tier_not_eligible",
    });
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({
      browserSidecarEnabled: true,
    });
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-webui-sidecar-tier-dropped",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {
          model: "kimi-k2.5",
        },
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(isProTierUser).toHaveBeenCalledWith("user-123");
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSidecarEnabled: false,
      })
    );
  });

  it("enables browser-sidecar by DEFAULT for a Pro+ WebUI instance with no explicit opt-in", async () => {
    process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED = "1";
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    // getRuntimeAgentSettings defaults to {} in beforeEach → no explicit opt-in.
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-webui-sidecar-default",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: { model: "kimi-k2.5" },
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(isProTierUser).toHaveBeenCalledWith("user-123");
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ browserSidecarEnabled: true })
    );
  });

  it("honors an explicit opt-out (browserSidecarEnabled: false) on a Pro+ WebUI instance", async () => {
    process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED = "1";
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({ browserSidecarEnabled: false });
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-webui-sidecar-optout",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: { model: "kimi-k2.5" },
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    // Opt-out short-circuits before the tier check and disables the sidecar.
    expect(isProTierUser).not.toHaveBeenCalled();
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ browserSidecarEnabled: false })
    );
  });

  it("keeps Codex OAuth bundles when a WebUI row stores the openai-codex provider alias", async () => {
    const codexBundle = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      lastRefresh: "2026-05-06T12:00:00.000Z",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("serialized-codex-session")
      .mockReturnValueOnce("gateway-secret");
    (resolveCodexDeploymentSecret as jest.Mock).mockReturnValue({
      apiKey: "",
      authBundle: codexBundle,
    });
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-codex-webui",
        user_id: "user-123",
        provider: "openai-codex",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-codex",
        api_server_key_encrypted: "enc-gateway",
        config: {
          model: "gpt-5.5",
        },
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(resolveCodexDeploymentSecret).toHaveBeenCalledWith("serialized-codex-session");
    expect(buildWebUIProvisioningArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        inferenceProvider: "openai-codex",
        llmApiKey: "",
        codexAuthBundle: codexBundle,
      })
    );
    expect(validateProviderApiKey).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])("only synchronizes native terminal YAML for explicit apply intent %s", async (applyTerminalBackend) => {
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-terminal-intent",
        user_id: "user-123",
        provider: "openai",
        backend: "webui",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      applyTerminalBackend === undefined
        ? { initiator: USER_LIVE_UPDATE }
        : { initiator: USER_LIVE_UPDATE, applyTerminalBackend },
    );

    expect(buildWebUIBootstrapScript).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      applyTerminalBackend === true
        ? { mode: "update", applyTerminalBackend: true, additionalProvisioningScript: expect.any(String) }
        : { mode: "update", additionalProvisioningScript: expect.any(String) },
    );
  });

  it("routes a backend-unset row through the WebUI (webfree) builder after the gateway≡webfree collapse", async () => {
    // Rows that pre-date the addition of the `backend` column have it unset/null,
    // which resolves to "gateway". Post gateway≡webfree collapse, isWebfreeBackend
    // returns true for "gateway" too, so the WebUI builder now runs for these rows
    // and the legacy gateway buildAgentDeployScript path is dormant (no backend value
    // routes to it). A "gateway"/unset box is treated identically to a "webui" box.
    (decryptApiKey as jest.Mock)
      .mockReturnValueOnce("plain-api-key")
      .mockReturnValueOnce("gateway-secret");
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: updateEq }),
      }),
    } as unknown as SupabaseClient;

    await applyLiveUpdate(
      {
        id: "inst-legacy",
        user_id: "user-123",
        provider: "openai",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        // No `backend` field — legacy row.
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );

    expect(buildWebUIBootstrapScript).toHaveBeenCalledTimes(1);
    expect(buildAgentDeployScript).not.toHaveBeenCalled();
  });
});

const USER_CONNECTED = "user_owned_bankr_account";
const HIVRA_PROVISIONED = "bankr_custodied_agent_wallet";
const bankrConfig = {
  walletAddress: "0x00000000000000000000000000000000000c0ffe",
  apiKey: "bk_test_runtime_key",
  walletId: "user:0x00000000000000000000000000000000000c0ffe",
  withdrawalDestination: null,
};

const USER_WALLET_ADDRESS = "0x00000000000000000000000000000000000c0ffe";
// Wallets from the user's own Bankr account that later reconnects replaced,
// oldest first, and the Hivra-created wallet the first connect replaced.
const K1_WALLET_ADDRESS = "0x0000000000000000000000000000000000000a11";
const OLDER_WALLET_ADDRESS = "0x0000000000000000000000000000000000000b22";
const HIVRA_WALLET_ADDRESS = "0x000000000000000000000000000000000000ba5e";

function walletRow(
  custodyModel: string,
  status: "active" | "pending" | "failed" | "revoked",
  overrides: Record<string, unknown> = {}
) {
  // A disconnect keeps the row's address; only the key is dropped.
  return {
    id: "wallet-row-1",
    status,
    evmAddress: USER_WALLET_ADDRESS,
    normalizedEvmAddress: USER_WALLET_ADDRESS,
    metadata: { custodyModel },
    ...overrides,
  };
}

describe("applyLiveUpdate in-flight turn gate", () => {
  const FLEET_SYNC = systemLiveUpdate("fleet_sync");

  function supabaseCapturing() {
    const patches: Array<Record<string, unknown>> = [];
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn((patch: Record<string, unknown>) => {
          patches.push(patch);
          return { eq: jest.fn().mockResolvedValue({ error: null }) };
        }),
      }),
    } as unknown as SupabaseClient;
    return { supabase, patches };
  }

  const row = (id: string) => ({
    id,
    user_id: "user-123",
    provider: "openai",
    backend: "gateway" as const,
    hetzner_server_id: 1,
    api_key_encrypted: "enc-api-key",
    api_server_key_encrypted: "enc-gateway",
    config: {},
  });

  function launchedInnerScript(): string {
    return String((sshExec as jest.Mock).mock.calls[0]?.[2]?.stdin ?? "");
  }

  function gateReport(fields: string) {
    return `HERMES_INFLIGHT_GATE ${fields}\n`;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (decryptApiKey as jest.Mock).mockReturnValue("plain-api-key");
    (getAutoUpdateConfig as jest.Mock).mockReturnValue({ enabled: false, time: "06:00" });
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({});
    (getBankrWalletForInstance as jest.Mock).mockResolvedValue(null);
    (isProTierUser as jest.Mock).mockResolvedValue({ ok: false, reason: "not_pro" });
    (validateProviderApiKey as jest.Mock).mockResolvedValue({ valid: true });
    (getProfileDeploymentState as jest.Mock).mockResolvedValue({ profileRoutes: [], profilesToRestore: [] });
    (resolveGatewayConfiguration as jest.Mock).mockReturnValue({
      fqdn: "agent.example.com",
      gatewayUrl: "https://agent.example.com",
    });
    (buildWebUIProvisioningArtifacts as jest.Mock).mockReturnValue({ configYaml: "config" });
    (buildWebUIBootstrapScript as jest.Mock).mockReturnValue("#!/bin/bash\necho webui ok\n");
    (resolveProviderBaseUrl as jest.Mock).mockReturnValue(undefined);
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
  });

  it("checks the box for an in-flight turn before a system update writes or launches anything", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout:
        gateReport(
          "action=proceed verdict=idle reason=no_turn_in_flight trigger=fleet_sync live=0 unreadable=0 gateway_active=0 gateway_unknown=0 deferrals=0 streak_s=0"
        ) + "4242\n",
      stderr: "",
    });
    const { supabase } = supabaseCapturing();

    const result = await applyLiveUpdate(row("inst-gate-order"), "127.0.0.1", {}, supabase, { initiator: FLEET_SYNC });

    expect(result).toMatchObject({ applied: true, initiator: FLEET_SYNC });
    const inner = launchedInnerScript();
    const gateScript = extractEmbeddedScript(inner, "/tmp/hermes-update-gate-inst-gate-order.sh");
    expect(gateScript).toBe(
      buildInFlightUpdateGateScript({
        instanceId: "inst-gate-order",
        trigger: "fleet_sync",
        budgetSeconds: INFLIGHT_UPDATE_GATE_BUDGET_SECONDS,
      })
    );
    const gateIdx = inner.indexOf('hermes_update_gate_report="$(bash /tmp/hermes-update-gate-inst-gate-order.sh');
    const deferExitIdx = inner.indexOf('*"action=defer"*) exit 0');
    const clearIdx = inner.indexOf("rm -f '/var/lib/hermes-update-deferrals-inst-gate-order.'*");
    const writeIdx = inner.indexOf("> /tmp/hermes-update-inst-gate-order.sh");
    const launchIdx = inner.indexOf("nohup bash /tmp/hermes-update-wrapper-inst-gate-order.sh");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(deferExitIdx).toBeGreaterThan(gateIdx);
    // A launched update ends every caller's streak, after the gate let it through.
    expect(clearIdx).toBeGreaterThan(deferExitIdx);
    expect(writeIdx).toBeGreaterThan(clearIdx);
    expect(launchIdx).toBeGreaterThan(writeIdx);
  });

  it.each([
    ["pending-resize sweep", "pending_resize_sweep" as const],
    ["unhealthy-box recovery", "unhealthy_recovery" as const],
  ])("runs the gate with the %s's own policy", async (_label, trigger) => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
    const { supabase } = supabaseCapturing();

    await applyLiveUpdate(row("inst-gate-trigger"), "127.0.0.1", {}, supabase, {
      initiator: systemLiveUpdate(trigger),
    });

    const gateScript = extractEmbeddedScript(launchedInnerScript(), "/tmp/hermes-update-gate-inst-gate-trigger.sh");
    expect(gateScript).toBe(
      buildInFlightUpdateGateScript({
        instanceId: "inst-gate-trigger",
        trigger,
        budgetSeconds: INFLIGHT_UPDATE_GATE_BUDGET_SECONDS,
      })
    );
    expect(gateScript).toContain(`TRIGGER='${trigger}'`);
  });

  // The gate runs inside the launch's SSH session. Its worst case (the probe's
  // budget plus slack, bounded in inflight-update-gate.test.ts) must come on top
  // of the lane's own launch time, or a slow Docker on the box would turn a
  // system update into a failed launch.
  it("gives a gated Hetzner launch its 30 s plus the gate's worst case", async () => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
    const { supabase } = supabaseCapturing();

    await applyLiveUpdate(row("inst-gate-hetzner"), "127.0.0.1", {}, supabase, { initiator: FLEET_SYNC });

    const [, , options] = (sshExec as jest.Mock).mock.calls[0];
    expect(options.timeoutMs).toBeGreaterThanOrEqual(
      30_000 + (INFLIGHT_UPDATE_GATE_BUDGET_SECONDS + INFLIGHT_UPDATE_GATE_SLACK_SECONDS) * 1000
    );
    expect(options.timeoutMs).toBe(48_000);
  });

  it("gives a gated Proxmox launch its 90 s plus the gate's worst case", async () => {
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "agent-proxmox.example.com",
    });
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
    const { supabase } = supabaseCapturing();

    await applyLiveUpdate(
      {
        ...row("inst-gate-proxmox"),
        hetzner_server_id: null,
        host_id: null,
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 201,
            privateIpv4: "10.250.20.51",
            gatewayHost: "agent-proxmox.example.com",
          },
        },
      },
      "",
      {},
      supabase,
      { initiator: FLEET_SYNC }
    );

    expect(runProxmoxHostScript).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      90_000 + (INFLIGHT_UPDATE_GATE_BUDGET_SECONDS + INFLIGHT_UPDATE_GATE_SLACK_SECONDS) * 1000
    );
  });

  it.each([
    ["user", USER_LIVE_UPDATE],
    ["operator", OPERATOR_LIVE_UPDATE],
  ])("keeps the lane's own launch timeout when the %s asked for the update (no gate to wait for)", async (_label, initiator) => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
    const { supabase } = supabaseCapturing();

    await applyLiveUpdate(row("inst-ungated"), "127.0.0.1", {}, supabase, { initiator });

    expect((sshExec as jest.Mock).mock.calls[0][2].timeoutMs).toBe(30_000);
  });

  it.each([
    ["defer", false],
    ["proceed", true],
  ])("the launch script writes and launches only when the gate does not defer (gate says %s)", (action, launches) => {
    // Run the launch script's own control flow with the gate swapped for a stub
    // that prints the given verdict, and the write/launch replaced by a marker.
    const id = `inst-gate-flow-${action}`;
    return (async () => {
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
      const { supabase } = supabaseCapturing();
      await applyLiveUpdate(row(id), "127.0.0.1", {}, supabase, { initiator: FLEET_SYNC });
      const inner = launchedInnerScript();
      const stub = `#!/usr/bin/env bash\necho "HERMES_INFLIGHT_GATE action=${action} verdict=busy reason=in_flight_turn trigger=fleet_sync live=1 unreadable=0 gateway_active=0 gateway_unknown=0 deferrals=1 streak_s=0"\n`;
      const writeIdx = inner.indexOf(`printf '%s' '`, inner.indexOf("esac"));
      const gatePortion = inner
        .slice(0, writeIdx)
        .replace(/printf '%s' '[^']+' \| base64 -d > (\/tmp\/hermes-update-gate-[^\n]+)/, `printf '%s' '${Buffer.from(stub).toString("base64")}' | base64 -d > $1`);
      const run = spawnSync("bash", ["-c", `${gatePortion}\necho LAUNCHED`], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`HERMES_INFLIGHT_GATE action=${action}`);
      expect(run.stdout.includes("LAUNCHED")).toBe(launches);
    })();
  });

  it("reports deferred_busy and leaves the row untouched when a turn is in flight", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: gateReport(
        "action=defer verdict=busy reason=in_flight_turn trigger=fleet_sync live=1 unreadable=0 gateway_active=0 gateway_unknown=0 deferrals=2 streak_s=900"
      ),
      stderr: "",
    });
    const info = jest.spyOn(log, "info");
    const { supabase, patches } = supabaseCapturing();

    const result = await applyLiveUpdate(row("inst-busy"), "127.0.0.1", {}, supabase, { initiator: FLEET_SYNC });

    expect(result).toEqual({
      applied: false,
      deferred: true,
      reason: "deferred_busy",
      error: expect.stringContaining("in flight"),
      initiator: FLEET_SYNC,
      inFlightGate: {
        action: "defer",
        verdict: "busy",
        reason: "in_flight_turn",
        trigger: "fleet_sync",
        liveTurns: 1,
        unreadableMarkers: 0,
        gatewayActive: 0,
        gatewayUnknown: 0,
        deferrals: 2,
        streakSeconds: 900,
      },
    });
    // No redeploying/failed lifecycle patch and no last_synced_at bump.
    expect(patches).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "system live update deferred: agent turn in flight",
      expect.objectContaining({ instanceId: "inst-busy", trigger: "fleet_sync", deferrals: 2 })
    );
    info.mockRestore();
  });

  it("proceeds loudly once the deferral cap is reached", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout:
        gateReport(
          "action=proceed verdict=busy reason=deferral_cap trigger=fleet_sync live=1 unreadable=0 gateway_active=0 gateway_unknown=0 deferrals=2 streak_s=172900"
        ) + "4242\n",
      stderr: "",
    });
    const warn = jest.spyOn(log, "warn");
    const { supabase, patches } = supabaseCapturing();

    const result = await applyLiveUpdate(row("inst-capped"), "127.0.0.1", {}, supabase, { initiator: FLEET_SYNC });

    expect(result).toMatchObject({
      applied: true,
      initiator: FLEET_SYNC,
      inFlightGate: { action: "proceed", reason: "deferral_cap", deferrals: 2 },
    });
    expect(patches[0]).toMatchObject({ status: "redeploying", last_synced_at: expect.any(String) });
    expect(warn).toHaveBeenCalledWith(
      "system live update proceeding past the in-flight gate",
      expect.objectContaining({ instanceId: "inst-capped", gateReason: "deferral_cap" })
    );
    warn.mockRestore();
  });

  it("says a deferral on an unknown verdict could not confirm the box was idle", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: gateReport(
        "action=defer verdict=unknown reason=turn_state_unknown trigger=fleet_sync live=0 unreadable=0 gateway_active=0 gateway_unknown=1 deferrals=1 streak_s=0"
      ),
      stderr: "",
    });
    const info = jest.spyOn(log, "info");
    const warn = jest.spyOn(log, "warn");
    const { supabase, patches } = supabaseCapturing();

    const result = await applyLiveUpdate(row("inst-unknown"), "127.0.0.1", {}, supabase, { initiator: FLEET_SYNC });

    expect(result).toMatchObject({
      applied: false,
      deferred: true,
      reason: "deferred_unverified",
      error: expect.stringContaining("could not confirm that no agent turn is running"),
      inFlightGate: { verdict: "unknown", gatewayUnknown: 1 },
    });
    expect(patches).toEqual([]);
    // Not a turn in flight: possibly a gateway that is failing, so it is loud.
    expect(warn).toHaveBeenCalledWith(
      "system live update deferred: could not confirm no agent turn is running",
      expect.objectContaining({
        instanceId: "inst-unknown",
        failureType: "live_update_deferred_unverified",
        verdict: "unknown",
        gatewayUnknown: 1,
      })
    );
    expect(info).not.toHaveBeenCalledWith("system live update deferred: agent turn in flight", expect.anything());
    info.mockRestore();
    warn.mockRestore();
  });

  it("warns when unhealthy-box recovery proceeds on an unknown verdict", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout:
        gateReport(
          "action=proceed verdict=unknown reason=turn_state_unknown trigger=unhealthy_recovery live=- unreadable=- gateway_active=- gateway_unknown=- deferrals=0 streak_s=0"
        ) + "4242\n",
      stderr: "",
    });
    const warn = jest.spyOn(log, "warn");
    const { supabase, patches } = supabaseCapturing();

    const result = await applyLiveUpdate(row("inst-recover-unknown"), "127.0.0.1", {}, supabase, {
      initiator: systemLiveUpdate("unhealthy_recovery"),
    });

    expect(result).toMatchObject({ applied: true, inFlightGate: { action: "proceed", verdict: "unknown" } });
    expect(patches[0]).toMatchObject({ status: "redeploying" });
    expect(warn).toHaveBeenCalledWith(
      "system live update proceeding past the in-flight gate",
      expect.objectContaining({
        instanceId: "inst-recover-unknown",
        trigger: "unhealthy_recovery",
        failureType: "live_update_gate_unverified",
      })
    );
    warn.mockRestore();
  });

  it("says so when a gated launch printed no gate report", async () => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
    const warn = jest.spyOn(log, "warn");
    const { supabase } = supabaseCapturing();

    const result = await applyLiveUpdate(row("inst-noreport"), "127.0.0.1", {}, supabase, { initiator: FLEET_SYNC });

    expect(result).toMatchObject({
      applied: true,
      inFlightGate: { action: "proceed", verdict: "unknown", reason: "gate_report_missing" },
    });
    expect(warn).toHaveBeenCalledWith(
      "system live update launched without an in-flight gate report",
      expect.objectContaining({ instanceId: "inst-noreport" })
    );
    warn.mockRestore();
  });

  it.each([
    ["user", USER_LIVE_UPDATE],
    ["operator", OPERATOR_LIVE_UPDATE],
  ])("a %s-initiated update skips the gate but ends any deferral streak", async (_label, initiator) => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
    const { supabase } = supabaseCapturing();

    const result = await applyLiveUpdate(row("inst-user"), "127.0.0.1", {}, supabase, { initiator });

    expect(result).toEqual({ applied: true, initiator, inFlightGate: null });
    const inner = launchedInnerScript();
    expect(inner).not.toContain("hermes-update-gate-");
    expect(inner.split("\n")[0]).toBe("rm -f '/var/lib/hermes-update-deferrals-inst-user.'*");
  });

  it("refreshes the idle-gated update stack only where the box already runs it", async () => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
    const { supabase } = supabaseCapturing();

    await applyLiveUpdate(row("inst-stack"), "127.0.0.1", {}, supabase, { initiator: USER_LIVE_UPDATE });

    const options = (buildWebUIBootstrapScript as jest.Mock).mock.calls[0][2];
    const refresh = String(options.additionalProvisioningScript);
    expect(refresh.startsWith("# Refresh the idle-gated update stack only where it is already installed.\nif [ -x '/usr/local/bin/hermes-roll-inst-stack' ]; then\n")).toBe(true);
    expect(refresh).toContain(
      buildIdleGatedUpdateProvisioningScript({ instanceId: "inst-stack", backend: "gateway" })
    );
    expect(refresh.trimEnd().endsWith("fi")).toBe(true);
    const syntax = spawnSync("bash", ["-n"], { input: refresh, encoding: "utf8" });
    expect(syntax.status).toBe(0);
  });
});

describe("resolveBankrRuntimeEnvPlanForUpdate", () => {
  const db = {} as SupabaseClient;
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(log, "warn").mockImplementation(() => {});
    infoSpy = jest.spyOn(log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("preserves the box's key when the wallet lookup fails, with today's warning", async () => {
    (getBankrWalletForInstance as jest.Mock).mockRejectedValueOnce(new Error("connection reset"));

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "preserve",
      reason: "lookup_failed",
    });
    expect(buildInstanceBankrAgentConfig).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "bankr agent config unavailable during live update",
      expect.objectContaining({ failureType: "bankr_agent_config_update_unavailable", instanceId: "inst-1" })
    );
  });

  it("preserves when there is no wallet row", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(null);

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "preserve",
      reason: "no_wallet",
    });
    expect(buildInstanceBankrAgentConfig).not.toHaveBeenCalled();
  });

  it("clears only a user-connected wallet the user disconnected, without decrypting anything", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(walletRow(USER_CONNECTED, "revoked"));

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "clear",
      reason: "user_disconnected",
      walletAddresses: [USER_WALLET_ADDRESS],
    });
    expect(buildInstanceBankrAgentConfig).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ instanceId: "inst-1", walletRowId: "wallet-row-1", bankrRuntimeEnv: "clear" })
    );
  });

  it("hands the update the disconnected wallet's address, lower-cased, so it clears only that wallet's values", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(
      walletRow(USER_CONNECTED, "revoked", {
        evmAddress: "0x00000000000000000000000000000000000C0FFE",
        normalizedEvmAddress: undefined,
      })
    );

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toMatchObject({
      action: "clear",
      walletAddresses: [USER_WALLET_ADDRESS],
    });
  });

  it("clears every wallet the row has delivered, not only its current one", async () => {
    // K1 was delivered with a restart; the user then reconnected (twice)
    // without one, so the box can still hold any earlier wallet.
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(
      walletRow(USER_CONNECTED, "revoked", {
        metadata: {
          custodyModel: USER_CONNECTED,
          priorUserConnectedAddresses: [OLDER_WALLET_ADDRESS, "0x0000000000000000000000000000000000000A11", "junk"],
          replacedProvisionedWallet: { bankrWalletId: "wlt_1", evmAddress: HIVRA_WALLET_ADDRESS },
        },
      })
    );

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "clear",
      reason: "user_disconnected",
      // Current first, then the most recent earlier wallet, then the Hivra one.
      walletAddresses: [USER_WALLET_ADDRESS, K1_WALLET_ADDRESS, OLDER_WALLET_ADDRESS, HIVRA_WALLET_ADDRESS],
    });
    expect(buildInstanceBankrAgentConfig).not.toHaveBeenCalled();
  });

  it("still clears the row's earlier wallets when its current address is unusable", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(
      walletRow(USER_CONNECTED, "revoked", {
        evmAddress: "",
        normalizedEvmAddress: null,
        metadata: { custodyModel: USER_CONNECTED, priorUserConnectedAddresses: [K1_WALLET_ADDRESS] },
      })
    );

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "clear",
      reason: "user_disconnected",
      walletAddresses: [K1_WALLET_ADDRESS],
    });
  });

  it("preserves, and warns, when a disconnected wallet row has no usable address", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(
      walletRow(USER_CONNECTED, "revoked", { evmAddress: "", normalizedEvmAddress: "not-an-address" })
    );

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "preserve",
      reason: "disconnected_address_unknown",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ failureType: "bankr_runtime_env_clear_without_address", instanceId: "inst-1" })
    );
  });

  it("upserts an active Hivra-provisioned wallet with no address set (today's script)", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(walletRow(HIVRA_PROVISIONED, "active"));
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValueOnce(bankrConfig);

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "upsert",
      config: bankrConfig,
      userConnected: false,
    });
  });

  it("upserts an active user-connected wallet with every address the row has delivered", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(
      walletRow(USER_CONNECTED, "active", {
        metadata: { custodyModel: USER_CONNECTED, priorUserConnectedAddresses: [OLDER_WALLET_ADDRESS, K1_WALLET_ADDRESS] },
      })
    );
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValueOnce(bankrConfig);

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "upsert",
      config: bankrConfig,
      userConnected: true,
      walletAddresses: [USER_WALLET_ADDRESS, K1_WALLET_ADDRESS, OLDER_WALLET_ADDRESS],
    });
  });

  it("puts the delivered wallet in the set once, so a new key for the same wallet refreshes profile copies", async () => {
    // K1 -> K2 on one address: nothing earlier to remember, but the set still
    // names the delivered wallet.
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(walletRow(USER_CONNECTED, "active"));
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValueOnce({
      ...bankrConfig,
      apiKey: "bk_test_runtime_key_k2",
      walletAddress: "0x00000000000000000000000000000000000C0FFE",
    });

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toMatchObject({
      action: "upsert",
      userConnected: true,
      walletAddresses: [USER_WALLET_ADDRESS],
    });
  });

  it("preserves when decrypting the key throws", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(walletRow(USER_CONNECTED, "active"));
    (buildInstanceBankrAgentConfig as jest.Mock).mockRejectedValueOnce(new Error("bad ciphertext"));

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "preserve",
      reason: "lookup_failed",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "bankr agent config unavailable during live update",
      expect.objectContaining({ failureType: "bankr_agent_config_update_unavailable" })
    );
  });

  it.each(["revoked", "pending", "failed"] as const)(
    "never clears a Hivra-provisioned wallet in status %s",
    async (status) => {
      (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce(walletRow(HIVRA_PROVISIONED, status));
      (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValueOnce(null);

      await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
        action: "preserve",
        reason: "not_deliverable",
      });
    }
  );

  it("never clears a row whose custody is unknown or missing", async () => {
    (getBankrWalletForInstance as jest.Mock).mockResolvedValueOnce({ id: "wallet-row", status: "revoked" });
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValueOnce(null);

    await expect(resolveBankrRuntimeEnvPlanForUpdate("inst-1", db)).resolves.toEqual({
      action: "preserve",
      reason: "not_deliverable",
    });
  });
});

describe("applyLiveUpdate BANKR_* reconcile flag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (decryptApiKey as jest.Mock).mockReturnValue("plain-api-key");
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({});
    (getBankrWalletForInstance as jest.Mock).mockResolvedValue(null);
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValue(null);
    (isProTierUser as jest.Mock).mockResolvedValue({ ok: false, tier: "free" });
    (validateProviderApiKey as jest.Mock).mockResolvedValue({ valid: true });
    (getProfileDeploymentState as jest.Mock).mockResolvedValue({ profileRoutes: [], profilesToRestore: [] });
    (resolveGatewayConfiguration as jest.Mock).mockReturnValue({
      fqdn: "agent.example.com",
      gatewayUrl: "https://agent.example.com",
    });
    (buildWebUIProvisioningArtifacts as jest.Mock).mockReturnValue({
      composeYaml: "compose",
      caddyfile: "caddy",
      envFile: "env",
      configYaml: "config",
      hermesEnvFile: "hermesenv",
    });
    (buildWebUIBootstrapScript as jest.Mock).mockReturnValue("#!/bin/bash\necho webui ok\n");
    (resolveProviderBaseUrl as jest.Mock).mockReturnValue(undefined);
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "1\n", stderr: "" });
  });

  async function webUIParamsFor(setup: () => void): Promise<Record<string, unknown>> {
    setup();
    const supabase = {
      from: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }),
      }),
    } as unknown as SupabaseClient;
    const result = await applyLiveUpdate(
      {
        id: "inst-webfree",
        user_id: "user-123",
        provider: "openai",
        backend: "gateway",
        hetzner_server_id: 1,
        api_key_encrypted: "enc-api-key",
        api_server_key_encrypted: "enc-gateway",
        config: {},
      },
      "127.0.0.1",
      {},
      supabase,
      { initiator: USER_LIVE_UPDATE }
    );
    expect(result).toEqual({ applied: true, initiator: USER_LIVE_UPDATE, inFlightGate: null });
    const params = (buildWebUIProvisioningArtifacts as jest.Mock).mock.calls[0][0];
    // The bootstrap builder must see the very same params.
    expect((buildWebUIBootstrapScript as jest.Mock).mock.calls[0][1]).toBe(params);
    return params;
  }

  it("asks for a BANKR_* clear only for a disconnected user-connected wallet", async () => {
    const params = await webUIParamsFor(() => {
      (getBankrWalletForInstance as jest.Mock).mockResolvedValue(walletRow(USER_CONNECTED, "revoked"));
    });

    expect(params.bankrRuntimeReconcile).toEqual({
      action: "clear_user_disconnected",
      walletAddresses: [USER_WALLET_ADDRESS],
    });
    expect(params.bankr).toBeNull();
  });

  it("hands the update script every wallet a disconnected row has delivered", async () => {
    const params = await webUIParamsFor(() => {
      (getBankrWalletForInstance as jest.Mock).mockResolvedValue(
        walletRow(USER_CONNECTED, "revoked", {
          metadata: { custodyModel: USER_CONNECTED, priorUserConnectedAddresses: [K1_WALLET_ADDRESS] },
        })
      );
    });

    expect(params.bankrRuntimeReconcile).toEqual({
      action: "clear_user_disconnected",
      walletAddresses: [USER_WALLET_ADDRESS, K1_WALLET_ADDRESS],
    });
  });

  it("asks for the yaml strip when a user-connected key is delivered", async () => {
    const params = await webUIParamsFor(() => {
      (getBankrWalletForInstance as jest.Mock).mockResolvedValue(walletRow(USER_CONNECTED, "active"));
      (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValue(bankrConfig);
    });

    expect(params.bankrRuntimeReconcile).toEqual({ action: "replace_user_connected", walletAddresses: [USER_WALLET_ADDRESS] });
    expect(params.bankr).toBe(bankrConfig);
  });

  it("hands a connect every wallet the row has delivered, so profile copies of any of them are replaced", async () => {
    const params = await webUIParamsFor(() => {
      (getBankrWalletForInstance as jest.Mock).mockResolvedValue(
        walletRow(USER_CONNECTED, "active", {
          metadata: {
            custodyModel: USER_CONNECTED,
            priorUserConnectedAddresses: [K1_WALLET_ADDRESS],
            replacedProvisionedWallet: { evmAddress: HIVRA_WALLET_ADDRESS },
          },
        })
      );
      (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValue(bankrConfig);
    });

    expect(params.bankrRuntimeReconcile).toEqual({
      action: "replace_user_connected",
      walletAddresses: [USER_WALLET_ADDRESS, K1_WALLET_ADDRESS, HIVRA_WALLET_ADDRESS],
    });
  });

  it.each([
    ["the wallet lookup fails", () => (getBankrWalletForInstance as jest.Mock).mockRejectedValue(new Error("timeout"))],
    ["there is no wallet", () => (getBankrWalletForInstance as jest.Mock).mockResolvedValue(null)],
    [
      "the key can't be decrypted",
      () => {
        (getBankrWalletForInstance as jest.Mock).mockResolvedValue(walletRow(USER_CONNECTED, "active"));
        (buildInstanceBankrAgentConfig as jest.Mock).mockRejectedValue(new Error("bad ciphertext"));
      },
    ],
    [
      "an active Hivra-provisioned wallet is delivered",
      () => {
        (getBankrWalletForInstance as jest.Mock).mockResolvedValue(walletRow(HIVRA_PROVISIONED, "active"));
        (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValue(bankrConfig);
      },
    ],
    ["a Hivra-provisioned wallet is revoked", () => (getBankrWalletForInstance as jest.Mock).mockResolvedValue(walletRow(HIVRA_PROVISIONED, "revoked"))],
    ["a Hivra-provisioned wallet is pending", () => (getBankrWalletForInstance as jest.Mock).mockResolvedValue(walletRow(HIVRA_PROVISIONED, "pending"))],
    [
      "a disconnected user wallet has no usable address",
      () => (getBankrWalletForInstance as jest.Mock).mockResolvedValue(walletRow(USER_CONNECTED, "revoked", { evmAddress: "", normalizedEvmAddress: null })),
    ],
  ])("passes no flag (today's script) when %s", async (_label, setup) => {
    const warnSpy = jest.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const params = await webUIParamsFor(setup);
      expect("bankrRuntimeReconcile" in params).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("resolveInstanceIpv4", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the cached instance ipv4 without querying supabase or hetzner", async () => {
    const from = jest.fn();
    const supabase = { from } as unknown as SupabaseClient;

    await expect(
      resolveInstanceIpv4(
        {
          id: "inst-123",
          user_id: "user-123",
          provider: "openai",
          api_key_encrypted: "enc",
          ipv4_address: "203.0.113.10",
        },
        supabase
      )
    ).resolves.toBe("203.0.113.10");

    expect(from).not.toHaveBeenCalled();
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
  });
});
