type ValidatedHivraHostRunningResult = {
  vmid: number;
  ip: string;
  chatUrl: string;
  apiToken: string;
};

export type HivraHostRunningResultValidation =
  | { ok: true; value: ValidatedHivraHostRunningResult }
  | { ok: false; reason: string };

const API_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const QUICK_TUNNEL_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

export function validateHivraChatOrigin(value: unknown, namedHostname: string | null): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (namedHostname) {
    if (hostname !== namedHostname.toLowerCase()) return null;
  } else if (!QUICK_TUNNEL_HOST_PATTERN.test(hostname)) {
    return null;
  }
  return parsed.origin;
}

export function validateHivraHostRunningResult(input: {
  result: unknown;
  expectedVmid: number;
  expectedIp: string;
  expectedAgentKind?: string | null;
  namedHostname: string | null;
  oneShotApiToken: string | null;
  existingApiToken: string | null;
}): HivraHostRunningResultValidation {
  if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) {
    return { ok: false, reason: "result_shape" };
  }
  const result = input.result as Record<string, unknown>;
  if (result.ready !== true) return { ok: false, reason: "not_ready" };
  if (result.vmid !== input.expectedVmid) return { ok: false, reason: "vmid_mismatch" };
  if (result.ip !== input.expectedIp) return { ok: false, reason: "ip_mismatch" };
  if (
    input.expectedAgentKind &&
    result.agent_kind !== input.expectedAgentKind
  ) return { ok: false, reason: "agent_kind_mismatch" };

  const chatUrl = validateHivraChatOrigin(result.chat_url, input.namedHostname);
  if (!chatUrl) return { ok: false, reason: "chat_url_invalid" };

  const apiToken =
    input.oneShotApiToken ??
    (typeof result.api_token === "string" ? result.api_token : null) ??
    input.existingApiToken;
  if (!apiToken || !API_TOKEN_PATTERN.test(apiToken)) {
    return { ok: false, reason: "api_token_invalid" };
  }

  return {
    ok: true,
    value: {
      vmid: input.expectedVmid,
      ip: input.expectedIp,
      chatUrl,
      apiToken,
    },
  };
}
