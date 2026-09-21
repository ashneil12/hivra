import { formatKeyPreview } from "@/lib/crypto";

export const DEFAULT_NOUS_PORTAL_URL = "https://portal.nousresearch.com";
export const DEFAULT_NOUS_INFERENCE_URL = "https://inference-api.nousresearch.com/v1";
export const DEFAULT_NOUS_CLIENT_ID = "hermes-cli";
const DEFAULT_NOUS_SCOPE = "inference:mint_agent_key";
const DEFAULT_NOUS_TOKEN_TYPE = "Bearer";
export const WEBUI_HERMES_HOME = "/home/hermes/.hermes";

export const NOUS_VAULT_KEY_NAME = "Nous Portal OAuth Session";
export const NOUS_VAULT_KEY_PREVIEW = "OAuth session + agent key (reusable)";
const NOUS_DISCONNECTED_PREVIEW = "Not connected";

interface NousVaultBundleTls {
  insecure?: boolean;
  caBundle?: string;
}

export interface NousVaultBundle {
  portalBaseUrl: string;
  inferenceBaseUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope?: string;
  tokenType?: string;
  obtainedAt?: string;
  expiresAt?: string;
  expiresIn?: number;
  tls?: NousVaultBundleTls;
  agentKey?: string;
  agentKeyId?: string;
  agentKeyExpiresAt?: string;
  agentKeyExpiresIn?: number;
  agentKeyReused?: boolean;
  agentKeyObtainedAt?: string;
  label?: string;
  source?: string;
}

type NousStatusCommandResponse = {
  authenticated?: boolean;
  source?: string;
  expired?: boolean;
  vaultBundle?: NousVaultBundle;
  session_id?: string;
  flow?: string;
  user_code?: string;
  verification_url?: string;
  expires_in?: number;
  poll_interval?: number;
  status?: string;
  error_message?: string | null;
  expires_at?: string | number | null;
};

interface NousVaultBundleWireFormat {
  kind: "nous_oauth_bundle";
  version: 1;
  portal_base_url: string;
  inference_base_url: string;
  client_id: string;
  access_token: string;
  refresh_token: string;
  scope?: string;
  token_type?: string;
  obtained_at?: string;
  expires_at?: string;
  expires_in?: number;
  tls?: {
    insecure?: boolean;
    ca_bundle?: string;
  };
  agent_key?: string;
  agent_key_id?: string;
  agent_key_expires_at?: string;
  agent_key_expires_in?: number;
  agent_key_reused?: boolean;
  agent_key_obtained_at?: string;
  label?: string;
  source?: string;
}

