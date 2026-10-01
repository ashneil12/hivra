/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";

const DASHBOARD = path.resolve(__dirname, "../..");
const SRC = path.join(DASHBOARD, "src");

/** The value of `key` inside the TOML table `[table]`, or undefined. */
function tomlValue(text: string, table: string, key: string): string | undefined {
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (current !== table || line.startsWith("#")) continue;
    const match = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

describe("supabase/config.toml sign-up", () => {
  // `supabase start` (local development and the self-host stack) reads this
  // file, and a future `supabase config push` would write it to a hosted
  // project. Hivra signs users in with Clerk (hosted) or its own local operator
  // login (self-host); GoTrue runs only so the CLI can publish API keys. An open
  // sign-up mints an `authenticated` JWT for anyone with a mailbox.
  const config = fs.readFileSync(path.join(DASHBOARD, "supabase/config.toml"), "utf8");

  it("keeps GoTrue sign-up off", () => {
    expect(tomlValue(config, "auth", "enable_signup")).toBe("false");
  });

  it("keeps GoTrue email sign-up off", () => {
    expect(tomlValue(config, "auth.email", "enable_signup")).toBe("false");
  });

  it("keeps anonymous sign-ins and Clerk third-party auth off", () => {
    expect(tomlValue(config, "auth", "enable_anonymous_sign_ins")).toBe("false");
    expect(tomlValue(config, "auth.third_party.clerk", "enabled")).toBe("false");
  });
});

describe("the anon-key Supabase client", () => {
  // The app reaches the database only as the service role. A `NEXT_PUBLIC_`
  // anon-key client is inlined into the browser bundle by any client component
  // that imports it, and it invites browser-side table access that only RLS
  // would stand behind. The anon key is still accepted as configuration, but
  // only the self-host status probe reads it, and only from a script.
  it("exports only the server-side admin client", () => {
    const previous = { ...process.env };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-test";
    try {
      let exported: string[] = [];
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        exported = Object.keys(require("@/lib/supabase"));
      });
      expect(exported).toEqual(["supabaseAdmin"]);
    } finally {
      process.env = previous;
    }
  });

  it("is not read by any application source file", () => {
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__") continue;
          walk(full);
        } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
          if (fs.readFileSync(full, "utf8").includes("NEXT_PUBLIC_SUPABASE_ANON_KEY")) {
            offenders.push(path.relative(DASHBOARD, full));
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
