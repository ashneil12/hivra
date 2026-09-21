import { formatKeyPreview } from "@/lib/crypto";
import { formatStoredNousSecretPreview } from "@/lib/nous-oauth";
import { isCodexAuthProvider } from "@/lib/provider-auth";
import { checkOutboundUrlSafety } from "@/lib/url-safety";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

function safeBundleBaseUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // The bundle's `base_url` originates from container stdout. A
  // compromised agent could substitute the default with an attacker
  // host so dashboard fetches leak the user's Codex credentials.
  // Drop any URL that fails the loopback / metadata check; the caller
  // falls back to DEFAULT_CODEX_BASE_URL.
  return checkOutboundUrlSafety(trimmed).ok ? trimmed : undefined;
}
const CODEX_AUTH_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_TOKEN_URL_FALLBACK = `${CODEX_AUTH_ISSUER}/oauth/token`;
const CODEX_OAUTH_USER_AGENT = "Codex/0.122.0-alpha.1 (Hermes OAuth helper)";

export const CODEX_VAULT_KEY_NAME = "Codex OAuth Session";
export const CODEX_VAULT_KEY_PREVIEW = "OAuth session (reusable)";
export const CODEX_DISCONNECTED_PREVIEW = "Not connected";
export const CODEX_DEFAULT_MODEL = "gpt-5.5";

export interface CodexVaultBundle {
  accessToken: string;
  refreshToken: string;
  lastRefresh: string;
  baseUrl?: string;
  source?: string;
}

interface CodexVaultBundleWireFormat {
  kind: "codex_oauth_bundle";
  version: 1;
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  base_url?: string;
  source?: string;
}

function isCodexVaultBundleWireFormat(value: unknown): value is CodexVaultBundleWireFormat {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "codex_oauth_bundle" &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { access_token?: unknown }).access_token === "string" &&
    typeof (value as { refresh_token?: unknown }).refresh_token === "string" &&
    typeof (value as { last_refresh?: unknown }).last_refresh === "string"
  );
}

function buildDockerPythonCommand(
  instanceId: string,
  pythonCode: string,
  execUser = "root",
  hermesHomeDir?: string
): string {
  const sanitizedExecUser = execUser.trim() || "root";
  return [
    // Webfree VMs run agent-<id>-gateway instead of the bare agent-<id>
    // container (still used by the Hetzner docker lane). Resolve whichever
    // is running in the same SSH round trip. When neither exists, emit the
    // exact docker "No such container" stderr so failure classification
    // still maps to container_unavailable.
    `AGENT_CONTAINER=""`,
    `for candidate_container in agent-${instanceId} agent-${instanceId}-gateway; do`,
    `  if docker inspect --format='{{.State.Running}}' "$candidate_container" 2>/dev/null | grep -q true; then`,
    `    AGENT_CONTAINER="$candidate_container"`,
    `    break`,
    `  fi`,
    `done`,
    `if [ -z "$AGENT_CONTAINER" ]; then`,
    `  echo "Error response from daemon: No such container: agent-${instanceId}" >&2`,
    `  exit 1`,
    `fi`,
    `docker exec -u ${JSON.stringify(sanitizedExecUser)} -i "$AGENT_CONTAINER" sh -lc '`,
    `set -e`,
    ...(hermesHomeDir
      ? [`export HERMES_HOME=${JSON.stringify(hermesHomeDir)}`]
      : []),
    `HERMES_AGENT_DIR="\${HERMES_WEBUI_AGENT_DIR:-\${HERMES_HOME:-}/hermes-agent}"`,
    `PYTHON_BIN=/app/venv/bin/python`,
    `if [ ! -x "$PYTHON_BIN" ]; then`,
    `  PYTHON_BIN=/opt/venv/bin/python`,
    `fi`,
    `if [ ! -x "$PYTHON_BIN" ]; then`,
    `  PYTHON_BIN=/opt/hermes/.venv/bin/python`,
    `fi`,
    `if [ ! -x "$PYTHON_BIN" ] && [ -n "$HERMES_AGENT_DIR" ]; then`,
    `  PYTHON_BIN="$HERMES_AGENT_DIR/.venv/bin/python"`,
    `fi`,
    `if [ ! -x "$PYTHON_BIN" ]; then`,
    `  PYTHON_BIN=$(command -v python3 || command -v python)`,
    `fi`,
    `export PYTHONPATH="\${HERMES_WEBUI_AGENT_DIR:-\${HERMES_HOME:-}/hermes-agent}:\${PYTHONPATH:-}"`,
    `"$PYTHON_BIN" -`,
    `' <<'PY'`,
    pythonCode.trim(),
    `PY`,
  ].join("\n");
}

