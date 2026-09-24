'use client';

import { ClerkProvider } from '@clerk/nextjs';
import type { ComponentProps, ComponentType, ReactNode } from 'react';

import { HIVRA_CLERK_LOCALIZATION } from './clerk-localization';

const DEFAULT_CLERK_JS_VERSION = '6.8.0';
const DEFAULT_CLERK_UI_VERSION = '1.7.0';

function envOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

const clerkJSVersion = envOrDefault(
  process.env.NEXT_PUBLIC_CLERK_JS_VERSION,
  DEFAULT_CLERK_JS_VERSION,
);
const clerkUIVersion = envOrDefault(
  process.env.NEXT_PUBLIC_CLERK_UI_VERSION,
  DEFAULT_CLERK_UI_VERSION,
);
// Default to the same-origin /clerk-assets proxy (a Next.js rewrite to
// cdn.jsdelivr.net/npm — see next.config.ts): jsdelivr times out for a slice
// of users every week and breaks sign-in. Clerk resolves its lazy UI chunks
// relative to the ui.browser.js URL, so the rewrite covers the whole dist
// dir. The env overrides stay as the escape hatch back to a direct CDN URL.
const clerkJSUrl = envOrDefault(
  process.env.NEXT_PUBLIC_CLERK_JS_URL,
  `/clerk-assets/@clerk/clerk-js@${clerkJSVersion}/dist/clerk.browser.js`,
);
const clerkUIUrl = envOrDefault(
  process.env.NEXT_PUBLIC_CLERK_UI_URL,
  `/clerk-assets/@clerk/ui@${clerkUIVersion}/dist/ui.browser.js`,
);

type InternalClerkProviderProps = ComponentProps<typeof ClerkProvider> & {
  __internal_clerkJSUrl?: string;
  __internal_clerkJSVersion?: string;
  __internal_clerkUIUrl?: string;
  __internal_clerkUIVersion?: string;
};

const InternalClerkProvider = ClerkProvider as ComponentType<InternalClerkProviderProps>;

export function AuthClerkProviderClient({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <InternalClerkProvider
      __internal_clerkJSUrl={clerkJSUrl}
      __internal_clerkJSVersion={clerkJSVersion}
      __internal_clerkUIUrl={clerkUIUrl}
      __internal_clerkUIVersion={clerkUIVersion}
      localization={HIVRA_CLERK_LOCALIZATION}
    >
      {children}
    </InternalClerkProvider>
  );
}
