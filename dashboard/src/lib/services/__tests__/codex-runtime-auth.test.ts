import { encryptApiKey } from "@/lib/crypto";
import { serializeCodexVaultBundle, type CodexVaultBundle } from "@/lib/codex-oauth";
import {
  loadUserCodexVaultBundle,
  repairCodexRuntimeAuthFromStoredSession,
  syncCodexRuntimeAuthStore,
} from "../codex-runtime-auth";
import { sshExec } from "@/lib/hetzner/ssh";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("codex-runtime-auth", () => {
  const mockedSshExec = sshExec as jest.MockedFunction<typeof sshExec>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const bundle: CodexVaultBundle = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    lastRefresh: "2026-04-21T09:00:00.000Z",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    source: "stored-vault",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  it("loads the newest active Codex Vault session for fallback runtime repair", async () => {
    const encryptedBundle = encryptApiKey(serializeCodexVaultBundle(bundle));
    const limit = jest.fn().mockReturnThis();
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: "vault-newest",
        encrypted_key: encryptedBundle,
      },
      error: null,
    });
    const order = jest.fn().mockReturnValue({ limit, maybeSingle });
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order,
    };
    limit.mockReturnValue({ maybeSingle });
    mockedFrom.mockReturnValue(query);

    await expect(loadUserCodexVaultBundle("user_123")).resolves.toMatchObject({
      bundle,
      encryptedKey: encryptedBundle,
      vaultKeyId: "vault-newest",
    });

    expect(query.eq).toHaveBeenCalledWith("provider", "codex");
    expect(query.eq).toHaveBeenCalledWith("is_active", true);
    expect(query.eq).not.toHaveBeenCalledWith("name", "Codex OAuth Session");
    expect(order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("uses a heredoc when syncing auth into the runtime container so shell traps stay valid", async () => {
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: '{"changed":1,"synced":1}',
      stderr: "",
    });

    const result = await syncCodexRuntimeAuthStore(
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
    expect(command).not.toContain(`sh -lc '`);
  });

  it("includes the webfree gateway container among the sync candidates", async () => {
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: '{"changed":1,"synced":1}',
      stderr: "",
    });

    await syncCodexRuntimeAuthStore("inst-123", "192.0.2.40", null, bundle, "/home/hermes/.hermes");

    const command = mockedSshExec.mock.calls[0]?.[1];
    expect(command).toContain(
      "for container_name in agent-inst-123 agent-inst-123-web agent-inst-123-acp agent-inst-123-mcp agent-inst-123-gateway; do"
    );
  });

  it("warns when no candidate container is running so topology drift stays visible", async () => {
    const warnSpy = jest.spyOn(log, "warn").mockImplementation(() => {});
    mockedSshExec.mockResolvedValue({
      ok: true,
      stdout: '{"changed":0,"synced":0}',
      stderr: "",
    });

    try {
      const result = await syncCodexRuntimeAuthStore(
        "inst-123",
        "192.0.2.40", null,
        bundle,
        "/home/hermes/.hermes"
      );

      expect(result).toEqual({ changed: false });
      expect(warnSpy).toHaveBeenCalledWith(
        "no running agent container matched while syncing Codex runtime auth",
        expect.objectContaining({
          source: "codex-runtime-auth",
          instanceId: "inst-123",
          candidateContainers: expect.stringContaining("agent-inst-123-gateway"),
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("repairs stored Codex sessions and restarts the gateway only when the runtime auth changes", async () => {
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

    const encryptedBundle = encryptApiKey(serializeCodexVaultBundle(bundle));
    const result = await repairCodexRuntimeAuthFromStoredSession({
      instanceId: "inst-123",
      hostIp: "192.0.2.40",
      guestTarget: null,
      hermesHomeDir: "/root/.hermes",
      encryptedInstanceSecret: encryptedBundle,
      provider: "codex",
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

  it("repairs stored Codex sessions when the stored provider is the WebUI openai-codex alias", async () => {
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

    const encryptedBundle = encryptApiKey(serializeCodexVaultBundle(bundle));
    const result = await repairCodexRuntimeAuthFromStoredSession({
      instanceId: "inst-123",
      hostIp: "192.0.2.40",
      guestTarget: null,
      hermesHomeDir: "/home/hermes/.hermes",
      encryptedInstanceSecret: encryptedBundle,
      provider: "openai-codex",
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