export function buildCodexStartCommand(
  instanceId: string,
  execUser = "root",
  hermesHomeDir?: string
): string {
  const pythonCode = String.raw`
import json
import importlib
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

auth_module = importlib.import_module("hermes_cli.auth")
CODEX_OAUTH_CLIENT_ID = getattr(auth_module, "CODEX_OAUTH_CLIENT_ID", None)
if not CODEX_OAUTH_CLIENT_ID:
    raise RuntimeError("CODEX_OAUTH_CLIENT_ID is unavailable in hermes_cli.auth.")

issuer = "${CODEX_AUTH_ISSUER}"
hermes_home = Path(os.environ.get("HERMES_HOME") or "/root/.hermes")
flow_path = hermes_home / ".codex_device_flow.json"
flow_path.parent.mkdir(parents=True, exist_ok=True)

request = Request(
    f"{issuer}/api/accounts/deviceauth/usercode",
    data=json.dumps({"client_id": CODEX_OAUTH_CLIENT_ID}).encode("utf-8"),
    headers={
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "${CODEX_OAUTH_USER_AGENT}",
    },
    method="POST",
)

try:
    with urlopen(request, timeout=15.0) as response:
        payload = json.loads(response.read().decode("utf-8"))
except HTTPError as exc:
    body = exc.read().decode("utf-8", errors="replace")
    raise RuntimeError(f"Codex device auth request failed (HTTP {exc.code}): {body}") from exc
except URLError as exc:
    raise RuntimeError(f"Codex device auth request failed: {exc.reason}") from exc

user_code = str(payload.get("user_code", "") or "").strip()
device_auth_id = str(payload.get("device_auth_id", "") or "").strip()
if not user_code or not device_auth_id:
    raise RuntimeError("Device code response missing user_code or device_auth_id.")

try:
    poll_interval = max(1, int(payload.get("interval", 5)))
except Exception:
    poll_interval = 5

flow_state = {
    "issuer": issuer,
    "device_auth_id": device_auth_id,
    "user_code": user_code,
    "interval": poll_interval,
    "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
flow_path.write_text(json.dumps(flow_state), encoding="utf-8")

print(json.dumps({
    "url": f"{issuer}/codex/device",
    "code": user_code,
}))
`;

  return buildDockerPythonCommand(instanceId, pythonCode, execUser, hermesHomeDir);
}