function isOptionalString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function normalizeUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  // Defense-in-depth: the URL is sourced from container stdout (and the
  // container is the user's own VM). A compromised agent could plant a
  // bundle pointing at an attacker-controlled host so subsequent
  // dashboard fetches with the user's credentials hit the attacker.
  // checkOutboundUrlSafety blocks the obvious local/metadata targets
  // without locking us to a single Nous hostname.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const safety = (require("@/lib/url-safety") as typeof import("@/lib/url-safety")).checkOutboundUrlSafety(trimmed);
  if (!safety.ok) {
    return fallback;
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildDockerPythonCommand(
  instanceId: string,
  pythonCode: string,
  execUser = "root"
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
    `HERMES_AGENT_DIR="\${HERMES_WEBUI_AGENT_DIR:-\${HERMES_HOME:-}/hermes-agent}"`,
    `PYTHON_BIN=/opt/venv/bin/python`,
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

function normalizeNousVaultBundle(bundle: NousVaultBundle): NousVaultBundle {
  return {
    portalBaseUrl: normalizeUrl(bundle.portalBaseUrl, DEFAULT_NOUS_PORTAL_URL),
    inferenceBaseUrl: normalizeUrl(bundle.inferenceBaseUrl, DEFAULT_NOUS_INFERENCE_URL),
    clientId: normalizeOptionalString(bundle.clientId) || DEFAULT_NOUS_CLIENT_ID,
    accessToken: bundle.accessToken.trim(),
    refreshToken: bundle.refreshToken.trim(),
    scope: normalizeOptionalString(bundle.scope) || DEFAULT_NOUS_SCOPE,
    tokenType: normalizeOptionalString(bundle.tokenType) || DEFAULT_NOUS_TOKEN_TYPE,
    obtainedAt: normalizeOptionalString(bundle.obtainedAt),
    expiresAt: normalizeOptionalString(bundle.expiresAt),
    expiresIn: isOptionalNumber(bundle.expiresIn) ? bundle.expiresIn : undefined,
    tls: bundle.tls
      ? {
          insecure: bundle.tls.insecure === true,
          caBundle: normalizeOptionalString(bundle.tls.caBundle),
        }
      : undefined,
    agentKey: normalizeOptionalString(bundle.agentKey),
    agentKeyId: normalizeOptionalString(bundle.agentKeyId),
    agentKeyExpiresAt: normalizeOptionalString(bundle.agentKeyExpiresAt),
    agentKeyExpiresIn: isOptionalNumber(bundle.agentKeyExpiresIn) ? bundle.agentKeyExpiresIn : undefined,
    agentKeyReused: isOptionalBoolean(bundle.agentKeyReused) ? bundle.agentKeyReused : undefined,
    agentKeyObtainedAt: normalizeOptionalString(bundle.agentKeyObtainedAt),
    label: normalizeOptionalString(bundle.label),
    source: normalizeOptionalString(bundle.source),
  };
}

function isNousVaultBundleWireFormat(value: unknown): value is NousVaultBundleWireFormat {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    kind?: unknown;
    version?: unknown;
    portal_base_url?: unknown;
    inference_base_url?: unknown;
    client_id?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    scope?: unknown;
    token_type?: unknown;
    obtained_at?: unknown;
    expires_at?: unknown;
    expires_in?: unknown;
    tls?: unknown;
    agent_key?: unknown;
    agent_key_id?: unknown;
    agent_key_expires_at?: unknown;
    agent_key_expires_in?: unknown;
    agent_key_reused?: unknown;
    agent_key_obtained_at?: unknown;
    label?: unknown;
    source?: unknown;
  };

  const tlsValid =
    typeof candidate.tls === "undefined" ||
    (typeof candidate.tls === "object" &&
      candidate.tls !== null &&
      (typeof (candidate.tls as { insecure?: unknown }).insecure === "undefined" ||
        isOptionalBoolean((candidate.tls as { insecure?: unknown }).insecure)) &&
      (typeof (candidate.tls as { ca_bundle?: unknown }).ca_bundle === "undefined" ||
        isOptionalString((candidate.tls as { ca_bundle?: unknown }).ca_bundle)));

  return (
    candidate.kind === "nous_oauth_bundle" &&
    candidate.version === 1 &&
    isOptionalString(candidate.portal_base_url) &&
    isOptionalString(candidate.inference_base_url) &&
    isOptionalString(candidate.client_id) &&
    isOptionalString(candidate.access_token) &&
    isOptionalString(candidate.refresh_token) &&
    (typeof candidate.scope === "undefined" || isOptionalString(candidate.scope)) &&
    (typeof candidate.token_type === "undefined" || isOptionalString(candidate.token_type)) &&
    (typeof candidate.obtained_at === "undefined" || isOptionalString(candidate.obtained_at)) &&
    (typeof candidate.expires_at === "undefined" || isOptionalString(candidate.expires_at)) &&
    (typeof candidate.expires_in === "undefined" || isOptionalNumber(candidate.expires_in)) &&
    tlsValid &&
    (typeof candidate.agent_key === "undefined" || isOptionalString(candidate.agent_key)) &&
    (typeof candidate.agent_key_id === "undefined" || isOptionalString(candidate.agent_key_id)) &&
    (typeof candidate.agent_key_expires_at === "undefined" || isOptionalString(candidate.agent_key_expires_at)) &&
    (typeof candidate.agent_key_expires_in === "undefined" || isOptionalNumber(candidate.agent_key_expires_in)) &&
    (typeof candidate.agent_key_reused === "undefined" || isOptionalBoolean(candidate.agent_key_reused)) &&
    (typeof candidate.agent_key_obtained_at === "undefined" || isOptionalString(candidate.agent_key_obtained_at)) &&
    (typeof candidate.label === "undefined" || isOptionalString(candidate.label)) &&
    (typeof candidate.source === "undefined" || isOptionalString(candidate.source))
  );
}

export function serializeNousVaultBundle(bundle: NousVaultBundle): string {
  const normalized = normalizeNousVaultBundle(bundle);
  return JSON.stringify({
    kind: "nous_oauth_bundle",
    version: 1,
    portal_base_url: normalized.portalBaseUrl,
    inference_base_url: normalized.inferenceBaseUrl,
    client_id: normalized.clientId,
    access_token: normalized.accessToken,
    refresh_token: normalized.refreshToken,
    ...(normalized.scope ? { scope: normalized.scope } : {}),
    ...(normalized.tokenType ? { token_type: normalized.tokenType } : {}),
    ...(normalized.obtainedAt ? { obtained_at: normalized.obtainedAt } : {}),
    ...(normalized.expiresAt ? { expires_at: normalized.expiresAt } : {}),
    ...(typeof normalized.expiresIn === "number" ? { expires_in: normalized.expiresIn } : {}),
    ...(normalized.tls
      ? {
          tls: {
            insecure: normalized.tls.insecure === true,
            ...(normalized.tls.caBundle ? { ca_bundle: normalized.tls.caBundle } : {}),
          },
        }
      : {}),
    ...(normalized.agentKey ? { agent_key: normalized.agentKey } : {}),
    ...(normalized.agentKeyId ? { agent_key_id: normalized.agentKeyId } : {}),
    ...(normalized.agentKeyExpiresAt ? { agent_key_expires_at: normalized.agentKeyExpiresAt } : {}),
    ...(typeof normalized.agentKeyExpiresIn === "number"
      ? { agent_key_expires_in: normalized.agentKeyExpiresIn }
      : {}),
    ...(typeof normalized.agentKeyReused === "boolean" ? { agent_key_reused: normalized.agentKeyReused } : {}),
    ...(normalized.agentKeyObtainedAt ? { agent_key_obtained_at: normalized.agentKeyObtainedAt } : {}),
    ...(normalized.label ? { label: normalized.label } : {}),
    ...(normalized.source ? { source: normalized.source } : {}),
  } satisfies NousVaultBundleWireFormat);
}

export function parseNousVaultBundle(rawSecret: string): NousVaultBundle | null {
  if (!rawSecret.trim()) return null;

  try {
    const parsed = JSON.parse(rawSecret) as unknown;
    if (!isNousVaultBundleWireFormat(parsed)) {
      return null;
    }

    return normalizeNousVaultBundle({
      portalBaseUrl: parsed.portal_base_url,
      inferenceBaseUrl: parsed.inference_base_url,
      clientId: parsed.client_id,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      scope: parsed.scope,
      tokenType: parsed.token_type,
      obtainedAt: parsed.obtained_at,
      expiresAt: parsed.expires_at,
      expiresIn: parsed.expires_in,
      tls: parsed.tls
        ? {
            insecure: parsed.tls.insecure,
            caBundle: parsed.tls.ca_bundle,
          }
        : undefined,
      agentKey: parsed.agent_key,
      agentKeyId: parsed.agent_key_id,
      agentKeyExpiresAt: parsed.agent_key_expires_at,
      agentKeyExpiresIn: parsed.agent_key_expires_in,
      agentKeyReused: parsed.agent_key_reused,
      agentKeyObtainedAt: parsed.agent_key_obtained_at,
      label: parsed.label,
      source: parsed.source,
    });
  } catch {
    return null;
  }
}

export function formatStoredNousSecretPreview(rawSecret: string): string {
  if (!rawSecret.trim()) {
    return NOUS_DISCONNECTED_PREVIEW;
  }

  if (parseNousVaultBundle(rawSecret)) {
    return NOUS_VAULT_KEY_PREVIEW;
  }

  return formatKeyPreview(rawSecret);
}

export function buildNousHermesAuthStore(bundle: NousVaultBundle): string {
  const normalized = normalizeNousVaultBundle(bundle);

  return `${JSON.stringify(
    {
      version: 1,
      active_provider: "nous",
      providers: {
        nous: {
          portal_base_url: normalized.portalBaseUrl,
          inference_base_url: normalized.inferenceBaseUrl,
          client_id: normalized.clientId,
          scope: normalized.scope,
          token_type: normalized.tokenType,
          access_token: normalized.accessToken,
          refresh_token: normalized.refreshToken,
          ...(normalized.obtainedAt ? { obtained_at: normalized.obtainedAt } : {}),
          ...(normalized.expiresAt ? { expires_at: normalized.expiresAt } : {}),
          ...(typeof normalized.expiresIn === "number" ? { expires_in: normalized.expiresIn } : {}),
          tls: {
            insecure: normalized.tls?.insecure === true,
            ...(normalized.tls?.caBundle ? { ca_bundle: normalized.tls.caBundle } : {}),
          },
          ...(normalized.agentKey ? { agent_key: normalized.agentKey } : {}),
          ...(normalized.agentKeyId ? { agent_key_id: normalized.agentKeyId } : {}),
          ...(normalized.agentKeyExpiresAt ? { agent_key_expires_at: normalized.agentKeyExpiresAt } : {}),
          ...(typeof normalized.agentKeyExpiresIn === "number"
            ? { agent_key_expires_in: normalized.agentKeyExpiresIn }
            : {}),
          ...(typeof normalized.agentKeyReused === "boolean"
            ? { agent_key_reused: normalized.agentKeyReused }
            : {}),
          ...(normalized.agentKeyObtainedAt ? { agent_key_obtained_at: normalized.agentKeyObtainedAt } : {}),
          ...(normalized.label ? { label: normalized.label } : {}),
        },
      },
    },
    null,
    2
  )}\n`;
}

export function buildNousStatusCommand(
  instanceId: string,
  execUser = "root",
  hermesHomeDir = "/root/.hermes"
): string {
  const pythonCode = String.raw`
import json
import os
from pathlib import Path

DEFAULT_PORTAL = "${DEFAULT_NOUS_PORTAL_URL}"
DEFAULT_INFERENCE = "${DEFAULT_NOUS_INFERENCE_URL}"
DEFAULT_CLIENT_ID = "${DEFAULT_NOUS_CLIENT_ID}"
DEFAULT_SCOPE = "${DEFAULT_NOUS_SCOPE}"
DEFAULT_TOKEN_TYPE = "${DEFAULT_NOUS_TOKEN_TYPE}"
TARGET_HOME = Path(${JSON.stringify(hermesHomeDir)})


def _trim(value):
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def _normalize_url(value, fallback):
    trimmed = _trim(value)
    return (trimmed or fallback).rstrip("/")


def _safe_int(value):
    try:
        return int(value)
    except Exception:
        return None


def _load_auth_state():
    candidates = []
    for path in (
        TARGET_HOME / "auth.json",
        Path(os.environ.get("HERMES_HOME") or "") / "auth.json" if os.environ.get("HERMES_HOME") else None,
        Path("/opt/data/auth.json"),
        Path("/root/.hermes/auth.json"),
    ):
        if path and path not in candidates:
            candidates.append(path)

    for path in candidates:
        try:
            if not path.exists():
                continue
            raw = json.loads(path.read_text(encoding="utf-8"))
            providers = raw.get("providers") or {}
            state = providers.get("nous")
            if isinstance(state, dict) and state.get("access_token") and state.get("refresh_token"):
                return state
        except Exception:
            continue
    return None


state = _load_auth_state()
if not state:
    print(json.dumps({"authenticated": False}))
    raise SystemExit(0)

tls = state.get("tls") if isinstance(state.get("tls"), dict) else None
bundle = {
    "portalBaseUrl": _normalize_url(state.get("portal_base_url"), DEFAULT_PORTAL),
    "inferenceBaseUrl": _normalize_url(state.get("inference_base_url"), DEFAULT_INFERENCE),
    "clientId": _trim(state.get("client_id")) or DEFAULT_CLIENT_ID,
    "accessToken": str(state.get("access_token") or "").strip(),
    "refreshToken": str(state.get("refresh_token") or "").strip(),
    "scope": _trim(state.get("scope")) or DEFAULT_SCOPE,
    "tokenType": _trim(state.get("token_type")) or DEFAULT_TOKEN_TYPE,
    "obtainedAt": _trim(state.get("obtained_at")),
    "expiresAt": _trim(state.get("expires_at")),
    "expiresIn": _safe_int(state.get("expires_in")),
    "tls": {
        "insecure": bool(tls.get("insecure")) if tls else False,
        **({"caBundle": _trim(tls.get("ca_bundle"))} if tls and _trim(tls.get("ca_bundle")) else {}),
    },
    "agentKey": _trim(state.get("agent_key")),
    "agentKeyId": _trim(state.get("agent_key_id")),
    "agentKeyExpiresAt": _trim(state.get("agent_key_expires_at")),
    "agentKeyExpiresIn": _safe_int(state.get("agent_key_expires_in")),
    "agentKeyReused": state.get("agent_key_reused") if isinstance(state.get("agent_key_reused"), bool) else None,
    "agentKeyObtainedAt": _trim(state.get("agent_key_obtained_at")),
    "label": _trim(state.get("label")),
    "source": "hermes-auth-store",
}

if not bundle["accessToken"] or not bundle["refreshToken"]:
    print(json.dumps({"authenticated": False}))
    raise SystemExit(0)

print(json.dumps({
    "authenticated": True,
    "source": "hermes-auth-store",
    "vaultBundle": bundle,
}))
`;

  return buildDockerPythonCommand(instanceId, pythonCode, execUser);
}

export function buildNousStartCommand(
  instanceId: string,
  execUser = "root",
  hermesHomeDir = "/root/.hermes"
): string {
  const pythonCode = String.raw`
import json
import os
import time
import uuid
from pathlib import Path

TARGET_HOME = Path(${JSON.stringify(hermesHomeDir)})
FLOW_PATH = TARGET_HOME / ".nous_device_flow.json"

try:
    import httpx
    from hermes_cli.auth import _request_device_code, PROVIDER_REGISTRY

    pconfig = PROVIDER_REGISTRY["nous"]
    portal_base_url = (
        os.getenv("HERMES_PORTAL_BASE_URL")
        or os.getenv("NOUS_PORTAL_BASE_URL")
        or pconfig.portal_base_url
    ).rstrip("/")
    client_id = pconfig.client_id
    scope = pconfig.scope

    with httpx.Client(timeout=httpx.Timeout(15.0), headers={"Accept": "application/json"}) as client:
        device_data = _request_device_code(
            client=client,
            portal_base_url=portal_base_url,
            client_id=client_id,
            scope=scope,
        )

    session_id = uuid.uuid4().hex
    expires_in = int(device_data["expires_in"])
    interval = int(device_data["interval"])
    flow_state = {
        "session_id": session_id,
        "provider": "nous",
        "device_code": str(device_data["device_code"]),
        "portal_base_url": portal_base_url,
        "client_id": client_id,
        "scope": scope,
        "created_at": time.time(),
        "expires_at": time.time() + expires_in,
        "poll_interval": interval,
        "status": "pending",
    }
    TARGET_HOME.mkdir(parents=True, exist_ok=True)
    FLOW_PATH.write_text(json.dumps(flow_state), encoding="utf-8")
    os.chmod(FLOW_PATH, 0o600)
    print(json.dumps({
        "session_id": session_id,
        "flow": "device_code",
        "user_code": str(device_data["user_code"]),
        "verification_url": str(device_data["verification_uri_complete"]),
        "expires_in": expires_in,
        "poll_interval": interval,
    }))
except Exception as exc:
    print(json.dumps({
        "status": "error",
        "error_message": str(exc),
    }))
    raise SystemExit(1)
`;

  return buildDockerPythonCommand(instanceId, pythonCode, execUser);
}

export function buildNousPollCommand(
  instanceId: string,
  sessionId: string,
  execUser = "root",
  hermesHomeDir = "/root/.hermes"
): string {
  const pythonCode = String.raw`
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

TARGET_HOME = Path(${JSON.stringify(hermesHomeDir)})
FLOW_PATH = TARGET_HOME / ".nous_device_flow.json"
SESSION_ID = ${JSON.stringify(sessionId)}

try:
    import httpx
    from hermes_cli.auth import refresh_nous_oauth_from_state, persist_nous_credentials

    if not FLOW_PATH.exists():
        print(json.dumps({"session_id": SESSION_ID, "status": "error", "error_message": "Session not found or expired"}))
        raise SystemExit(0)

    state = json.loads(FLOW_PATH.read_text(encoding="utf-8"))
    if state.get("session_id") != SESSION_ID or state.get("provider") != "nous":
        print(json.dumps({"session_id": SESSION_ID, "status": "error", "error_message": "Provider mismatch for session"}))
        raise SystemExit(0)

    expires_at = float(state.get("expires_at") or 0)
    if expires_at and time.time() >= expires_at:
        try:
            FLOW_PATH.unlink()
        except Exception:
            pass
        print(json.dumps({"session_id": SESSION_ID, "status": "expired", "expires_at": expires_at}))
        raise SystemExit(0)

    portal_base_url = str(state["portal_base_url"]).rstrip("/")
    client_id = str(state["client_id"])
    device_code = str(state["device_code"])

    with httpx.Client(timeout=httpx.Timeout(15.0), headers={"Accept": "application/json"}) as client:
        response = client.post(
            f"{portal_base_url}/api/oauth/token",
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": client_id,
                "device_code": device_code,
            },
        )

    if response.status_code != 200:
        try:
            error_payload = response.json()
        except Exception:
            response.raise_for_status()
            print(json.dumps({"session_id": SESSION_ID, "status": "error", "error_message": "Token endpoint returned a non-JSON error response"}))
            raise SystemExit(0)

        error_code = str(error_payload.get("error") or "")
        if error_code in ("authorization_pending", "slow_down"):
            print(json.dumps({"session_id": SESSION_ID, "status": "pending", "expires_at": expires_at}))
            raise SystemExit(0)

        description = error_payload.get("error_description") or "Unknown authentication error"
        print(json.dumps({"session_id": SESSION_ID, "status": "error", "error_message": f"{error_code}: {description}"}))
        raise SystemExit(0)

    token_data = response.json()
    if "access_token" not in token_data:
        print(json.dumps({"session_id": SESSION_ID, "status": "error", "error_message": "Token response did not include access_token"}))
        raise SystemExit(0)

    now = datetime.now(timezone.utc)
    token_ttl = int(token_data.get("expires_in") or 0)
    auth_state = {
        "portal_base_url": portal_base_url,
        "inference_base_url": token_data.get("inference_base_url"),
        "client_id": client_id,
        "scope": token_data.get("scope") or state.get("scope"),
        "token_type": token_data.get("token_type", "Bearer"),
        "access_token": token_data["access_token"],
        "refresh_token": token_data.get("refresh_token"),
        "obtained_at": now.isoformat(),
        "expires_at": (
            datetime.fromtimestamp(now.timestamp() + token_ttl, tz=timezone.utc).isoformat()
            if token_ttl else None
        ),
        "expires_in": token_ttl,
    }
    full_state = refresh_nous_oauth_from_state(
        auth_state,
        min_key_ttl_seconds=300,
        timeout_seconds=15.0,
        force_refresh=False,
        force_mint=True,
    )
    persist_nous_credentials(full_state)
    try:
        FLOW_PATH.unlink()
    except Exception:
        pass
    print(json.dumps({"session_id": SESSION_ID, "status": "approved"}))
except SystemExit:
    raise
except Exception as exc:
    print(json.dumps({"session_id": SESSION_ID, "status": "error", "error_message": str(exc)}))
    raise SystemExit(1)
`;

  return buildDockerPythonCommand(instanceId, pythonCode, execUser);
}

export function resolveNousDeploymentSecret(rawSecret: string): {
  apiKey: string;
  authBundle?: NousVaultBundle;
} {
  const bundle = parseNousVaultBundle(rawSecret);
  if (!bundle) {
    return { apiKey: rawSecret.trim() };
  }

  return {
    apiKey: "",
    authBundle: bundle,
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

function readNousAuthenticatedFlag(payload: unknown): boolean {
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

export function readNousProviderLoggedInFlag(payload: unknown): boolean {
  const providers =
    typeof payload === "object" &&
    payload !== null &&
    "data" in payload &&
    Array.isArray((payload as { data?: { providers?: unknown } }).data?.providers)
      ? (payload as { data: { providers: Array<{ id?: unknown; status?: { logged_in?: unknown } }> } }).data.providers
      : typeof payload === "object" &&
          payload !== null &&
          "providers" in payload &&
          Array.isArray((payload as { providers?: unknown }).providers)
        ? (payload as { providers: Array<{ id?: unknown; status?: { logged_in?: unknown } }> }).providers
        : [];

  return providers.some((provider) => provider?.id === "nous" && provider?.status?.logged_in === true);
}

function readNousApiError(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    const error = (payload as { error: string }).error.trim();
    if (error) {
      return error;
    }
  }

  return fallback;
}

function readNousPersistenceError(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "data" in payload &&
    typeof (payload as { data?: { persistenceError?: unknown } }).data?.persistenceError === "string"
  ) {
    const error = (payload as { data: { persistenceError: string } }).data.persistenceError.trim();
    return error || null;
  }

  return null;
}

function hasSuccessfulNousStatusPayload(payload: unknown): payload is { success: true } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "success" in payload &&
    (payload as { success?: unknown }).success === true
  );
}

function defaultWaitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DEFAULT_NOUS_STATUS_VERIFICATION_DELAYS_MS = [0, 750, 1500, 3000] as const;
const NOUS_SAVED_SESSION_NOT_YET_READABLE_ERROR =
  "Nous Portal login completed, but Hermes could not verify the saved session.";

export async function verifyNousSavedSession(input: {
  readStatus: () => Promise<{ ok: boolean; payload: unknown }>;
  retryDelaysMs?: readonly number[];
  waitForMs?: (ms: number) => Promise<void>;
}): Promise<unknown> {
  const retryDelays =
    input.retryDelaysMs && input.retryDelaysMs.length > 0
      ? [...input.retryDelaysMs]
      : [...DEFAULT_NOUS_STATUS_VERIFICATION_DELAYS_MS];
  const waitForMs = input.waitForMs ?? defaultWaitForMs;

  for (const [index, delayMs] of retryDelays.entries()) {
    if (index > 0 && delayMs > 0) {
      await waitForMs(delayMs);
    }

    const { ok, payload } = await input.readStatus();
    if (!ok || !hasSuccessfulNousStatusPayload(payload)) {
      throw new Error(readNousApiError(payload, "Failed to finalize Nous Portal login"));
    }

    const persistenceError = readNousPersistenceError(payload);
    if (persistenceError) {
      throw new Error(
        `Nous Portal connected on this agent, but reusable Vault save failed: ${persistenceError}`
      );
    }

    if (readNousAuthenticatedFlag(payload)) {
      return payload;
    }
  }

  throw new Error(NOUS_SAVED_SESSION_NOT_YET_READABLE_ERROR);
}

