import { supabaseAdmin } from "./src/lib/supabase";
import crypto from "node:crypto";
import { fetch as undiciFetch } from "undici";

const fetch = undiciFetch as unknown as typeof globalThis.fetch;

function getLocalRequire(): NodeJS.Require | null {
  try {
    return Function("return require")() as NodeJS.Require;
  } catch {
    return null;
  }
}

const localRequire = getLocalRequire();

function loadQwenConfig(): Record<string, unknown> {
  if (!localRequire) {
    return {};
  }

  try {
    return localRequire("./config.js") as Record<string, unknown>;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "MODULE_NOT_FOUND"
    ) {
      return {};
    }
    throw error;
  }
}

const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
const QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000;

function getSafeAuthErrorDetails(error: unknown): { errorName: string; errorCode?: string } {
  if (error && typeof error === "object") {
    const errorCode =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

    return {
      errorName: error instanceof Error ? error.name : "object",
      errorCode,
    };
  }

  return {
    errorName: typeof error,
  };
}

function writeAuthLog(
  level: "info" | "warn" | "error",
  message: string,
  metadata: Record<string, unknown> = {}
): void {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(
    `${JSON.stringify({
      source: "qwen-auth",
      level,
      message,
      ...metadata,
    })}\n`
  );
}

export type QwenCredentials = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  resource_url?: string;
  expiry_date?: number;
  [key: string]: unknown;
};

export type DeviceFlowResult = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  code_verifier: string;
  [key: string]: unknown;
};

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(codeVerifier);
  return hash.digest("base64url");
}

function generatePKCEPair(): { code_verifier: string; code_challenge: string } {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { code_verifier: codeVerifier, code_challenge: codeChallenge };
}

export class QwenAuthManager {
  credentials: QwenCredentials | null;
  refreshPromises: Map<string, Promise<QwenCredentials>>;
  refreshThresholdMinutes: Map<string, number>;
  accounts: Map<string, QwenCredentials>;
  currentAccountIndex: number;
  qwenAPI: unknown;

  constructor() {
    this.credentials = null;
    this.refreshPromises = new Map();
    this.refreshThresholdMinutes = new Map();
    this.accounts = new Map();
    this.currentAccountIndex = 0;
    this.qwenAPI = null;
  }

  init(qwenAPI: unknown): void {
    this.qwenAPI = qwenAPI;
  }

