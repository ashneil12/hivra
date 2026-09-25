import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import { checkCustomRoutes, type Header, type Rewrite } from 'next/dist/lib/load-custom-routes';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination';
import { clerkAssetScriptUrls } from '@/lib/clerk-assets';
import nextConfig, { scrubHostedEnvironmentForSelfHost } from '../../next.config';

async function listRewrites(): Promise<Rewrite[]> {
  const rewrites = await nextConfig.rewrites?.();
  if (!rewrites) return [];
  if (Array.isArray(rewrites)) return rewrites;
  return [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? []), ...(rewrites.fallback ?? [])];
}

// Resolves a request path the way Next's router does: filesystem.ts builds
// each rewrite matcher with these options and resolve-routes.ts turns a match
// into the destination with prepareDestination. It also checks that the
// routes-manifest regex (what Vercel's edge matches on) agrees on every rule.
async function resolveRewrite(pathname: string): Promise<string | null> {
  for (const rule of await listRewrites()) {
    const params = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex: string) => modifyRouteRegex(regex),
    })(pathname);
    const manifestRegex = new RegExp(buildCustomRoute('rewrite', rule).regex, 'i');
    expect(manifestRegex.test(pathname)).toBe(Boolean(params));
    if (!params) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: true,
      destination: rule.destination,
      params,
      query: {},
    });
    const { protocol, hostname, port, pathname: destinationPath } = parsedDestination;
    return `${protocol}//${hostname}${port ? `:${port}` : ''}${destinationPath}`;
  }
  return null;
}

// Collects the response headers Next's router sets for a path. When two rules
// set the same key, the later rule wins (resolve-routes.ts assigns in order).
async function resolveHeaders(pathname: string): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const rule of (await nextConfig.headers?.()) ?? []) {
    const matched = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex: string) => modifyRouteRegex(regex),
    })(pathname);
    if (!matched) continue;
    for (const header of rule.headers) resolved[header.key.toLowerCase()] = header.value;
  }
  return resolved;
}

const CLERK_ASSET_PATHS_THE_APP_LOADS = [
  // The two entry bundles AuthClerkProviderClient hands to ClerkProvider.
  '/clerk-assets/@clerk/clerk-js@6.8.0/dist/clerk.browser.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/ui.browser.js',
  // Lazy chunks both bundles load from their own dist/ directory at runtime.
  '/clerk-assets/@clerk/clerk-js@6.8.0/dist/vendors_clerk.browser_999ac2_6.8.0.js',
  '/clerk-assets/@clerk/clerk-js@6.8.0/dist/coinbase-wallet-sdk_clerk.browser_999ac2_6.8.0.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/vendors_ui_1adcfa_1.7.0.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/userbutton_ui_1adcfa_1.7.0.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/framework_ui_1adcfa_1.7.0.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/606_ui_1adcfa_1.7.0.js',
];

const CLERK_ASSET_PATHS_TO_REFUSE = [
  // Any other npm package, including markup that runs script same-origin.
  '/clerk-assets/some-other-package@1/x.js',
  '/clerk-assets/evil-pkg@1.0.0/x.svg',
  '/clerk-assets/evil-pkg@1.0.0/index.html',
  '/clerk-assets/@clerk/not-clerk-js@6.8.0/dist/clerk.browser.js',
  // The Clerk packages at a version the app does not pin.
  '/clerk-assets/@clerk/clerk-js@6.7.0/dist/clerk.browser.js',
  '/clerk-assets/@clerk/ui@latest/dist/ui.browser.js',
  '/clerk-assets/@clerk/ui@1/dist/ui.browser.js',
  // Pinned packages, but not a runtime script in dist/.
  '/clerk-assets/@clerk/ui@1.7.0/package.json',
  '/clerk-assets/@clerk/ui@1.7.0/dist/themes/shadcn.css',
  '/clerk-assets/@clerk/ui@1.7.0/dist/x.svg',
  '/clerk-assets/@clerk/clerk-js@6.8.0/dist/types/core/clerk.d.ts',
  // Traversal out of the pinned dist/ directory, raw and percent-encoded.
  '/clerk-assets/@clerk/ui@1.7.0/dist/../../evil-pkg@1.0.0/x.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/..%2f..%2f..%2fevil-pkg@1.0.0%2fx.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/%2e%2e%2f%2e%2e%2fevil-pkg@1.0.0%2fx.js',
  '/clerk-assets/@clerk/ui@1.7.0/dist/..js',
];

