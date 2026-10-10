import { isPlatformAccountId } from "@/lib/account-owner-id";

describe("isPlatformAccountId", () => {
  const originalAuthMode = process.env.HIVRA_AUTH_MODE;
  const originalPublicAuthMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;

  afterEach(() => {
    if (originalAuthMode === undefined) delete process.env.HIVRA_AUTH_MODE;
    else process.env.HIVRA_AUTH_MODE = originalAuthMode;
    if (originalPublicAuthMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = originalPublicAuthMode;
  });

  it("accepts Clerk user ids", () => {
    expect(isPlatformAccountId("user_2abcDEF123xyz")).toBe(true);
    expect(isPlatformAccountId("user_123")).toBe(true);
  });

  it("rejects ids a Supabase Auth JWT would carry, and malformed values", () => {
    for (const value of [
      "00000000-0000-4000-8000-0000000000a1",
      "",
      "user_",
      "user-123",
      "user_123 ",
      " user_123",
      "user_12;drop",
      "USER_123",
      null,
      undefined,
      42,
    ]) {
      expect(isPlatformAccountId(value)).toBe(false);
    }
  });

  it("accepts the self-host operator only in local auth mode", () => {
    delete process.env.HIVRA_AUTH_MODE;
    delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    expect(isPlatformAccountId("hivra-local-operator")).toBe(false);

    process.env.HIVRA_AUTH_MODE = "local";
    expect(isPlatformAccountId("hivra-local-operator")).toBe(true);
    expect(isPlatformAccountId("hivra-other-operator")).toBe(false);
  });
});
