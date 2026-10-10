// Same-origin proxy for Clerk's two browser bundles.
//
// cdn.jsdelivr.net times out for a slice of users every week and takes
// sign-in down with it, so the app loads Clerk from /clerk-assets on its own
// origin and next.config.ts rewrites those requests to jsDelivr. That rewrite
// runs on the dashboard origin, so it must only reach the pinned Clerk
// packages: an open /clerk-assets/:path* -> jsdelivr/npm/:path* proxy serves
// any npm package, including SVG or HTML that runs script as the dashboard.
//
// next.config.ts (build time) and AuthClerkProviderClient (browser) both read
// the pins from here, so the URLs the app loads and the paths the proxy
// accepts cannot drift apart.

export const CLERK_ASSETS_PREFIX = "/clerk-assets";

const CLERK_ASSETS_UPSTREAM = "https://cdn.jsdelivr.net/npm";

const DEFAULT_CLERK_JS_VERSION = "6.8.0";
const DEFAULT_CLERK_UI_VERSION = "1.7.0";

// Exact npm versions only. Each bundle loads its lazy chunks from the exact
// version it was built as (it rewrites its own URL to that version), so a
// range or a tag would load the entry file and then fail on every chunk. The
// character set also keeps the version from changing the rewrite's shape.
const EXACT_NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// One flat .js file directly inside the package's dist/ directory, which is
// where both bundles and all their lazy chunks live. No "/" or "%", and the
// name cannot start with ".", so a request cannot climb out of dist/.
const DIST_SCRIPT_FILE_PATTERN = "[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.js";

export type ClerkAssetVersions = {
  clerkJS: string;
  clerkUI: string;
};

function exactVersion(name: string, value: string | undefined, fallback: string): string {
  const version = value?.trim() || fallback;
  if (!EXACT_NPM_VERSION.test(version)) {
    throw new Error(
      `${name} must be an exact npm version such as ${fallback}, got "${version}". ` +
        "The /clerk-assets proxy only serves the pinned Clerk packages.",
    );
  }
  return version;
}

export function clerkAssetVersions(): ClerkAssetVersions {
  // Literal process.env.NEXT_PUBLIC_* reads so Next inlines them into the
  // browser bundle; the build-time rewrites see the same values.
  return {
    clerkJS: exactVersion(
      "NEXT_PUBLIC_CLERK_JS_VERSION",
      process.env.NEXT_PUBLIC_CLERK_JS_VERSION,
      DEFAULT_CLERK_JS_VERSION,
    ),
    clerkUI: exactVersion(
      "NEXT_PUBLIC_CLERK_UI_VERSION",
      process.env.NEXT_PUBLIC_CLERK_UI_VERSION,
      DEFAULT_CLERK_UI_VERSION,
    ),
  };
}

function distDirectories(versions: ClerkAssetVersions): string[] {
  return [`@clerk/clerk-js@${versions.clerkJS}/dist`, `@clerk/ui@${versions.clerkUI}/dist`];
}

export function clerkAssetScriptUrls(versions: ClerkAssetVersions = clerkAssetVersions()) {
  const [clerkJSDist, clerkUIDist] = distDirectories(versions);
  return {
    clerkJS: `${CLERK_ASSETS_PREFIX}/${clerkJSDist}/clerk.browser.js`,
    clerkUI: `${CLERK_ASSETS_PREFIX}/${clerkUIDist}/ui.browser.js`,
  };
}

// Only the file name is taken from the request; the package, version and
// dist/ directory in the destination are fixed. Anything else under
// /clerk-assets matches no rewrite and gets the app's 404.
export function clerkAssetRewrites(versions: ClerkAssetVersions = clerkAssetVersions()) {
  return distDirectories(versions).map((dist) => ({
    source: `${CLERK_ASSETS_PREFIX}/${dist}/:file(${DIST_SCRIPT_FILE_PATTERN})`,
    destination: `${CLERK_ASSETS_UPSTREAM}/${dist}/:file`,
  }));
}

// Scripts loaded with <script src> ignore a response CSP, so this does not
// affect Clerk. It stops anything served under /clerk-assets from running as
// a document on the dashboard origin if it is ever opened directly.
export const clerkAssetHeaders = {
  source: `${CLERK_ASSETS_PREFIX}/:path*`,
  headers: [
    { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'; sandbox" },
    { key: "X-Content-Type-Options", value: "nosniff" },
  ],
};
