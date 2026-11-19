import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const dashboard = path.resolve(__dirname, "..");

function rootFiles(project: string): string[] {
  const output = execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "--project", project, "--showConfig",
  ], { cwd: dashboard, encoding: "utf8" });
  return JSON.parse(output).files;
}

it("keeps Jest tests in the full typecheck and every other root in the production build", () => {
  const full = rootFiles("tsconfig.json");
  expect(full).toContain("./__tests__/typecheck-command.test.ts");

  const env = jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: "production" });
  try {
    jest.isolateModules(() => {
      const { default: config } = jest.requireActual<typeof import("../next.config")>("../next.config");
      const build = rootFiles(config.typescript?.tsconfigPath ?? "tsconfig.json");
      expect(build).toEqual(full.filter(file => !file.split("/").includes("__tests__")));
    });
  } finally {
    env.restore();
  }
});

it("runs the installed no-emit typechecker with an explicit 4 GiB heap budget", () => {
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
