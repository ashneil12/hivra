const CANARY_PROJECT_DOMAINS = new Set(["canary.hermesos.cloud", "hermesos-canary.vercel.app"]);

type Env = Record<string, string | undefined>;

/** Until launch, trust the Vercel project's own domain, not the request host or Git branch. */
export function isVenicePromoEnabled(env: Env = process.env): boolean {
  if (env.HIVRA_VENICE_PROMO_ENABLED !== "true") return false;

  const projectDomain = env.VERCEL_PROJECT_PRODUCTION_URL?.trim().toLowerCase();
  if (projectDomain) return CANARY_PROJECT_DOMAINS.has(projectDomain);

  return !env.VERCEL && env.NODE_ENV === "development";
}

export function isVenicePromoBannerEnabled(env: Env = process.env): boolean {
  return isVenicePromoEnabled(env) && env.NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED === "true";
}
