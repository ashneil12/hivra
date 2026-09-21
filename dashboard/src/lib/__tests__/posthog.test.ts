// Regression guard: the server-side posthog-node client must NEVER emit to the
// real prod PostHog project (368999) while running under test/CI.
//
// History: jest suites that transitively reached `posthogClient.capture()`
// (e.g. the `box_created` activation event in instance-service.createInstance,
// reached by many route/cron/sweep tests) were firing REAL events into prod
// PostHog with fixture instance ids (inst_123, inst_orphan, …), corrupting the
// activation funnel and polluting error samples. The fix disables the client
// whenever NODE_ENV==='test' or POSTHOG_DISABLED==='true'.
//
// The baked-in token is now GONE: the key comes from NEXT_PUBLIC_POSTHOG_KEY and
// nothing else, and a missing key disables the client. Previously the fallback
// pointed at the prod project, so canary's server-side `box_created`/billing
// events were ingested into production analytics — the environment that "forgot"
// to set a key silently got prod's.

type ConstructorArgs = [string, { host?: string; disabled?: boolean }];

const constructed: ConstructorArgs[] = [];

jest.mock("posthog-node", () => ({
  __esModule: true,
  PostHog: jest.fn().mockImplementation((apiKey: string, options: { host?: string; disabled?: boolean }) => {
    constructed.push([apiKey, options ?? {}]);
    return {
      capture: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    };
  }),
}));

function loadClientWith(env: Record<string, string | undefined>): { host?: string; disabled?: boolean } {
  return loadClientArgsWith(env)[1] ?? {};
}

function loadClientArgsWith(env: Record<string, string | undefined>): ConstructorArgs {
  const prev = { ...process.env };
  // Apply the requested overrides on top of the current env, deleting keys
  // explicitly set to undefined so we test the "unset" case faithfully.
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  jest.resetModules();
  constructed.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../posthog");
  const args = constructed[constructed.length - 1] ?? ["", {}];
  process.env = prev;
  return args as ConstructorArgs;
}

/** The literal that used to be baked in — it must never reappear. */
const PROD_FALLBACK_TOKEN = "phc_zNoQPCQxtRRysXyyxdCwnMyXSvDW8bEPGosSzZRXCQKn";

describe("server posthog client emit guard", () => {
  it("is disabled when NODE_ENV is test (the jest/CI default)", () => {
    const opts = loadClientWith({ NODE_ENV: "test", POSTHOG_DISABLED: undefined });
    expect(opts.disabled).toBe(true);
  });

  it("is disabled when POSTHOG_DISABLED is set, even outside the test env", () => {
    const opts = loadClientWith({ NODE_ENV: "production", POSTHOG_DISABLED: "true" });
    expect(opts.disabled).toBe(true);
  });

  it("is NOT disabled in a real production runtime (preserves live capture)", () => {
    const opts = loadClientWith({ NODE_ENV: "production", POSTHOG_DISABLED: undefined });
    expect(opts.disabled).toBe(false);
  });

  it("keeps the production host fallback unchanged", () => {
    const opts = loadClientWith({
      NODE_ENV: "production",
      POSTHOG_DISABLED: undefined,
      NEXT_PUBLIC_POSTHOG_HOST: undefined,
    });
    expect(opts.host).toBe("https://us.i.posthog.com");
  });
});

describe("server posthog client project token", () => {
  it("is disabled when no project token is configured, even in production", () => {
    const opts = loadClientWith({
      NODE_ENV: "production",
      POSTHOG_DISABLED: undefined,
      NEXT_PUBLIC_POSTHOG_KEY: undefined,
      NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: undefined,
    });
    // A missing key means analytics OFF — never "analytics into whichever
    // project the old fallback literal happened to name".
    expect(opts.disabled).toBe(true);
  });

  it("never constructs with the old hardcoded production token", () => {
    const [key] = loadClientArgsWith({
      NODE_ENV: "production",
      POSTHOG_DISABLED: undefined,
      NEXT_PUBLIC_POSTHOG_KEY: undefined,
      NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: undefined,
    });
    expect(key).not.toBe(PROD_FALLBACK_TOKEN);
  });

  it("uses EXACTLY the configured token and enables capture in production", () => {
    const [key, opts] = loadClientArgsWith({
      NODE_ENV: "production",
      POSTHOG_DISABLED: undefined,
      NEXT_PUBLIC_POSTHOG_KEY: "phc_canary_project_token",
    });
    expect(key).toBe("phc_canary_project_token");
    expect(opts.disabled).toBe(false);
  });
});
