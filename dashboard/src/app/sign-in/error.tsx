'use client';

import AuthFlowError from '@/components/auth/AuthFlowError';

export default function SignInError({
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
      route="/sign-in"
      title="Something interrupted sign in."
      description="Retry this step to reload the sign-in flow."
      retryLabel="Retry sign in"
    />
  );
}
