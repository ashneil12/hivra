import { headers } from 'next/headers';

import {
  analyzeClerkRuntimeEnvironment,
  deriveRuntimeOriginFromHeaders,
} from '@/lib/clerk-runtime-config';
import { AuthLocalSetupPanel } from '@/components/auth/AuthLocalSetupPanel';
import { AuthClerkProviderClient } from '@/components/auth/AuthClerkProviderClient';

export async function AuthClerkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  if (process.env.HIVRA_AUTH_MODE?.trim().toLowerCase() === "local") {
    return <AuthClerkProviderClient>{children}</AuthClerkProviderClient>;
  }

  const requestHeaders = await headers();
  const runtime = analyzeClerkRuntimeEnvironment({
    publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    allowedOrigins: process.env.NEXT_PUBLIC_CLERK_ALLOWED_ORIGINS,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    runtimeOrigin: deriveRuntimeOriginFromHeaders(requestHeaders),
  });

  if (runtime.shouldBlock) {
    return <AuthLocalSetupPanel runtime={runtime} />;
  }

  return <AuthClerkProviderClient>{children}</AuthClerkProviderClient>;
}
