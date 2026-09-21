import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  nextBuildCommand,
  nextBuildEnvironment,
  prepareNextBuildLock,
} from "../../scripts/next-build-with-stale-lock-recovery.cjs";

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hermes-next-lock-"));
}

function writeLock(projectDir: string, payload: unknown): string {
  const lockPath = path.join(projectDir, ".next", "dev", "lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, typeof payload === "string" ? payload : JSON.stringify(payload));
  return lockPath;
}

describe("next-build-with-stale-lock-recovery", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProjectDir();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("gives the Next build parent a 4 GiB V8 heap", () => {
    expect(nextBuildCommand("/tmp/next-bin")).toEqual([
      process.execPath,
      "--max-old-space-size=4096",
      "/tmp/next-bin",
      "build",
    ]);
  });

  it("propagates the heap limit to Next's build-time typecheck child", () => {
    expect(nextBuildEnvironment({ NODE_ENV: "test", NODE_OPTIONS: "--trace-warnings" })).toEqual({
      NODE_ENV: "test",
      NODE_OPTIONS: "--trace-warnings --max-old-space-size=4096",
    });
    expect(nextBuildEnvironment({ NODE_ENV: "test" }).NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });

  it("removes a stale Next dev lock when the recorded process is gone", () => {
    const lockPath = writeLock(projectDir, {
      pid: 12345,
      port: 3020,
      hostname: "localhost",
      appUrl: "http://localhost:3020",
    });
    const warnings: unknown[][] = [];

    const result = prepareNextBuildLock({
      cwd: projectDir,
      isPidActive: () => false,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    });

    expect(result.status).toBe("stale");
    expect(result.removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(JSON.stringify(warnings)).toContain("removed stale Next dev lock");
    expect(JSON.stringify(warnings)).toContain("12345");
  });

  it("keeps an active Next dev lock so a real dev server is not disturbed", () => {
    const lockPath = writeLock(projectDir, {
      pid: 23456,
      port: 3020,
      hostname: "localhost",
      appUrl: "http://localhost:3020",
    });
    const warnings: unknown[][] = [];

    const result = prepareNextBuildLock({
      cwd: projectDir,
      isPidActive: () => true,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    });

    expect(result.status).toBe("active");
    expect(result.removed).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.stringify(warnings)).toContain("active Next dev lock");
  });

  it("leaves unreadable lock contents in place instead of guessing", () => {
    const lockPath = writeLock(projectDir, "not-json");
    const warnings: unknown[][] = [];

    const result = prepareNextBuildLock({
      cwd: projectDir,
      isPidActive: () => false,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    });

    expect(result.status).toBe("unknown");
    expect(result.removed).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.stringify(warnings)).toContain("could not prove stale");
  });
});