export function buildCodexStatusCommand(
  instanceId: string,
  execUser = "root",
  hermesHomeDir?: string
): string {
  const pythonCode = String.raw`
import contextlib
import importlib
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

auth_module = importlib.import_module("hermes_cli.auth")
AuthError = getattr(auth_module, "AuthError", RuntimeError)
CODEX_OAUTH_CLIENT_ID = getattr(auth_module, "CODEX_OAUTH_CLIENT_ID", None)
if not CODEX_OAUTH_CLIENT_ID:
    raise RuntimeError("CODEX_OAUTH_CLIENT_ID is unavailable in hermes_cli.auth.")
CODEX_OAUTH_TOKEN_URL = getattr(auth_module, "CODEX_OAUTH_TOKEN_URL", "${CODEX_OAUTH_TOKEN_URL_FALLBACK}")
DEFAULT_CODEX_BASE_URL = getattr(auth_module, "DEFAULT_CODEX_BASE_URL", "${DEFAULT_CODEX_BASE_URL}")
_read_codex_tokens = getattr(auth_module, "_read_codex_tokens", None)
_save_codex_tokens = getattr(auth_module, "_save_codex_tokens", None)
resolve_codex_runtime_credentials = getattr(auth_module, "resolve_codex_runtime_credentials", None)

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or "/root/.hermes")
FLOW_PATH = HERMES_HOME / ".codex_device_flow.json"


def _read_auth_store_provider() -> dict:
    auth_file = HERMES_HOME / "auth.json"
    try:
        raw = json.loads(auth_file.read_text(encoding="utf-8")) if auth_file.exists() else {}
        provider = raw.get("providers", {}).get("openai-codex", {})
        return provider if isinstance(provider, dict) else {}
    except Exception:
        return {}


def _write_auth_store_tokens(tokens: dict, last_refresh: str) -> None:
    import os as _os
    auth_file = HERMES_HOME / "auth.json"
    auth_file.parent.mkdir(parents=True, exist_ok=True)
    auth_store = {}
    if auth_file.exists():
        try:
            loaded = json.loads(auth_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                auth_store = loaded
        except Exception:
            auth_store = {}
    providers = auth_store.get("providers")
    if not isinstance(providers, dict):
        providers = {}
        auth_store["providers"] = providers
    auth_store["version"] = 1
    auth_store["active_provider"] = "openai-codex"
    providers["openai-codex"] = {
        "tokens": tokens,
        "last_refresh": last_refresh,
        "auth_mode": "chatgpt",
    }
    with open(str(auth_file), "w", encoding="utf-8") as auth_handle:
        json.dump(auth_store, auth_handle, indent=2)
        auth_handle.write("\n")
        auth_handle.flush()
        _os.fsync(auth_handle.fileno())
    try:
        auth_file.chmod(0o600)
    except Exception:
        pass


def _post_json(url: str, payload: dict, timeout: float = 15.0):
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "${CODEX_OAUTH_USER_AGENT}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return getattr(response, "status", response.getcode()), json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(body)
        except Exception:
            payload = body
        return exc.code, payload
    except URLError as exc:
        raise RuntimeError(f"Codex OAuth request failed: {exc.reason}") from exc


def _post_form(url: str, payload: dict, timeout: float = 15.0):
    request = Request(
        url,
        data=urlencode(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "${CODEX_OAUTH_USER_AGENT}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", response.getcode())
            return status, json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(body)
        except Exception:
            payload = body
        return exc.code, payload
    except URLError as exc:
        raise RuntimeError(f"Codex OAuth request failed: {exc.reason}") from exc


def _build_vault_bundle(source: str, base_url: str) -> dict:
    data = {}
    if callable(_read_codex_tokens):
        try:
            data = _read_codex_tokens(_lock=False) or {}
        except Exception:
            data = {}
    if not data:
        data = _read_auth_store_provider()
    tokens = data.get("tokens") if isinstance(data, dict) else {}
    if not isinstance(tokens, dict):
        tokens = {}
    return {
        "accessToken": str(tokens.get("access_token") or ""),
        "refreshToken": str(tokens.get("refresh_token") or ""),
        "lastRefresh": str(data.get("last_refresh") or ""),
        "baseUrl": str(base_url or DEFAULT_CODEX_BASE_URL),
        "source": str(source or "hermes-auth-store"),
    }


def _emit_authenticated(source: str, base_url: str) -> None:
    print(json.dumps({
        "authenticated": True,
        "source": source,
        "vaultBundle": _build_vault_bundle(source, base_url),
    }))


if not FLOW_PATH.exists():
    creds = None
    if callable(resolve_codex_runtime_credentials):
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                creds = resolve_codex_runtime_credentials(refresh_if_expiring=False)
        except Exception:
            creds = None
    if not creds:
        data = _read_auth_store_provider()
        tokens = data.get("tokens") if isinstance(data, dict) else {}
        if isinstance(tokens, dict) and tokens.get("access_token"):
            creds = {
                "api_key": str(tokens.get("access_token") or ""),
                "source": "hermes-auth-store",
                "base_url": DEFAULT_CODEX_BASE_URL,
            }

    if creds and creds.get("api_key"):
        _emit_authenticated(str(creds.get("source") or "hermes-auth-store"), str(creds.get("base_url") or DEFAULT_CODEX_BASE_URL))
        raise SystemExit(0)

    print(json.dumps({"authenticated": False}))
    raise SystemExit(0)

state = json.loads(FLOW_PATH.read_text(encoding="utf-8"))
issuer = str(state.get("issuer") or "${CODEX_AUTH_ISSUER}").rstrip("/")
device_auth_id = str(state.get("device_auth_id", "") or "").strip()
user_code = str(state.get("user_code", "") or "").strip()
if not device_auth_id or not user_code:
    raise RuntimeError("Stored Codex device flow is incomplete.")

created_at_raw = str(state.get("created_at", "") or "").strip()
if created_at_raw:
    try:
        created_at = datetime.fromisoformat(created_at_raw.replace("Z", "+00:00"))
    except ValueError:
        created_at = None
    if created_at and (datetime.now(timezone.utc) - created_at).total_seconds() > 15 * 60:
        FLOW_PATH.unlink(missing_ok=True)
        print(json.dumps({"authenticated": False, "expired": True}))
        raise SystemExit(0)

poll_status, poll_payload = _post_json(
    f"{issuer}/api/accounts/deviceauth/token",
    {"device_auth_id": device_auth_id, "user_code": user_code},
)

if poll_status in (403, 404):
    print(json.dumps({"authenticated": False, "pendingDeviceFlow": True}))
    raise SystemExit(0)

if poll_status >= 400:
    raise RuntimeError(f"Codex device auth poll failed (HTTP {poll_status}): {poll_payload}")

authorization_code = str(poll_payload.get("authorization_code", "") or "").strip()
code_verifier = str(poll_payload.get("code_verifier", "") or "").strip()
if not authorization_code or not code_verifier:
    raise RuntimeError("Codex authorization response missing authorization_code or code_verifier.")

token_status, token_payload = _post_form(
    CODEX_OAUTH_TOKEN_URL,
    {
        "grant_type": "authorization_code",
        "code": authorization_code,
        "redirect_uri": f"{issuer}/deviceauth/callback",
        "client_id": CODEX_OAUTH_CLIENT_ID,
        "code_verifier": code_verifier,
    },
)

if token_status >= 400:
    raise RuntimeError(f"Codex token exchange failed (HTTP {token_status}): {token_payload}")

access_token = str(token_payload.get("access_token", "") or "").strip()
refresh_token = str(token_payload.get("refresh_token", "") or "").strip()
if not access_token or not refresh_token:
    raise RuntimeError("Codex token exchange did not return both access_token and refresh_token.")

tokens = {
    "access_token": access_token,
    "refresh_token": refresh_token,
}
last_refresh = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
try:
    if callable(_save_codex_tokens):
        _save_codex_tokens(tokens, last_refresh)
    else:
        _write_auth_store_tokens(tokens, last_refresh)
except OSError as _e:
    if _e.errno != 16:
        raise
    # EBUSY (errno 16): Docker bind-mounted files block os.replace().
    # Fall back to direct truncate+write which works on bind mounts.
    _write_auth_store_tokens(tokens, last_refresh)

base_url = str(DEFAULT_CODEX_BASE_URL)
FLOW_PATH.unlink(missing_ok=True)
_emit_authenticated("device-code", base_url)
`;

  return buildDockerPythonCommand(instanceId, pythonCode, execUser, hermesHomeDir);
}

