import { execFileSync } from "node:child_process";
import path from "node:path";

it("uploads the provisioner bundle dotfile to Vercel without reopening default exclusions", () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/test-vercel-provisioner-upload.cjs")],
    { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("PASS Vercel upload: required bundle dotfile included, unrelated default exclusions retained");
}, 35_000);
