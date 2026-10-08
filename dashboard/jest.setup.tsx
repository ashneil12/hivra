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

// The real token geo list (lib/compliance/token-geo-list.ts) blocks the UK. Most
// suites test token screens and routes as any other country sees them, so they
// run against an empty list. A suite that tests the gate itself opts back in with
// its own `jest.mock('@/lib/compliance/token-geo-list', () =>
// jest.requireActual('@/lib/compliance/token-geo-list'))` (the *real-list* suites
// and the geo route and page suites do), so the committed list is proven to reach
// the policy, the routes, the pages and the rewrites. With the empty list those
// checks cannot fail.
jest.mock('@/lib/compliance/token-geo-list', () => ({ BLOCKED_COUNTRIES: [] }));

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
