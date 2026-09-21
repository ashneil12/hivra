import { execFileSync } from "node:child_process";

it("keeps the existing Hetzner client importable by standalone Node operations scripts", () => {
  // No Jest module mapping, server-only shim, dotenv, fetch or provider access.
  // An eager server-only marker in the new pure policy module broke this path
  // even while Next's build and the mapped in-process Jest tests passed.
  const output = execFileSync(process.execPath, [
    "-r", require.resolve("ts-node/register/transpile-only"),
    "-r", require.resolve("tsconfig-paths/register"),
    "-e", 'const c = require("./src/lib/hetzner/client"); if (c.mapHetznerStatus("running") !== "running") process.exit(1); process.stdout.write("standalone-client-import-ok");',
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true",
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs", moduleResolution: "node" }) } });
  expect(output).toBe("standalone-client-import-ok");
});
