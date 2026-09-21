'use client';

import AuthFlowError from '@/components/auth/AuthFlowError';

export default function SignUpError({
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
      route="/sign-up"
      title="Something interrupted sign up."
      description="Retry this step to reload the sign-up flow."
      retryLabel="Retry sign up"
    />
  );
}