  async loadCredentials(): Promise<QwenCredentials | null> {
    const config = loadQwenConfig();
    if (config.qwenCodeAuthUse === false) {
      return null;
    }

    if (this.credentials) {
      return this.credentials;
    }

    try {
      const { data, error } = await supabaseAdmin!
        .from("qwen_oauth_credentials")
        .select("*")
        .eq("account_id", "default")
        .maybeSingle();

      if (error || !data) {
        return null;
      }

      this.credentials = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type: data.token_type,
        resource_url: data.resource_url,
        expiry_date: data.expiry_date ? Number(data.expiry_date) : undefined,
        ...(data.metadata || {})
      };
      return this.credentials;
    } catch {
      return null;
    }
  }

  async loadAllAccounts(): Promise<Map<string, QwenCredentials>> {
    this.accounts.clear();

    if (!supabaseAdmin) {
      writeAuthLog("warn", "loadAllAccounts: supabaseAdmin is not initialized.", {
        failureType: "qwen_supabase_unavailable",
      });
      return this.accounts;
    }

    try {
      const { data: accounts, error } = await supabaseAdmin
        .from("qwen_oauth_credentials")
        .select("*");

      if (error) {
        writeAuthLog("warn", "Failed to load multi-account credentials from Supabase.", {
          failureType: "qwen_multi_account_load_failed",
          ...getSafeAuthErrorDetails(error),
        });
        return this.accounts;
      }

      const config = loadQwenConfig();
      if (config.qwenCodeAuthUse === false) {
        return this.accounts; // Return empty map if auth usage disabled
      }

      for (const row of accounts) {
        const credentials: QwenCredentials = {
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          token_type: row.token_type,
          resource_url: row.resource_url,
          expiry_date: row.expiry_date ? Number(row.expiry_date) : undefined,
          ...(row.metadata || {})
        };
        this.accounts.set(row.account_id, credentials);
      }
    } catch (err: unknown) {
      writeAuthLog("warn", "loadAllAccounts failed.", {
        failureType: "qwen_load_all_accounts_failed",
        ...getSafeAuthErrorDetails(err),
      });
    }

    return this.accounts;
  }

  async saveCredentials(credentials: QwenCredentials, accountId: string | null = null): Promise<void> {
    try {
      const dbAccountId = accountId || "default";
      const { access_token, refresh_token, token_type, resource_url, expiry_date, ...rest } = credentials;

      const payload = {
        account_id: dbAccountId,
        access_token,
        refresh_token: refresh_token || null,
        token_type: token_type || null,
        resource_url: resource_url || null,
        expiry_date: expiry_date || null,
        metadata: Object.keys(rest).length > 0 ? rest : null,
        updated_at: new Date().toISOString()
      };

      if (supabaseAdmin) {
        const { error } = await supabaseAdmin
          .from("qwen_oauth_credentials")
          .upsert(payload, { onConflict: "account_id" });

        if (error) throw error;
      }

      if (accountId) {
        this.accounts.set(accountId, credentials);
      } else {
        this.credentials = credentials;
        this.accounts.set("default", credentials); // ensure default is also in accounts map
      }
    } catch (error: unknown) {
      writeAuthLog("error", "Error saving credentials to Supabase.", {
        failureType: "qwen_credentials_save_failed",
        ...getSafeAuthErrorDetails(error),
      });
    }
  }

  isTokenValid(credentials: QwenCredentials | null): boolean {
    if (!credentials || !credentials.access_token || !credentials.expiry_date) {
      return false;
    }
    if (typeof credentials.access_token !== "string" || credentials.access_token.length === 0) {
      return false;
    }
    if (Number.isNaN(credentials.expiry_date) || credentials.expiry_date <= 0) {
      return false;
    }
    return Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS;
  }

  normalizeAccountKey(accountId: string | null = null): string {
    return accountId || "default";
  }

  getRefreshThresholdMinutes(accountId: string | null = null): number {
    const accountKey = this.normalizeAccountKey(accountId);
    if (!this.refreshThresholdMinutes.has(accountKey)) {
      this.refreshThresholdMinutes.set(accountKey, Math.floor(Math.random() * 21) + 10);
    }
    return this.refreshThresholdMinutes.get(accountKey) ?? 10;
  }

  shouldRefreshToken(credentials: QwenCredentials | null, accountId: string | null = null): boolean {
    if (!credentials || !credentials.access_token || !credentials.expiry_date) {
      return true;
    }

    const expiryDate = Number(credentials.expiry_date);
    if (Number.isNaN(expiryDate) || expiryDate <= 0) {
      return true;
    }

    const refreshThresholdMs = this.getRefreshThresholdMinutes(accountId) * 60 * 1000;
    return Date.now() >= expiryDate - refreshThresholdMs;
  }

  getAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  getAccountCredentials(accountId: string): QwenCredentials | null {
    return this.accounts.get(accountId) || null;
  }

  async addAccount(credentials: QwenCredentials, accountId: string): Promise<void> {
    await this.saveCredentials(credentials, accountId);
  }

  async removeAccount(accountId: string): Promise<void> {
    if (supabaseAdmin) {
      await supabaseAdmin.from("qwen_oauth_credentials").delete().eq("account_id", accountId);
    }
    this.accounts.delete(accountId);
  }

  async refreshAccessToken(credentials: QwenCredentials): Promise<QwenCredentials> {
    writeAuthLog("info", "Refreshing Qwen access token.");

    if (!credentials || !credentials.refresh_token) {
      throw new Error("No refresh token available. Please re-authenticate with the Qwen CLI.");
    }

    const bodyData = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID,
    });

    try {
      const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: bodyData,
      });

      if (!response.ok) {
        const errorData = await response.json() as Record<string, string>;
        throw new Error(`Token refresh failed: ${errorData.error} - ${errorData.error_description}`);
      }

      const tokenData = await response.json() as { access_token: string, token_type?: string, refresh_token?: string, resource_url?: string, expires_in: number };
      const newCredentials: QwenCredentials = {
        ...credentials,
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        refresh_token: tokenData.refresh_token || credentials.refresh_token,
        resource_url: tokenData.resource_url || credentials.resource_url,
        expiry_date: Date.now() + tokenData.expires_in * 1000,
      };

      writeAuthLog("info", "Qwen access token refreshed successfully.");
      return newCredentials;
    } catch (error: unknown) {
      writeAuthLog("error", "Failed to refresh Qwen access token.", {
        failureType: "qwen_token_refresh_failed",
        ...getSafeAuthErrorDetails(error),
      });
      throw new Error("Failed to refresh access token. Please re-authenticate with the Qwen CLI.");
    }
  }

  async getValidAccessToken(accountId: string | null = null): Promise<string> {
    let credentials: QwenCredentials | null;

    if (accountId) {
      credentials = this.getAccountCredentials(accountId);
      if (!credentials) {
        await this.loadAllAccounts();
        credentials = this.getAccountCredentials(accountId);
      }
    } else {
      credentials = await this.loadCredentials();
    }

    if (!credentials) {
      if (accountId) {
        throw new Error(`No credentials found for account ${accountId}. Please authenticate this account first.`);
      }
      throw new Error("No credentials found. Please authenticate with Qwen CLI first.");
    }

    if (!this.shouldRefreshToken(credentials, accountId)) {
      return credentials.access_token;
    }

    const refreshedCredentials = await this.refreshCredentialsIfNeeded(credentials, accountId);
    return refreshedCredentials.access_token;
  }

  async refreshCredentialsIfNeeded(credentials: QwenCredentials, accountId: string | null = null, options: { force?: boolean } = {}): Promise<QwenCredentials> {
    const { force = false } = options;
    const accountKey = this.normalizeAccountKey(accountId);

    if (!credentials) {
      throw new Error(`No credentials found for account ${accountKey}. Please authenticate this account first.`);
    }

    if (!force && !this.shouldRefreshToken(credentials, accountId)) {
      return credentials;
    }

    if (this.refreshPromises.has(accountKey)) {
      writeAuthLog("info", "Waiting for ongoing token refresh.", { accountKey });
      return this.refreshPromises.get(accountKey) as Promise<QwenCredentials>;
    }

    const refreshPromise = this.performTokenRefresh(credentials, accountId)
      .then((newCredentials) => {
        this.refreshThresholdMinutes.delete(accountKey);
        return newCredentials;
      })
      .finally(() => {
        this.refreshPromises.delete(accountKey);
      });

    this.refreshPromises.set(accountKey, refreshPromise);
    return refreshPromise;
  }

  async performTokenRefresh(credentials: QwenCredentials, accountId: string | null = null): Promise<QwenCredentials> {
    try {
      const newCredentials = await this.refreshAccessToken(credentials);
      if (accountId) {
        await this.saveCredentials(newCredentials, accountId);
      } else {
        await this.saveCredentials(newCredentials);
      }
      return newCredentials;
    } catch (error: unknown) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async getNextAccount(): Promise<{ accountId: string; credentials: QwenCredentials | null } | null> {
    if (this.accounts.size === 0) {
      await this.loadAllAccounts();
    }

    const accountIds = this.getAccountIds();
    if (accountIds.length === 0) {
      return null;
    }

    const accountId = accountIds[this.currentAccountIndex];
    const credentials = this.getAccountCredentials(accountId);
    this.currentAccountIndex = (this.currentAccountIndex + 1) % accountIds.length;
    return { accountId, credentials };
  }

  peekNextAccount(): { accountId: string; credentials: QwenCredentials | null } | null {
    if (this.accounts.size === 0) {
      return null;
    }

    const accountIds = this.getAccountIds();
    if (accountIds.length === 0) {
      return null;
    }

    const accountId = accountIds[this.currentAccountIndex];
    const credentials = this.getAccountCredentials(accountId);
    return { accountId, credentials };
  }

  isAccountValid(accountId: string): boolean {
    const credentials = this.getAccountCredentials(accountId);
    return Boolean(credentials && this.isTokenValid(credentials));
  }

  async initiateDeviceFlow(): Promise<DeviceFlowResult> {
    const { code_verifier, code_challenge } = generatePKCEPair();
    const bodyData = new URLSearchParams({
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: QWEN_OAUTH_SCOPE,
      code_challenge,
      code_challenge_method: "S256",
    });

    try {
      const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: bodyData,
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Device authorization failed: ${response.status} ${response.statusText}. Response: ${errorData}`);
      }

      const result = await response.json() as Record<string, string>;
      if (!result.device_code) {
        throw new Error(`Device authorization failed: ${result.error || "Unknown error"} - ${result.error_description || "No details provided"}`);
      }

      return {
        ...result,
        code_verifier,
      } as DeviceFlowResult;
    } catch (error: unknown) {
      writeAuthLog("error", "Device authorization flow failed.", {
        failureType: "qwen_device_authorization_failed",
        ...getSafeAuthErrorDetails(error),
      });
      throw error;
    }
  }

  async pollForToken(device_code: string, code_verifier: string, accountId: string | null = null): Promise<QwenCredentials> {
    let pollInterval = 5000;
    const maxAttempts = 60;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const bodyData = new URLSearchParams({
        grant_type: QWEN_OAUTH_GRANT_TYPE,
        client_id: QWEN_OAUTH_CLIENT_ID,
        device_code,
        code_verifier,
      });

      try {
        const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: bodyData,
        });

        if (!response.ok) {
          // Read the body ONCE and try to parse it. The previous version
          // called response.json() then `await response.text()` in the
          // catch — but the body had already been consumed, so the catch
          // only ever produced an empty Response field. It also caught
          // (and rewrote) the legitimate "Device token poll failed:"
          // throw paths below it, so a real OAuth error became a
          // statusText-only message.
          const rawBody = await response.text();
          let errorData: Record<string, string> | null = null;
          if (rawBody) {
            try {
              errorData = JSON.parse(rawBody) as Record<string, string>;
            } catch {
              errorData = null;
            }
          }

          if (errorData && response.status === 400) {
            if (errorData.error === "authorization_pending") {
              await new Promise((resolve) => setTimeout(resolve, pollInterval));
              continue;
            }

            if (errorData.error === "slow_down") {
              pollInterval = Math.min(pollInterval * 1.5, 10000);
              await new Promise((resolve) => setTimeout(resolve, pollInterval));
              continue;
            }

            if (errorData.error === "expired_token") {
              throw new Error(
                "expired_token: Device code expired. Please restart the authentication process."
              );
            }

            if (errorData.error === "access_denied") {
              throw new Error(
                "access_denied: Authorization denied by user. Please restart the authentication process."
              );
            }
          }

          // Definite-failure responses (parsed JSON with an unknown error
          // field, or an unparseable body) are NOT retryable. Tag the
          // thrown message so the outer catch propagates it instead of
          // silently looping until maxAttempts.
          const detail = errorData?.error || rawBody || response.statusText;
          throw new Error(`Device token poll failed: ${response.status} ${detail}`);
        }

        const tokenData = await response.json() as { access_token: string, token_type?: string, refresh_token?: string, resource_url?: string, endpoint?: string, expires_in?: number };
        const credentials: QwenCredentials = {
          access_token: tokenData.access_token as string,
          refresh_token: (tokenData.refresh_token as string) || undefined,
          token_type: tokenData.token_type,
          resource_url: tokenData.resource_url || tokenData.endpoint,
          expiry_date: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
        };

        await this.saveCredentials(credentials, accountId);
        return credentials;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Any of these strings indicates a known, terminal OAuth failure.
        // Without `Device token poll failed` in the list, definite-failure
        // responses (e.g. invalid_grant, server_error) used to be
        // swallowed and the loop retried for the full 5-minute budget.
        if (
          errorMessage.includes("expired_token") ||
          errorMessage.includes("access_denied") ||
          errorMessage.includes("Device authorization failed") ||
          errorMessage.includes("Device token poll failed")
        ) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error("Authentication timeout. Please restart the authentication process.");
  }
}