describe('next config', () => {
  it('keeps operator-owned Cloudflare tunnel credentials in self-host mode while removing hosted secrets', () => {
    const env: Record<string, string | undefined> = {
      CLOUDFLARE_API_TOKEN: 'operator-tunnel-token',
      CLOUDFLARE_TUNNEL_API_TOKEN: 'operator-dedicated-token',
      CLOUDFLARE_ZONE_ID: 'operator-zone',
      CLOUDFLARE_DNS_DOMAIN: 'agents.example.test',
      STRIPE_SECRET_KEY: 'hosted-stripe-secret',
      CLERK_SECRET_KEY: 'hosted-clerk-secret',
      NEXT_PUBLIC_POSTHOG_KEY: 'hosted-analytics-key',
    };

    scrubHostedEnvironmentForSelfHost(env, true);

    expect(env).toMatchObject({
      CLOUDFLARE_API_TOKEN: 'operator-tunnel-token',
      CLOUDFLARE_TUNNEL_API_TOKEN: 'operator-dedicated-token',
      CLOUDFLARE_ZONE_ID: 'operator-zone',
      CLOUDFLARE_DNS_DOMAIN: 'agents.example.test',
    });
    expect(env).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(env).not.toHaveProperty('CLERK_SECRET_KEY');
    expect(env).not.toHaveProperty('NEXT_PUBLIC_POSTHOG_KEY');
  });

  it.each([
    '/api/infrastructure/connections/*/prepare',
    '/api/infrastructure/connections/*/hetzner-cloud/capacity/setup',
    '/api/hivra/agents',
    '/api/hivra/agents/*',
  ])('ships the complete private provisioner bundle, including dotfiles, for %s', (route) => {
    expect(nextConfig.outputFileTracingIncludes?.[route]).toEqual([
      './provisioner/**/*',
      './provisioner/.gitignore',
    ]);
  });

  it('keeps production browser source maps enabled so PostHog can resolve minified client stack frames', () => {
    expect(nextConfig.productionBrowserSourceMaps).toBe(true);
  });

  it('adds anonymous crossorigin attributes to Next-managed scripts for clearer third-party failures', () => {
    expect(nextConfig.crossOrigin).toBe('anonymous');
  });

  it('allows the homepage Google Tag Manager loader in the report-only document script policy', async () => {
    const headers = await nextConfig.headers?.();
    const documentHeaders = headers?.find((entry) => entry.source === '/(.*)')?.headers ?? [];
    const csp = documentHeaders.find(
      (header) => header.key === 'Content-Security-Policy-Report-Only',
    )?.value;
    const scriptSrc = csp?.split('; ').find((directive) => directive.startsWith('script-src '));

    expect(scriptSrc).toContain('https://www.googletagmanager.com');
  });

  it('allows Clerk lazy-loaded UI chunks served from jsdelivr (vendors_ui_*.js, userbutton_ui_*.js, etc.) in script-src', async () => {
    // @clerk/ui >= 1.7 + @clerk/clerk-js >= 6.8 fan out ui.browser.js into
    // named sub-chunks fetched at runtime. Without jsdelivr in script-src,
    // /dashboard was burning ~10 distinct CSP violation fingerprints per
    // page load (vendors_ui_*, userbutton_ui_*, framework_ui_*, etc.).
    const headers = await nextConfig.headers?.();
    const documentHeaders = headers?.find((entry) => entry.source === '/(.*)')?.headers ?? [];
    const csp = documentHeaders.find(
      (header) => header.key === 'Content-Security-Policy-Report-Only',
    )?.value;
    const scriptSrc = csp?.split('; ').find((directive) => directive.startsWith('script-src '));

    expect(scriptSrc).toContain('https://cdn.jsdelivr.net');
  });

  it('allows only the opt-in hosted Fingerprint Pro loader and API origins', async () => {
    const headers = await nextConfig.headers?.();
    const documentHeaders = headers?.find((entry) => entry.source === '/(.*)')?.headers ?? [];
    const csp = documentHeaders.find(
      (header) => header.key === 'Content-Security-Policy-Report-Only',
    )?.value;
    const scriptSrc = csp?.split('; ').find((directive) => directive.startsWith('script-src '));
    const connectSrc = csp?.split('; ').find((directive) => directive.startsWith('connect-src '));

    expect(scriptSrc).toContain('https://fpjscdn.net');
    expect(scriptSrc).toContain('https://fpnpmcdn.net');
    expect(connectSrc).toContain('https://*.fpjs.io');
  });

  describe('/clerk-assets same-origin Clerk proxy', () => {
    const originalClerkJsVersion = process.env.NEXT_PUBLIC_CLERK_JS_VERSION;
    const originalClerkUiVersion = process.env.NEXT_PUBLIC_CLERK_UI_VERSION;

    afterEach(() => {
      if (originalClerkJsVersion == null) delete process.env.NEXT_PUBLIC_CLERK_JS_VERSION;
      else process.env.NEXT_PUBLIC_CLERK_JS_VERSION = originalClerkJsVersion;
      if (originalClerkUiVersion == null) delete process.env.NEXT_PUBLIC_CLERK_UI_VERSION;
      else process.env.NEXT_PUBLIC_CLERK_UI_VERSION = originalClerkUiVersion;
    });

    it.each(CLERK_ASSET_PATHS_THE_APP_LOADS)(
      'still proxies %s to the same jsDelivr file so sign-in keeps working',
      async (pathname) => {
        await expect(resolveRewrite(pathname)).resolves.toBe(
          `https://cdn.jsdelivr.net/npm${pathname.slice('/clerk-assets'.length)}`,
        );
      },
    );

    it.each(CLERK_ASSET_PATHS_TO_REFUSE)('refuses %s', async (pathname) => {
      await expect(resolveRewrite(pathname)).resolves.toBeNull();
    });

    it('proxies the exact entry URLs the Clerk provider loads, including after a version override', async () => {
      const defaults = clerkAssetScriptUrls();
      await expect(resolveRewrite(defaults.clerkJS)).resolves.toBe(
        'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.8.0/dist/clerk.browser.js',
      );
      await expect(resolveRewrite(defaults.clerkUI)).resolves.toBe(
        'https://cdn.jsdelivr.net/npm/@clerk/ui@1.7.0/dist/ui.browser.js',
      );

      process.env.NEXT_PUBLIC_CLERK_JS_VERSION = '6.9.1';
      await expect(resolveRewrite(clerkAssetScriptUrls().clerkJS)).resolves.toBe(
        'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.9.1/dist/clerk.browser.js',
      );
    });

    it('never forwards a request to jsDelivr outside the pinned Clerk dist directories', async () => {
      const jsdelivrRules = (await listRewrites()).filter((rule) =>
        rule.destination.startsWith('https://cdn.jsdelivr.net/'),
      );

      expect(jsdelivrRules.map((rule) => rule.destination.replace(/:file$/, ''))).toEqual([
        'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.8.0/dist/',
        'https://cdn.jsdelivr.net/npm/@clerk/ui@1.7.0/dist/',
      ]);
    });

    it('follows an exact NEXT_PUBLIC_CLERK_*_VERSION override and refuses the old pin', async () => {
      process.env.NEXT_PUBLIC_CLERK_JS_VERSION = '6.9.1';
      process.env.NEXT_PUBLIC_CLERK_UI_VERSION = '1.8.0-snapshot.1';

      await expect(resolveRewrite('/clerk-assets/@clerk/clerk-js@6.9.1/dist/clerk.browser.js')).resolves.toBe(
        'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.9.1/dist/clerk.browser.js',
      );
      await expect(resolveRewrite('/clerk-assets/@clerk/ui@1.8.0-snapshot.1/dist/ui.browser.js')).resolves.toBe(
        'https://cdn.jsdelivr.net/npm/@clerk/ui@1.8.0-snapshot.1/dist/ui.browser.js',
      );
      await expect(resolveRewrite('/clerk-assets/@clerk/ui@1.7.0/dist/ui.browser.js')).resolves.toBeNull();
    });

    it.each(['1', '6.x', 'latest', '6.8.0/../../evil-pkg@1', '^6.8.0'])(
      'fails the build for a non-exact Clerk version override (%s)',
      async (version) => {
        // Clerk's bundles load their lazy chunks from the exact version they
        // were built as, so a range would load the entry file and then break.
        process.env.NEXT_PUBLIC_CLERK_UI_VERSION = version;

        await expect(Promise.resolve().then(() => nextConfig.rewrites?.())).rejects.toThrow(
          /NEXT_PUBLIC_CLERK_UI_VERSION must be an exact npm version/,
        );
      },
    );

    it.each([
      '/clerk-assets/@clerk/ui@1.7.0/dist/ui.browser.js',
      '/clerk-assets/evil-pkg@1.0.0/x.svg',
    ])('sends an enforced sandbox CSP and nosniff on %s', async (pathname) => {
      const headers = await resolveHeaders(pathname);
      const csp = headers['content-security-policy'] ?? '';
      const directives = csp.split(';').map((directive) => directive.trim());

      expect(directives).toEqual(expect.arrayContaining(["default-src 'none'", 'sandbox']));
      expect(headers['x-content-type-options']).toBe('nosniff');
    });

    it('keeps the rewrites and headers valid for next build', async () => {
      const rewrites = await listRewrites();
      const headers: Header[] = (await nextConfig.headers?.()) ?? [];

      // next build runs this same validation; it logs each invalid route and
      // exits the process.
      const exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(() => checkCustomRoutes(rewrites, 'rewrite')).not.toThrow();
        expect(() => checkCustomRoutes(headers, 'header')).not.toThrow();
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        consoleError.mockRestore();
      }
    });
  });

  it("allows 'unsafe-eval' so the Next.js framework chunk that runs raw eval() in production doesn't fire CSP report-uri storms", async () => {
    // The chunk surface differs per build (hashed name like `00wc6kd8v012v.js`)
    // but the violation fingerprint is stable: `script-src` blocking `eval`.
    // `'wasm-unsafe-eval'` only covers WebAssembly.Module instantiation —
    // it does not cover plain eval()/Function() from JS chunks.
    const headers = await nextConfig.headers?.();
    const documentHeaders = headers?.find((entry) => entry.source === '/(.*)')?.headers ?? [];
    const csp = documentHeaders.find(
      (header) => header.key === 'Content-Security-Policy-Report-Only',
    )?.value;
    const scriptSrc = csp?.split('; ').find((directive) => directive.startsWith('script-src '));

    expect(scriptSrc).toContain("'unsafe-eval'");
  });
});
