import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, { version?: string; resolved?: string }>;
};
const copiesOf = (name: string) => Object.entries(lock.packages)
  .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
  .map(([path, info]) => ({ path, version: info.version ?? "0.0.0" }));

function atLeast(version: string, minimum: string): boolean {
  const actual = version.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== floor[index]) return actual[index] > floor[index];
  }
  return true;
}

describe("reviewed dependency security floors (2026-09-21)", () => {
  it.each([
    ["deepmerge-ts", "8.0.0"],
    ["html-to-text", "10.0.1"],
    ["nanoid", "3.3.18"],
    ["fastify", "5.12.1"],
    ["nodemailer", "9.1.1"],
    ["vitest", "4.1.11"],
    ["@vitest/mocker", "4.1.11"],
  ])("keeps every %s copy at least %s", (name, minimum) => {
    const copies = copiesOf(name);
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect({ path: copy.path, secure: atLeast(copy.version, minimum) })
        .toEqual({ path: copy.path, secure: true });
    }
  });

  it("keeps registry tarball names aligned with package versions after source redaction", () => {
    for (const [path, info] of Object.entries(lock.packages)) {
      if (!info.resolved || !info.version) continue;
      const url = new URL(info.resolved);
      if (url.hostname !== "registry.npmjs.org") continue;
      const name = path.split("/node_modules/").at(-1)!.replace(/^node_modules\//, "").split("/").at(-1)!;
      expect(decodeURIComponent(url.pathname).split("/").at(-1), path).toBe(`${name}-${info.version}.tgz`);
    }
  });

  it("patches both fast-uri major lines without forcing a cross-major override", () => {
    const copies = copiesOf("fast-uri");
    expect(copies.length).toBeGreaterThan(0);
    const floors: Record<string, string> = { "3": "3.1.6", "4": "4.1.3" };
    for (const copy of copies) {
      expect(copy.version).toMatch(/^\d+\.\d+\.\d+$/);
      const minimum = floors[copy.version.split(".")[0]];
      expect(minimum).toBeDefined();
      expect(atLeast(copy.version, minimum)).toBe(true);
    }
  });

  it("does not normalize an encoded scheme into a new authority or raw header characters", () => {
    // Exercise the actual v3 copy loaded by Fastify's validator, not a mock or
    // an unrelated root dependency. GHSA-jqff-g426-hqxp permits either rejecting
    // an invalid scheme or preserving its escaped structure, never decoding it
    // into an authority/header delimiter.
    const require = createRequire(import.meta.url);
    const compilerRequire = createRequire(require.resolve("@fastify/ajv-compiler"));
    const uri = compilerRequire("fast-uri") as {
      normalize(value: string): string;
      parse(value: string): { host?: string };
    };
    expect(uri.normalize("https://example.test/path")).toBe("https://example.test/path");
    for (const value of ["%2f%2fevil.example:/pwn", "%u002f%u002fevil.example:/pwn", "https%0d%0aX-Test:injected"]) {
      let normalized: string;
      try {
        normalized = uri.normalize(value);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        continue;
      }
      expect(normalized).not.toMatch(/[\r\n]/);
      expect(uri.parse(normalized).host).toBeUndefined();
    }
  });

  it("the real mail parser still extracts a verification code from HTML", async () => {
    const parsed = await simpleParser([
      "From: fixture@example.test", "To: user@example.test", "Subject: Verification",
      "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "",
      "<html><body><p>Your code is <strong>123456</strong>.</p></body></html>",
    ].join("\r\n"));
    expect(parsed.text).toContain("123456");
    expect(parsed.subject).toBe("Verification");
  });
});
