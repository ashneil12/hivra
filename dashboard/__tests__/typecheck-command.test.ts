import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

it("runs the installed no-emit typechecker with an explicit 4 GiB heap budget", () => {
  const dashboard = path.resolve(__dirname, "..");
  const manifest = JSON.parse(readFileSync(path.join(dashboard, "package.json"), "utf8")) as { scripts: { typecheck: string } };
  const command = manifest.scripts.typecheck.split(" ");
  expect(command).toEqual(["node", "--max-old-space-size=4096", "node_modules/typescript/bin/tsc", "--noEmit"]);

  const options = { cwd: dashboard, encoding: "utf8" as const, timeout: 5000, env: { PATH: process.env.PATH, NODE_ENV: "test" as const } };
  const compiler = spawnSync(process.execPath, [...command.slice(1), "--version"], options);
  expect(compiler.status).toBe(0);
  expect(compiler.stdout).toMatch(/^Version \d+\.\d+/);

  const budget = spawnSync(process.execPath, [command[1], "-e", "process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit))"], options);
  expect(budget.status).toBe(0);
  expect(Number(budget.stdout)).toBeGreaterThanOrEqual(4096 * 1024 * 1024);
});
