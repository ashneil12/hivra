const CANARY_HOSTS = new Set(["canary.hermesos.cloud"]);

function hostnameOf(host: string | null | undefined): string | null {
  const hostname = host?.split(":", 1)[0].trim().toLowerCase();
  return hostname || null;
}

export function isCanaryHost(host: string | null | undefined): boolean {
  const hostname = hostnameOf(host);
  return hostname ? CANARY_HOSTS.has(hostname) : false;
}

// Hosts that serve the site but must never be indexed: Canary, plus every
// *.vercel.app deployment alias (hermesos-canary.vercel.app serves Canary
// content, hermesos.vercel.app mirrors production). Their canonicals point at
// hivra.cloud, but an indexable duplicate host still competes with it.
export function isNoIndexHost(host: string | null | undefined): boolean {
  const hostname = hostnameOf(host);
  if (!hostname) return false;
  return CANARY_HOSTS.has(hostname) || hostname.endsWith(".vercel.app");
}
