const CANARY_HOSTS = new Set(["canary.hermesos.cloud"]);

export function isCanaryHost(host: string | null | undefined): boolean {
  const hostname = host?.split(":", 1)[0].trim().toLowerCase();
  return hostname ? CANARY_HOSTS.has(hostname) : false;
}
