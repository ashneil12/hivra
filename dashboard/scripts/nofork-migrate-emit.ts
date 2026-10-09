/**
 * Prints the box-side no-fork migration script (or the one-command launcher) so an operator can run
 * it on a single box. Used by docs/release/NO-FORK-MIGRATION.md and for canary proofs.
 *
 *   npx tsx scripts/nofork-migrate-emit.ts --instance <uuid> --overlay <overlay image ref> \
 *     [--expect-upstream nousresearch/hermes-agent@sha256:<digest>] [--launcher [--force]]
 */
import {
  buildNoForkMigrationLauncher,
  buildNoForkMigrationScript,
} from "../src/lib/services/no-fork-migration-builder";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const instanceId = arg("instance");
const expectUpstreamImage = arg("expect-upstream");
const overlayImage = arg("overlay");
if (!instanceId || !overlayImage) {
  console.error("usage: nofork-migrate-emit.ts --instance <id> --overlay <ref> [--expect-upstream <repo@sha256:..>] [--launcher]");
  process.exit(2);
}
const script = buildNoForkMigrationScript({ instanceId, overlayImage, expectUpstreamImage });
process.stdout.write(process.argv.includes("--launcher") ? buildNoForkMigrationLauncher(script, instanceId, { skipIdleGate: process.argv.includes("--force") }) : script);
