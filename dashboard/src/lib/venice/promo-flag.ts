// Marketing promo slot flag. OFF unless exactly "true". Read through a computed
// key (like lib/referral.ts) so the live runtime value is used, not a build-time freeze.
const VENICE_PROMO_FLAG_ENV = "NEXT_PUBLIC_HIVRA_VENICE_PROMO_ENABLED";

export function isVenicePromoEnabled(): boolean {
  const key = VENICE_PROMO_FLAG_ENV;
  return process.env[key] === "true";
}
