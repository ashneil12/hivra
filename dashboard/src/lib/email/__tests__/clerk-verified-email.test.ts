/**
 * The shared rule for which Clerk address Hivra mails: only an address Clerk reports
 * as verified, the primary first (F106). Both the REST shape (welcome, lifecycle,
 * audience) and the SDK shape (computer-stopped, withdraw, renewal, tier, watchdog)
 * must agree.
 */
import { pickVerifiedEmail, pickVerifiedSdkEmail } from "@/lib/email/clerk-verified-email";

describe("pickVerifiedEmail (Clerk REST user)", () => {
  it("returns the primary address when Clerk reports it verified", () => {
    expect(
      pickVerifiedEmail({
        primary_email_address_id: "em_1",
        email_addresses: [
          { id: "em_1", email_address: "ash@example.com", verification: { status: "verified" } },
        ],
      }),
    ).toBe("ash@example.com");
  });

  it("returns null when every address is unverified", () => {
    expect(
      pickVerifiedEmail({
        primary_email_address_id: "em_1",
        email_addresses: [
          { id: "em_1", email_address: "victim@example.com", verification: { status: "unverified" } },
        ],
      }),
    ).toBeNull();
  });

  it("returns the address without surrounding whitespace", () => {
    expect(
      pickVerifiedEmail({
        primary_email_address_id: "em_1",
        email_addresses: [
          { id: "em_1", email_address: "  ash@example.com ", verification: { status: "verified" } },
        ],
      }),
    ).toBe("ash@example.com");
  });
});

describe("pickVerifiedSdkEmail (Clerk SDK user)", () => {
  it("picks the primary by primaryEmailAddressId and only when verified", () => {
    expect(
      pickVerifiedSdkEmail({
        primaryEmailAddressId: "email_2",
        emailAddresses: [
          { id: "email_1", emailAddress: "typed@example.com", verification: { status: "unverified" } },
          { id: "email_2", emailAddress: "owner@example.com", verification: { status: "verified" } },
        ],
      }),
    ).toBe("owner@example.com");
  });

  it("falls back to the first verified address when the primary is unverified", () => {
    expect(
      pickVerifiedSdkEmail({
        primaryEmailAddressId: "email_1",
        emailAddresses: [
          { id: "email_1", emailAddress: "typed@example.com", verification: { status: "unverified" } },
          { id: "email_2", emailAddress: "owner@example.com", verification: { status: "verified" } },
        ],
      }),
    ).toBe("owner@example.com");
  });

  it("returns null for a missing user or one with no verified address", () => {
    expect(pickVerifiedSdkEmail(undefined)).toBeNull();
    expect(pickVerifiedSdkEmail(null)).toBeNull();
    expect(
      pickVerifiedSdkEmail({
        primaryEmailAddressId: "email_1",
        emailAddresses: [{ id: "email_1", emailAddress: "typed@example.com", verification: null }],
      }),
    ).toBeNull();
  });
});
