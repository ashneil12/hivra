// Feature switch for the declarative Universal Catalog App & Agent Engine.
// Off by default until the generic catalog-app provisioner release is live and
// Wave 1 manifests pass the Canary launch sweep. Client-safe: read the literal
// NEXT_PUBLIC env name so Next.js inlines it into browser bundles.
export function isUniversalCatalogEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_UNIVERSAL_CATALOG,
): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