export function serializeCodexVaultBundle(bundle: CodexVaultBundle): string {
  return JSON.stringify({
    kind: "codex_oauth_bundle",
    version: 1,
    access_token: bundle.accessToken,
    refresh_token: bundle.refreshToken,
    last_refresh: bundle.lastRefresh,
    ...(bundle.baseUrl ? { base_url: bundle.baseUrl } : {}),
    ...(bundle.source ? { source: bundle.source } : {}),
  } satisfies CodexVaultBundleWireFormat);
}

export function parseCodexVaultBundle(rawSecret: string): CodexVaultBundle | null {
  if (!rawSecret.trim()) return null;

  try {
    const parsed = JSON.parse(rawSecret) as unknown;
    if (!isCodexVaultBundleWireFormat(parsed)) {
      return null;
    }

    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      lastRefresh: parsed.last_refresh,
      baseUrl: safeBundleBaseUrl(parsed.base_url),
      source: typeof parsed.source === "string" && parsed.source.trim()
        ? parsed.source.trim()
        : undefined,
    };
  } catch {
    return null;
  }
}

export function formatStoredProviderSecretPreview(provider: string, rawSecret: string): string {
  if (isCodexAuthProvider(provider) && !rawSecret.trim()) {
    return CODEX_DISCONNECTED_PREVIEW;
  }

  if (isCodexAuthProvider(provider) && parseCodexVaultBundle(rawSecret)) {
    return CODEX_VAULT_KEY_PREVIEW;
  }

  if (provider === "nous" || provider === "nous-portal") {
    return formatStoredNousSecretPreview(rawSecret);
  }

  return formatKeyPreview(rawSecret);
}

export function buildCodexHermesAuthStore(bundle: CodexVaultBundle): string {
  return `${JSON.stringify(
    {
      version: 1,
      active_provider: "openai-codex",
      providers: {
        "openai-codex": {
          tokens: {
            access_token: bundle.accessToken,
            refresh_token: bundle.refreshToken,
          },
          last_refresh: bundle.lastRefresh,
          auth_mode: "chatgpt",
        },
      },
    },
    null,
    2
  )}\n`;
}

export function resolveCodexDeploymentSecret(rawSecret: string): {
  apiKey: string;
  authBundle?: CodexVaultBundle;
} {
  const bundle = parseCodexVaultBundle(rawSecret);
  if (!bundle) {
    return { apiKey: "" };
  }

  return {
    apiKey: "",
    authBundle: {
      ...bundle,
      baseUrl: bundle.baseUrl || DEFAULT_CODEX_BASE_URL,
    },
  };
}

function hasBooleanAuthenticated(payload: unknown): payload is { authenticated: boolean } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "authenticated" in payload &&
    typeof (payload as { authenticated?: unknown }).authenticated === "boolean"
  );
}

export function readCodexAuthenticatedFlag(payload: unknown): boolean {
  if (hasBooleanAuthenticated(payload)) {
    return payload.authenticated;
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "data" in payload &&
    hasBooleanAuthenticated((payload as { data?: unknown }).data)
  ) {
    return (payload as { data: { authenticated: boolean } }).data.authenticated;
  }

  return false;
}

export function parseCodexCommandJson<T>(rawOutput: string): T {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]) as T;
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to parse Codex command output: ${rawOutput.slice(0, 500)}`);
}
