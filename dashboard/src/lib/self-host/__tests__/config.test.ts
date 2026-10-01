import { readFileSync } from "node:fs";
import path from "node:path";

import { PUBLIC_SUPABASE_DEFAULT_JWT_SECRET, requireLocalJwtSecret } from "../config";

describe("requireLocalJwtSecret", () => {
  const original = process.env.HIVRA_LOCAL_JWT_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.HIVRA_LOCAL_JWT_SECRET;
    else process.env.HIVRA_LOCAL_JWT_SECRET = original;
  });

  it("returns a private secret", () => {
    process.env.HIVRA_LOCAL_JWT_SECRET = "f".repeat(64);
    expect(requireLocalJwtSecret()).toBe("f".repeat(64));
  });

  it("refuses a missing or short secret", () => {
    delete process.env.HIVRA_LOCAL_JWT_SECRET;
    expect(() => requireLocalJwtSecret()).toThrow(/at least 32 characters/);
    process.env.HIVRA_LOCAL_JWT_SECRET = "short";
    expect(() => requireLocalJwtSecret()).toThrow(/at least 32 characters/);
  });

  it("refuses the public Supabase default, which anyone can use to forge a session", () => {
    process.env.HIVRA_LOCAL_JWT_SECRET = PUBLIC_SUPABASE_DEFAULT_JWT_SECRET;
    expect(() => requireLocalJwtSecret()).toThrow(/public Supabase default/);
    process.env.HIVRA_LOCAL_JWT_SECRET = `  ${PUBLIC_SUPABASE_DEFAULT_JWT_SECRET}  `;
    expect(() => requireLocalJwtSecret()).toThrow(/public Supabase default/);
  });

  it("names the same default as the self-host launcher, which replaces it on start", () => {
    const launcher = readFileSync(path.join(process.cwd(), "scripts", "hivra-self-host.mjs"), "utf8");
    const match = /export const SUPABASE_CLI_DEFAULT_JWT_SECRET = "([^"]+)";/.exec(launcher);
    expect(match?.[1]).toBeTruthy();
    expect(match?.[1]).toBe(PUBLIC_SUPABASE_DEFAULT_JWT_SECRET);
  });
});
