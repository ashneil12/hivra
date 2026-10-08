/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("denies at the very next request after an agent is suspended, removed, has left, or its organization is paused", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-agent-network-authorization.cjs")],
    { encoding: "utf8", timeout: 90_000 }
  );
  expect(output).toContain("PASS agent network revoke-then-request over the real policy tables");
}, 100_000);
