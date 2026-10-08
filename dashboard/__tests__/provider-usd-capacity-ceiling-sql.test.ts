import { execFileSync } from "node:child_process";
import path from "node:path";

it("applies the USD capacity ceiling without changing EUR validation in real PostgreSQL", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-provider-usd-capacity-ceiling.mjs")],
    { encoding: "utf8", timeout: 90_000 });
  expect(output).toContain("PASS USD ceiling: actual 8 GiB receipt, 60 boundary, unchanged EUR, disk/identity/consent and ACL retention");
}, 95_000);
