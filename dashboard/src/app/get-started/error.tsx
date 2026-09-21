'use client';

import AuthFlowError from '@/components/auth/AuthFlowError';

export default function GetStartedError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <AuthFlowError
      error={error}
      unstable_retry={unstable_retry}
      route="/get-started"
      title="Something interrupted setup."
      description="Retry this step to reload the onboarding and checkout flow."
      retryLabel="Retry setup"
    />
  );
}
