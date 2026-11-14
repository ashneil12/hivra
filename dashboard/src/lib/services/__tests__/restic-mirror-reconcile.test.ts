import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

  // REGRESSION: under `set -o pipefail` a failing `du` (unreadable or vanishing
  // files) used to abort the whole reconcile at the size lookup, so the
  // ${kb:-0} fallback and RECONCILE_DONE never ran and later orphans were skipped.
  it("keeps reconciling when du fails on an orphan mirror", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-du-"));
    try {
      const mirrorRoot = join(dir, "mirrors");
      const orphan = join(mirrorRoot, B);
      mkdirSync(orphan, { recursive: true });
      writeFileSync(join(orphan, "data"), "x");
      const fakeBin = join(dir, "bin");
      mkdirSync(fakeBin);
      // du exits non-zero the way it does when part of the tree cannot be read.
      writeFileSync(join(fakeBin, "du"), "#!/bin/sh\necho 'du: cannot read' >&2\nexit 1\n", { mode: 0o700 });
      const file = join(dir, "reconcile.sh");
      writeFileSync(file, "#!/usr/bin/env bash\n" + buildReconcileMirrorsScript([A]));

      // execFileSync throws on a non-zero exit, so the pre-fix abort fails here.
      const out = execFileSync("bash", [file], {
        encoding: "utf8",
        env: { PATH: `${fakeBin}:/usr/bin:/bin`, HERMES_RESTIC_MIRROR_ROOT: mirrorRoot } as unknown as NodeJS.ProcessEnv,
        stdio: "pipe",
      });

      expect(out).toContain(`RECONCILE_REMOVED id=${B} kb=0`);
      expect(out).toContain("RECONCILE_DONE");
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
