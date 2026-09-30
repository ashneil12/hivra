import React from 'react';

// PostHogProvider and lib/posthog resolve their project token from the env and
// have NO baked-in fallback — a missing key means analytics OFF. Give the suite
// an explicit, obviously-fake token so the provider tests still exercise the
// real init path, while `lib/posthog` stays `disabled` under NODE_ENV=test and
// so can never reach a real project. Tests that assert the key-less behaviour
// delete this themselves before re-importing.
if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_token_not_a_real_project';
}

const mockClerk = {
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useUser: () => ({
    isSignedIn: true,
    user: {
      id: 'user_123',
      fullName: 'Test User',
      primaryEmailAddress: { emailAddress: 'test@example.com' },
    },
  }),
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: 'user_123',
    sessionId: 'session_123',
    getToken: jest.fn(() => Promise.resolve('mock-token')),
  }),
  useSession: jest.fn(() => ({
    session: {
      id: 'session_123',
      getToken: jest.fn(() => Promise.resolve('mock-token')),
    },
    isLoaded: true,
    isSignedIn: true,
  })),
  // A session that verified recently: requests pass straight through. Tests
  // of the "confirm it's you" flow mock this themselves.
  useReverification: (fetcher: (...args: unknown[]) => unknown) => fetcher,
  UserButton: () => <div data-testid="mock-user-button">User Button</div>,
  SignIn: () => <div data-testid="mock-sign-in">Sign In</div>,
  SignUp: () => <div data-testid="mock-sign-up">Sign Up</div>,
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: () => null,
};

jest.mock('@clerk/nextjs', () => mockClerk);
jest.mock('@clerk/react', () => mockClerk);
jest.mock('server-only', () => ({}));
