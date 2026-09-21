export interface GatewayProbeOptions {
  instanceIpv4?: string;
  profileGatewayPort?: number | null;
}

export function buildGatewayProbeUrls(
  baseUrl: string,
  pathname: string,
  options: GatewayProbeOptions = {}
): string[] {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const secureUrl = new URL(normalizedBaseUrl.startsWith("http") ? normalizedBaseUrl : `https://${normalizedBaseUrl}`);
  const shouldPreserveBasePath = !normalizedPathname.startsWith("/_sidecar");
  const basePath = shouldPreserveBasePath && secureUrl.pathname !== "/" ? secureUrl.pathname.replace(/\/$/, "") : "";
  const joinedPath = `${basePath}${normalizedPathname}`;
  const urls: string[] = [];
  const instanceIpv4 = options.instanceIpv4?.trim();
  const profileMatch = shouldPreserveBasePath ? basePath.match(/^\/profiles\/[^/]+(\/.*)?$/) : null;
  const directProfileUrl =
    profileMatch && instanceIpv4 && options.profileGatewayPort
      ? `http://${instanceIpv4}:${options.profileGatewayPort}${profileMatch[1] || ""}${normalizedPathname}`
      : null;

  // Dedicated profile ports bypass Caddy entirely and avoid the slowest failure mode
  // we see in chat: hanging profile routes before the real profile gateway is tried.
  if (directProfileUrl) {
    urls.push(directProfileUrl);
  }

  urls.push(`https://${secureUrl.host}${joinedPath}`);

  if (instanceIpv4) {
    if (secureUrl.hostname !== instanceIpv4) {
      const portSegment = secureUrl.port ? `:${secureUrl.port}` : "";
      urls.push(`http://${instanceIpv4}${portSegment}${joinedPath}`);
    }
  }

  return Array.from(new Set(urls));
}
