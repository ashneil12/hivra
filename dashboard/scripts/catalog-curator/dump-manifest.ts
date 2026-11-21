// Dumps universal catalog manifests as JSON for scripts/catalog-curator.
// Usage: dump-manifest.ts <slug> | --all
// Imports the manifest registry directly (no "@/" alias deps) so plain
// ts-node transpile-only can run it.

import { UNIVERSAL_CATALOG_MANIFESTS } from "../../src/lib/hivra/catalog-manifests/manifests/index";

const arg = process.argv[2];

if (arg === "--all") {
  process.stdout.write(JSON.stringify(UNIVERSAL_CATALOG_MANIFESTS));
  process.exit(0);
}

const manifest = UNIVERSAL_CATALOG_MANIFESTS.find((entry) => entry.id === arg);
if (!manifest) {
  console.error(`unknown catalog slug: ${arg ?? "(none)"}`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(manifest));
