/**
 * Shared Clerk test doubles.
 *
 * 135 test files hand-roll a `jest.mock("@clerk/nextjs/server")` factory with
 * one of three shapes (auth / currentUser / clerkClient). These builders
 * produce all three so a file only declares the surface it actually stubs.
 */
export interface ClerkAuthMock {
  userId: string | null;
  sessionId: string | null;
  getToken: jest.Mock;
}

/** Default signed-in auth() result. Override per test with `auth.mockResolvedValue(...)`. */
export function createClerkAuthMock(overrides: Partial<ClerkAuthMock> = {}): ClerkAuthMock {
  return {
    userId: "user_123",
    sessionId: "session_123",
    getToken: jest.fn(async () => "mock-token"),
    ...overrides,
  };
}

/** A signed-out auth() result. */
export function createClerkSignedOutAuthMock(): ClerkAuthMock {
  return { userId: null, sessionId: null, getToken: jest.fn(async () => null) };
}

/** Default currentUser() payload matching the global jest.setup.tsx shape. */
export function createClerkUserMock(overrides: Record<string, unknown> = {}) {
  return {
    id: "user_123",
    fullName: "Test User",
    primaryEmailAddress: { emailAddress: "test@example.com" },
    ...overrides,
  };
}

/**
 * A Clerk server module double with every export the route handlers use.
 * Returns the object to hand to `jest.mock("@clerk/nextjs/server", () => createClerkServerMock())`.
 */
export function createClerkServerMock(options: { signedOut?: boolean; user?: unknown } = {}) {
  const auth = jest.fn(async () => (options.signedOut ? createClerkSignedOutAuthMock() : createClerkAuthMock()));
  const currentUser = jest.fn(async () => (options.signedOut ? null : (options.user ?? createClerkUserMock())));
  return {
    auth,
    currentUser,
    clerkClient: jest.fn(async () => ({
      users: {
        updateUser: jest.fn(async () => ({})),
        getUser: jest.fn(async () => options.user ?? createClerkUserMock()),
        getUserList: jest.fn(async () => ({ data: [] })),
      },
    })),
  };
}
