import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("catalog curator stale-PR reconciliation", () => {
  it("closes only fully superseded manifest sets and keeps unique entries recoverable", () => {
    const script = resolve(__dirname, "../scripts/catalog-curator/reconcile-stale-prs.mjs");
    const moduleUrl = JSON.stringify(pathToFileURL(script).href);
    const source = `
      import assert from "node:assert/strict";
      const mod = await import(${moduleUrl});
      const present = new Set(["already-on-canary"]);
      const owners = new Map([
        ["already-on-canary", [10]],
        ["duplicated", [10, 12]],
        ["unique", [10]],
        ["older-only", [9, 10]],
      ]);
      assert.deepEqual(
        mod.catalogIdsNeedingRecovery(["already-on-canary", "duplicated"], present, owners, 10),
        [],
        "entries on canary or in a newer open PR need no recovery",
      );
      assert.deepEqual(
        mod.catalogIdsNeedingRecovery(["duplicated", "unique"], present, owners, 10),
        ["unique"],
        "a partial overlap must not close away a unique entry",
      );
      assert.deepEqual(
        mod.catalogIdsNeedingRecovery(["older-only"], present, owners, 10),
        ["older-only"],
        "only newer PRs supersede an entry",
      );
    `;

    execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: resolve(__dirname, ".."),
      stdio: "pipe",
    });
  });
});
