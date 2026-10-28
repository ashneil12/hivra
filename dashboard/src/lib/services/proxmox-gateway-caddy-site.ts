import {
  buildWakeFallbackCaddyBlock,
  buildWakeRedirectUrl,
} from "./caddy-wake-fallback";

const PROXMOX_STATIC_ORIGIN_TLS =
  "tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key";

// DNS hostname shape for per-tenant gateway vhosts: 1–253 chars of LDH
// labels. This is the root-cause SEC-03 gate for every value that lands in a
// Caddy site address, a `rm`-able site filename, or a `curl --resolve` arg:
// it rejects whitespace/newlines, Caddy block braces and quotes (directive
// injection) and heredoc metacharacters ($ ` \) outright.
const GATEWAY_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function isSafeGatewayHostname(host: string): boolean {
  return GATEWAY_HOSTNAME_PATTERN.test(host);
}

// The provision script emits the vhost inside an UNQUOTED bash heredoc, so it
// passes the bash placeholder instead of a literal — the host expands it when
// writing the site file. It is the only non-literal value permitted through
// assertSupportedProxmoxGatewayHost; restore/apply paths must never see it.
const GATEWAY_SITE_LABEL_PLACEHOLDER = "${GATEWAY_SITE_LABEL}";

export function isCoveredByProxmoxStaticOriginCert(gatewayHost: string): boolean {
  return /^(?:[a-z0-9-]+\.)?hermesos\.cloud$/i.test(gatewayHost);
}

export function assertSupportedProxmoxGatewayHost(gatewayHost: string): void {
  if (
    gatewayHost !== GATEWAY_SITE_LABEL_PLACEHOLDER &&
    !isSafeGatewayHostname(gatewayHost)
  ) {
    throw new Error(
      `Proxmox gateway host ${gatewayHost} is not a valid DNS hostname`,
    );
  }
  const normalized = gatewayHost.trim().toLowerCase();
  if (
    normalized.endsWith(".hermesos.cloud") &&
    !isCoveredByProxmoxStaticOriginCert(normalized)
  ) {
    throw new Error(
      `Proxmox gateway host ${gatewayHost} is not covered by the static Origin CA certificate; canonicalize it to a one-label *.hermesos.cloud host or seed a dedicated certificate before provisioning`,
    );
  }
}

// Characters that would break out of a Caddy token or quoted string, inject
// directives (newlines, {, }, #) or get expanded inside the provisioning
// heredoc ($, `, \). Every literal value spliced into the site is rejected on
// any of these; the only exempt values are the provision placeholders below,
// which the host expands when writing the site file.
const CADDY_SITE_UNSAFE_CHARS = /[\s"'`\\{}$#]/;

const PRIVATE_IP_PLACEHOLDERS = ["${PRIVATE_IP}"] as const;
const DASHBOARD_ORIGIN_PLACEHOLDERS = ["${DASHBOARD_ORIGIN}"] as const;
const WAKE_REDIRECT_URL_PLACEHOLDERS = ["${WAKE_REDIRECT_URL}"] as const;

function assertSafeCaddySiteToken(
  field: string,
  value: string,
  opts: { placeholders?: readonly string[]; allowEmpty?: boolean } = {},
): void {
  if (opts.placeholders?.includes(value)) return;
  if (value === "" && opts.allowEmpty) return;
  if (value === "" || CADDY_SITE_UNSAFE_CHARS.test(value)) {
    throw new Error(
      `Refusing to emit Proxmox gateway Caddy site: ${field} ${JSON.stringify(value)} is not safe to embed`,
    );
  }
}

/**
 * The one source of truth for PVE host-side tenant routes. Values may be
 * literal restore values or shell placeholders used by the provision script.
 * Keep emitted text safe for an unquoted shell heredoc (no backticks).
 */
export function buildProxmoxGatewayCaddySite(params: {
  gatewayHost: string;
  privateIp: string;
  instanceId: string;
  dashboardOrigin: string;
  wakeRedirectUrl?: string;
  /** Required when gatewayHost is a shell placeholder rather than a literal. */
  useStaticOriginTls?: boolean;
}): string {
  assertSupportedProxmoxGatewayHost(params.gatewayHost);
  assertSafeCaddySiteToken("privateIp", params.privateIp, {
    placeholders: PRIVATE_IP_PLACEHOLDERS,
  });
  assertSafeCaddySiteToken("instanceId", params.instanceId);
  assertSafeCaddySiteToken("dashboardOrigin", params.dashboardOrigin, {
    placeholders: DASHBOARD_ORIGIN_PLACEHOLDERS,
    allowEmpty: true,
  });
  const wakeRedirectUrl =
    params.wakeRedirectUrl ??
    buildWakeRedirectUrl(params.dashboardOrigin, params.instanceId);
  assertSafeCaddySiteToken("wakeRedirectUrl", wakeRedirectUrl, {
    placeholders: WAKE_REDIRECT_URL_PLACEHOLDERS,
  });
  const useStaticOriginTls =
    params.useStaticOriginTls ??
    isCoveredByProxmoxStaticOriginCert(params.gatewayHost);
  const tls = useStaticOriginTls ? `\n  ${PROXMOX_STATIC_ORIGIN_TLS}\n` : "";
  const wakeFallback = buildWakeFallbackCaddyBlock(wakeRedirectUrl);

  const cors = params.dashboardOrigin
    ? `
  @options method OPTIONS
  handle @options {
    header Access-Control-Allow-Origin "${params.dashboardOrigin}"
    header Access-Control-Allow-Methods "GET, POST, OPTIONS"
    header Access-Control-Allow-Headers "Content-Type, Authorization, x-hermes-trace-id"
    respond 204
  }

  @chatCors path /api/chat/* /api/chat-jobs/*
  header @chatCors Access-Control-Allow-Origin "${params.dashboardOrigin}"
  header @chatCors Access-Control-Allow-Credentials "true"
  header @chatCors Access-Control-Expose-Headers "X-Stream-Id, X-Session-Id"
`
    : "";
  const corsProxyHeaders = params.dashboardOrigin
    ? `
    header_down -Access-Control-Allow-Origin
    header_down -Access-Control-Allow-Credentials
    header_down -Access-Control-Expose-Headers`
    : "";

  return `${params.gatewayHost} {${tls}
${wakeFallback}
${cors}
  reverse_proxy ${params.privateIp}:80 {
    header_up -Sec-WebSocket-Extensions${corsProxyHeaders}
    flush_interval -1
    transport http {
      response_header_timeout 0s
      read_timeout 0s
    }
  }
}
`;
}
