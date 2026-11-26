import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import allowlist from "./certification-allowlist.json";
import { canaryLaunchSealAllowed, catalogAppRequiresPinnedDigest } from "./launch-seals";
import type { CatalogAppManifest } from "./schema";

type CatalogCertificate = { manifestSha256: string; provisionerVersion: string };
const certificates: Readonly<Record<string, CatalogCertificate | undefined>> = allowlist.apps;

export function hasCurrentCatalogCertification(manifest: CatalogAppManifest): boolean {
  const certificate = Object.hasOwn(certificates, manifest.id) ? certificates[manifest.id] : undefined;
  return matchesCatalogCertificate(manifest, certificate);
}

export function matchesCatalogCertificate(manifest: CatalogAppManifest, certificate: CatalogCertificate | undefined): boolean {
  return certificate !== undefined
    && canaryLaunchSealAllowed(certificate.provisionerVersion, catalogAppRequiresPinnedDigest(manifest))
    && certificate.manifestSha256 === bytesToHex(sha256(utf8ToBytes(JSON.stringify(manifest))));
}
