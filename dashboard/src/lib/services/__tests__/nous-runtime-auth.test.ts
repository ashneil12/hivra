import { encryptApiKey } from "@/lib/crypto";
import { serializeNousVaultBundle, type NousVaultBundle } from "@/lib/nous-oauth";
import {
  repairNousRuntimeAuthFromStoredSession,
  syncNousRuntimeAuthStore,
} from "../nous-runtime-auth";
import { sshExec } from "@/lib/hetzner/ssh";

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

describe("nous-runtime-auth", () => {
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
  const bundle: NousVaultBundle = {
    portalBaseUrl: "https://portal.nousresearch.com",
    inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
    clientId: "hermes-cli",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    obtainedAt: "2026-04-22T09:00:00.000Z",
    expiresAt: "2026-04-22T10:00:00.000Z",
    expiresIn: 3600,
    agentKey: "nk-live",
    agentKeyExpiresAt: "2026-04-23T09:00:00.000Z",
    source: "stored-vault",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  it("uses a heredoc when syncing Nous auth into the runtime container so shell traps stay valid", async () => {
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: '{"changed":1,"synced":1}',
      stderr: "",
    });

    const result = await syncNousRuntimeAuthStore(
      "inst-123",
      "192.0.2.40", null,
      bundle,
      "/opt/data"
    );

    expect(result).toEqual({ changed: true });

    const command = mockedSshExec.mock.calls[0]?.[1];
    expect(command).toContain(`LEGACY_BASE_HOME="/root/.hermes"`);
    expect(command).toContain(`sh -s <<'SH'`);
    expect(command).toContain(`trap 'rm -f "$TMP_FILE"' EXIT`);
    expect(command).toContain(`existing_owner="$(stat -c "%U:%G" "$target_home" 2>/dev/null || true)"`);
    expect(command).toContain(`lock_owner="$(stat -c "%U:%G" "$lock_path" 2>/dev/null || true)"`);
    expect(command).toContain(`lock_mode="$(stat -c "%a" "$lock_path" 2>/dev/null || true)"`);
    expect(command).toContain(`AUTH_B64="`);
    expect(command).not.toContain(`sh -lc '`);
  });

  it("includes the webfree gateway container among the sync candidates", async () => {
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: '{"changed":1,"synced":1}',
      stderr: "",
    });

    await syncNousRuntimeAuthStore("inst-123", "192.0.2.40", null, bundle, "/home/hermes/.hermes");

    const command = mockedSshExec.mock.calls[0]?.[1];
    expect(command).toContain(
      "for container_name in agent-inst-123 agent-inst-123-web agent-inst-123-acp agent-inst-123-mcp agent-inst-123-gateway; do"
    );
  });

  it("repairs stored Nous sessions and restarts the gateway only when the runtime auth changes", async () => {
    mockedSshExec
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":1,"synced":1}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"restarted":true}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":1,"synced":1}',
        stderr: "",
      });

    const encryptedBundle = encryptApiKey(serializeNousVaultBundle(bundle));
    const result = await repairNousRuntimeAuthFromStoredSession({
      instanceId: "inst-123",
      hostIp: "192.0.2.40",
      guestTarget: null,
      hermesHomeDir: "/root/.hermes",
      encryptedInstanceSecret: encryptedBundle,
      provider: "nous",
    });

    expect(result).toEqual({
      attempted: true,
      changed: true,
      restarted: true,
    });
    expect(mockedSshExec).toHaveBeenCalledTimes(3);

    const restartCommand = mockedSshExec.mock.calls[1]?.[1];
    expect(restartCommand).toContain("hermes_ensure_time_sync()");
    expect(restartCommand).toContain("/var/log/hermes-time-sync.log");
    expect(restartCommand!.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      restartCommand!.indexOf("docker restart $RESTART_CONTAINERS")
    );
  });

  it("skips repair when the instance is not using Nous", async () => {
    const encryptedBundle = encryptApiKey(serializeNousVaultBundle(bundle));

    await expect(
      repairNousRuntimeAuthFromStoredSession({
        instanceId: "inst-123",
        hostIp: "192.0.2.40",
        guestTarget: null,
        hermesHomeDir: "/root/.hermes",
        encryptedInstanceSecret: encryptedBundle,
        provider: "openrouter",
      })
    ).resolves.toEqual({
      attempted: false,
      changed: false,
      restarted: false,
    });

    expect(mockedSshExec).not.toHaveBeenCalled();
  });

  it("repairs stored Nous Portal alias sessions too", async () => {
    mockedSshExec
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":1,"synced":1}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"restarted":true}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":1,"synced":1}',
        stderr: "",
      });

    const encryptedBundle = encryptApiKey(serializeNousVaultBundle(bundle));
    const result = await repairNousRuntimeAuthFromStoredSession({
      instanceId: "inst-123",
      hostIp: "192.0.2.40",
      guestTarget: null,
      hermesHomeDir: "/root/.hermes",
      encryptedInstanceSecret: encryptedBundle,
      provider: "nous-portal",
    });

    expect(result).toEqual({
      attempted: true,
      changed: true,
      restarted: true,
    });
    expect(mockedSshExec).toHaveBeenCalledTimes(3);
  });

  it("repairs host clock drift even when the Nous runtime auth store already matches", async () => {
    mockedSshExec
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"changed":0,"synced":1}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      });

    const encryptedBundle = encryptApiKey(serializeNousVaultBundle(bundle));
    const result = await repairNousRuntimeAuthFromStoredSession({
      instanceId: "inst-123",
      hostIp: "192.0.2.40",
      guestTarget: null,
      hermesHomeDir: "/root/.hermes",
      encryptedInstanceSecret: encryptedBundle,
      provider: "nous",
    });

    expect(result).toEqual({
      attempted: true,
      changed: false,
      restarted: false,
    });
    expect(mockedSshExec).toHaveBeenCalledTimes(2);

    const timeSyncCommand = mockedSshExec.mock.calls[1]?.[1];
    expect(timeSyncCommand).toContain("hermes_ensure_time_sync()");
    expect(timeSyncCommand).toContain("/var/log/hermes-time-sync.log");
    expect(timeSyncCommand).not.toContain("docker restart $RESTART_CONTAINERS");
  });
});
