import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";

import allowlist from "./certification-allowlist.json";
import type { CatalogAppManifest } from "./schema";

const certificates: Readonly<Record<string, { manifestSha256: string } | undefined>> = allowlist.apps;

export function hasCurrentCatalogCertification(manifest: CatalogAppManifest): boolean {
  const certificate = Object.hasOwn(certificates, manifest.id) ? certificates[manifest.id] : undefined;
  return certificate !== undefined
    && allowlist.provisionerVersion === PORTABLE_HIVRA_PROVISIONER_VERSION
    && certificate.manifestSha256 === bytesToHex(sha256(utf8ToBytes(JSON.stringify(manifest))));
}
