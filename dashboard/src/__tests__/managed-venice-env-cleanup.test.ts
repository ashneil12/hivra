import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const repoRoot = path.resolve(__dirname, "../../..");

const legacyManagedVeniceEnvNames = [
  ["NEXT", "PUBLIC", "ENABLE", "MANAGED", "VENICE"].join("_"),
  ["MANAGED", "VENICE", "ALLOWLIST"].join("_"),
];

// Synchronous, dependency-free backoff so retries don't turn this sync test
// async and don't hammer git while an index lock is still held.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function collectTrackedFiles(): string[] {
  // Shelling out to `git ls-files` from inside a jest worker under high
  // parallelism can transiently fail (index/lock contention, exec hiccups).
  // This is a repo-content guard, not product code, so retry a few times with
  // backoff before failing rather than flaking "Verify Dashboard" CI.
  const maxAttempts = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = execFileSync("git", ["ls-files", "-z"], {
        cwd: repoRoot,
        encoding: "buffer",
      });

      return output
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((file) => path.join(repoRoot, file));
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) sleepSync(50 * attempt);
    }
  }

  throw new Error(
    `git ls-files failed after ${maxAttempts} attempts: ${String(lastError)}`
  );
}

describe("Managed Venice env cleanup", () => {
  it("does not keep legacy release-gate env names in the repo", () => {
    const offenders: string[] = [];

    for (const file of collectTrackedFiles()) {
      let source: Buffer;
      try {
        source = fs.readFileSync(file);
      } catch (error) {
        // A tracked path can momentarily disappear mid-run (e.g. concurrent
        // worktree/checkout activity). Skip transient reads rather than flake.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (source.includes(0)) continue;

      const text = source.toString("utf8");
      for (const envName of legacyManagedVeniceEnvNames) {
        if (text.includes(envName)) {
          offenders.push(`${path.relative(repoRoot, file)} contains ${envName}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
