'use client';

import { ClerkProvider } from '@clerk/nextjs';
import type { ComponentProps, ComponentType, ReactNode } from 'react';

import { clerkAssetScriptUrls, clerkAssetVersions } from '@/lib/clerk-assets';

function envOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

const clerkVersions = clerkAssetVersions();
// Default to the same-origin /clerk-assets proxy (a Next.js rewrite to the
// pinned Clerk packages on cdn.jsdelivr.net, see src/lib/clerk-assets.ts):
// jsdelivr times out for a slice of users every week and breaks sign-in.
// Clerk loads its lazy chunks relative to these URLs, from the same dist/
// directory. The URL env overrides stay as the escape hatch back to a direct
// CDN URL.
const defaultClerkUrls = clerkAssetScriptUrls(clerkVersions);
const clerkJSVersion = clerkVersions.clerkJS;
const clerkUIVersion = clerkVersions.clerkUI;
const clerkJSUrl = envOrDefault(process.env.NEXT_PUBLIC_CLERK_JS_URL, defaultClerkUrls.clerkJS);
const clerkUIUrl = envOrDefault(process.env.NEXT_PUBLIC_CLERK_UI_URL, defaultClerkUrls.clerkUI);

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
    >
      {children}
    </InternalClerkProvider>
  );
}
