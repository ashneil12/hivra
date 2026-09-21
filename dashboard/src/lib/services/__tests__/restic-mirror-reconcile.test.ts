import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReconcileMirrorsScript } from "../restic-mirror-reconcile";

const A = "00000000-0000-4000-8000-000000001051";
const B = "00000000-0000-4000-8000-000000001050";

describe("buildReconcileMirrorsScript", () => {
  it("embeds every keep id in the heredoc", () => {
    const s = buildReconcileMirrorsScript([A, B]);
    expect(s).toContain(A);
    expect(s).toContain(B);
    expect(s).toContain("HERMES_RESTIC_KEEP_SET");
  });

  it("only touches instance-id-shaped dirs and keeps ones in the keep-set", () => {
    const s = buildReconcileMirrorsScript([A]);
    // gate: dir name must match the instance-id shape before we consider removing it
    expect(s).toMatch(/grep -Eq '\^\[0-9a-f-\]\{36\}\$'/);
    // keep if present in the keep-set
    expect(s).toContain('grep -qxF "$id" "$KEEP_FILE" && continue');
    // remove path
    expect(s).toContain('rm -rf "$dir"');
    expect(s).toContain("RECONCILE_REMOVED");
    expect(s).toContain("RECONCILE_DONE");
  });

  it("aborts on an empty/garbage keep-set (never wipes every mirror)", () => {
    const s = buildReconcileMirrorsScript([]);
    expect(s).toContain("RECONCILE_ABORT empty_or_invalid_keep_set");
    // and the empty keep-set genuinely fails the pre-flight guard
    expect(s).toMatch(/if ! grep -Eq .* "\$KEEP_FILE"; then/);
  });

  it("skips a mirror whose backup lock is currently held", () => {
    const s = buildReconcileMirrorsScript([A]);
    expect(s).toContain("/var/lock/hermes-restic-$id.lock");
    expect(s).toContain("flock -n");
    expect(s).toContain("RECONCILE_SKIP_LOCKED");
  });

  it("honours a HERMES_RESTIC_MIRROR_ROOT override with a safe default", () => {
    const s = buildReconcileMirrorsScript([A]);
    expect(s).toContain('MIRROR_ROOT="${HERMES_RESTIC_MIRROR_ROOT:-/var/lib/hermes-restic-src}"');
  });

  // The script is a TS template literal with hand-escaped bash ${...}; a bad
  // escape ships broken bash to every PVE host. Assert it actually parses.
  it("generates syntactically valid bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
    try {
      const file = join(dir, "reconcile.sh");
      writeFileSync(file, "#!/usr/bin/env bash\n" + buildReconcileMirrorsScript([A, B]));
      // throws on a syntax error; exit 0 = valid
      execFileSync("bash", ["-n", file], { stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