export async function verifyNousPortalConnection(input: {
  readProviderCatalog: () => Promise<{ ok: boolean; payload: unknown }>;
  readSavedSessionStatus?: () => Promise<{ ok: boolean; payload: unknown }>;
  retryDelaysMs?: readonly number[];
  waitForMs?: (ms: number) => Promise<void>;
}): Promise<{
  providerPayload: unknown;
  savedSessionVerified: boolean;
  savedSessionPayload?: unknown;
}> {
  const retryDelays =
    input.retryDelaysMs && input.retryDelaysMs.length > 0
      ? [...input.retryDelaysMs]
      : [...DEFAULT_NOUS_STATUS_VERIFICATION_DELAYS_MS];
  const waitForMs = input.waitForMs ?? defaultWaitForMs;
  let lastErrorMessage = "Nous Portal login was approved, but Hermes still does not report the provider as connected.";

  for (const [index, delayMs] of retryDelays.entries()) {
    if (index > 0 && delayMs > 0) {
      await waitForMs(delayMs);
    }

    let providerResult: { ok: boolean; payload: unknown };
    try {
      providerResult = await input.readProviderCatalog();
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      continue;
    }

    const { ok, payload } = providerResult;
    if (!ok || !hasSuccessfulNousStatusPayload(payload)) {
      lastErrorMessage = readNousApiError(payload, "Failed to verify Nous Portal login");
      continue;
    }

    if (!readNousProviderLoggedInFlag(payload)) {
      continue;
    }

    if (!input.readSavedSessionStatus) {
      return {
        providerPayload: payload,
        savedSessionVerified: false,
      };
    }

    try {
      const savedSessionPayload = await verifyNousSavedSession({
        readStatus: input.readSavedSessionStatus,
        retryDelaysMs: [0],
        waitForMs,
      });
      return {
        providerPayload: payload,
        savedSessionVerified: true,
        savedSessionPayload,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage !== NOUS_SAVED_SESSION_NOT_YET_READABLE_ERROR) {
        throw error;
      }

      return {
        providerPayload: payload,
        savedSessionVerified: false,
      };
    }
  }

  throw new Error(lastErrorMessage);
}

export function parseNousCommandJson(rawOutput: string): NousStatusCommandResponse {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]) as NousStatusCommandResponse;
    } catch {
      continue;
    }
  }

  throw new Error("Failed to parse Nous status command output.");
}
