import {
  buildWakeFallbackCaddyBlock,
  buildWakeRedirectUrl,
} from "./caddy-wake-fallback";

const PROXMOX_STATIC_ORIGIN_TLS =
  "tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key";

export function isCoveredByProxmoxStaticOriginCert(gatewayHost: string): boolean {
  return /^(?:[a-z0-9-]+\.)?hermesos\.cloud$/i.test(gatewayHost);
}

export function assertSupportedProxmoxGatewayHost(gatewayHost: string): void {
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
  const useStaticOriginTls =
    params.useStaticOriginTls ??
    isCoveredByProxmoxStaticOriginCert(params.gatewayHost);
  const tls = useStaticOriginTls ? `\n  ${PROXMOX_STATIC_ORIGIN_TLS}\n` : "";
  const wakeFallback = buildWakeFallbackCaddyBlock(
    params.wakeRedirectUrl ??
      buildWakeRedirectUrl(params.dashboardOrigin, params.instanceId),
  );

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
