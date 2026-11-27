// Feature switch for the declarative Universal Catalog App & Agent Engine.
// Off by default; enabling it only exposes entries with a current certification.
// Client-safe: read the literal
// NEXT_PUBLIC env name so Next.js inlines it into browser bundles.
export function isUniversalCatalogEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_UNIVERSAL_CATALOG,
): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
