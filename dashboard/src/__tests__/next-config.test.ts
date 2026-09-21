import nextConfig, { scrubHostedEnvironmentForSelfHost } from '../../next.config';

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

  it('proxies Clerk npm assets same-origin via /clerk-assets so a jsdelivr outage cannot take down sign-in', async () => {
    // Clerk resolves its lazy UI chunks relative to the ui.browser.js URL, so
    // the rewrite must cover the entire /npm/* dist path, not single files.
    const rewrites = await nextConfig.rewrites?.();
    const list = Array.isArray(rewrites) ? rewrites : [];
    const clerkAssets = list.find((rule) => rule.source === '/clerk-assets/:path*');

    expect(clerkAssets?.destination).toBe('https://cdn.jsdelivr.net/npm/:path*');
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
