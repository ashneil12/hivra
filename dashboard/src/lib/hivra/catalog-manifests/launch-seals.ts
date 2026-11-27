import launchSeals from "./launch-seals.json";
import type { CatalogAppManifest } from "./schema";

export function catalogAppRequiresPinnedDigest(manifest: CatalogAppManifest): boolean {
  return manifest.runtime.kind === "docker-web" && Boolean(manifest.runtime.imageDigest);
}

export function canaryLaunchSealAllowed(version: string, requirePinnedCatalogDigest: boolean): boolean {
  return requirePinnedCatalogDigest ? version === launchSeals.pinned : launchSeals.unpinned.includes(version);
}
