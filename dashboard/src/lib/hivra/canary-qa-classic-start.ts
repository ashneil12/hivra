import "server-only";

import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";
import { createCanaryQaDispatcher } from "./canary-qa-dispatch";

const PREFIX = "HIVRA_CANARY_QA_CLASSIC_START_";
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const JSON_SPACE = String.raw`[ \t\r\n]*`;
const OPERATION_BODY = new RegExp(String.raw`^${JSON_SPACE}\{${JSON_SPACE}"operationId"${JSON_SPACE}:${JSON_SPACE}"(${UUID_SOURCE})"${JSON_SPACE}\}${JSON_SPACE}$`);
const BEARER = /^[A-Za-z0-9._~+\/=-]+$/;
const OWNER = /^user_[A-Za-z0-9]{1,128}$/;
const HOST = /^[A-Za-z0-9_-]{1,64}$/;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i;

type Env = Record<string, string | undefined>;
type DispatcherOptions = Parameters<typeof createCanaryQaDispatcher>[0];
type Rpc = ReturnType<DispatcherOptions["db"]["schema"]>["rpc"];

function httpsEndpoint(value: string | undefined): URL | null {
  if (!value?.startsWith("https://") || /[\s?#\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function hasGenerationRole(bearer: string): boolean {
  if (bearer.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString("utf8"));
    return typeof payload?.role === "string" && /^hivra_canary_qa_[a-z0-9]{1,40}$/.test(payload.role);
  } catch {
    return false;
  }
}

export function loadCanaryQaClassicStartConfig(env: Env = process.env) {
  const get = (name: string) => env[`${PREFIX}${name}`];
  if (get("ENABLED") !== "true" || !isCanonicalGitCanaryDeployment(env)) return null;

  const ownerId = get("OWNER_ID");
  const instanceId = get("INSTANCE_ID");
  const hostId = get("HOST_ID");
  const vmidText = get("VMID");
  const vmid = Number(vmidText);
  const supabaseUrl = httpsEndpoint(env.NEXT_PUBLIC_SUPABASE_URL);
  const postgrestUrl = httpsEndpoint(get("POSTGREST_URL"));
  const postgrestBearer = get("POSTGREST_BEARER");
  const gatewayKey = get("POSTGREST_GATEWAY_KEY");
  const hostUrl = httpsEndpoint(get("HOST_URL"));
  const hostBearer = get("HOST_BEARER");
  const sharedKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ownerId || !OWNER.test(ownerId) || !instanceId || instanceId.length !== 36 || !UUID.test(instanceId)
    || !hostId || !HOST.test(hostId) || !vmidText || !/^[1-9][0-9]*$/.test(vmidText)
    || !Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999_999_999 || String(vmid) !== vmidText
    || !supabaseUrl || supabaseUrl.pathname !== "/"
    || !postgrestUrl || postgrestUrl.href !== new URL("/rest/v1", supabaseUrl).href
    || !postgrestBearer || !hasGenerationRole(postgrestBearer)
    || !hostUrl || !hostBearer || !BEARER.test(hostBearer) || hostBearer !== hostBearer.trim()
    || (sharedKey && [postgrestBearer, gatewayKey, hostBearer].includes(sharedKey))
    || hostBearer === postgrestBearer || hostBearer === gatewayKey
    || (gatewayKey !== undefined && (!BEARER.test(gatewayKey) || gatewayKey !== gatewayKey.trim()
      || gatewayKey === postgrestBearer))) {
    return null;
  }
  return { ownerId, instanceId, hostId, vmid, postgrestUrl, postgrestBearer, gatewayKey, hostUrl, hostBearer };
}

async function readBoundedText(message: Request | Response, limit: number): Promise<string | null> {
  const length = message.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return null;
  const reader = message.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
      if (size + value.byteLength > limit) return null;
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export async function readClassicStartOperationId(request: Request): Promise<string | null> {
  if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "")) return null;
  const body = await readBoundedText(request, 256);
  return body === null ? null : OPERATION_BODY.exec(body)?.[1] ?? null;
}

async function postJson(
  url: string | URL,
  bearer: string,
  body: object,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${bearer}`, ...headers },
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200 || !JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Canary QA response not confirmed");
  }
  const text = await readBoundedText(response, 4096);
  if (text === null) throw new Error("Canary QA response not confirmed");
  return JSON.parse(text) as unknown;
}

export function createCanaryQaClassicStart(config: NonNullable<ReturnType<typeof loadCanaryQaClassicStartConfig>>) {
  const { ownerId, instanceId, hostId, vmid, postgrestUrl, postgrestBearer, gatewayKey, hostUrl, hostBearer } = config;
  const rpcBase = postgrestUrl.href.replace(/\/+$/, "");
  const rpcHeaders = {
    "content-profile": "public",
    "accept-profile": "public",
    ...(gatewayKey ? { apikey: gatewayKey } : {}),
  };
  const rpc: Rpc = async (...call) => {
    let rpcName: string;
    let args: object;
    if (call[0] === "claim_canary_qa_dispatch") {
      if (call[1].p_action !== "start") return { data: null, error: "invalid_action" };
      rpcName = "claim_canary_qa_classic_start";
      args = { ...call[1], p_instance_id: instanceId };
    } else {
      rpcName = "finish_canary_qa_classic_start";
      args = call[1];
    }
    const data = await postJson(`${rpcBase}/rpc/${rpcName}`, postgrestBearer, args, 5_000, rpcHeaders);
    return { data, error: null };
  };
  const dispatch = createCanaryQaDispatcher({
    enabled: true,
    scope: { ownerId, hostId, vmid },
    db: { schema: () => ({ rpc }) },
    async run(operation) {
      const { operationId } = operation;
      const data = await postJson(hostUrl, hostBearer, {
        action: "start", ownerId, instanceId, hostId, vmid, operationId,
      }, 15_000);
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 6
        || !("outcome" in data) || (data.outcome !== "performed" && data.outcome !== "refused")
        || !("ownerId" in data) || data.ownerId !== ownerId || !("instanceId" in data) || data.instanceId !== instanceId
        || !("hostId" in data) || data.hostId !== hostId || !("vmid" in data) || data.vmid !== vmid
        || !("operationId" in data) || data.operationId !== operationId) {
        return "unknown";
      }
      return data.outcome;
    },
  });
  return (operationId: string) => dispatch({ ownerId, hostId, vmid, action: "start", operationId });
}
