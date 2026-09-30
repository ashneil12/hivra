/** @jest-environment node */
import { execFileSync } from "node:child_process";
import path from "node:path";

it("releases DigitalOcean agents only with an acknowledged forgotten receipt and keeps token expiry owner-bound", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-digitalocean-token-expiry-and-forget.cjs")],
    { encoding: "utf8", timeout: 45_000 }
  );
  expect(output).toContain("PASS digitalocean token expiry and forget");
}, 50_000);
