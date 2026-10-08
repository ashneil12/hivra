import { execFileSync } from "node:child_process";
import path from "node:path";

it("gates external Hetzner cleanup by owner, revision, state and freshness on the full portable schema", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-hetzner-external-cleanup.cjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS: owner/revision/state/freshness gates, immutable ambiguity/ledger, secret revocation, idempotency, claim bound, disconnect, restricted grants");
}, 95_000);
