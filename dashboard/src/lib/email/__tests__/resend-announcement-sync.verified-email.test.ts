/**
 * Verified-address rule for the announcement-audience sync.
 *
 * Clerk lets a user hold addresses that were typed in but never verified. Only an
 * address Clerk reports as verified may be enrolled in the 'Hivra customers' audience:
 * an unverified address can belong to someone who never signed up. These tests pin
 * that the webhook, reservation-free Clerk paths and the cron batch all skip or
 * re-target unverified addresses.
 */

const contactsGet = jest.fn();
const contactsCreate = jest.fn();
const contactsUpdate = jest.fn();
const contactsRemove = jest.fn();
const contactsList = jest.fn();
const segmentsAdd = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    segments: {
      list: jest.fn().mockResolvedValue({ data: { data: [{ id: "seg_1", name: "Hivra customers" }] }, error: null }),
      create: jest.fn().mockResolvedValue({ data: { id: "seg_1" }, error: null }),
    },
    topics: {
      list: jest.fn().mockResolvedValue({ data: { data: [{ id: "top_1", name: "Product updates", description: "" }] }, error: null }),
      create: jest.fn().mockResolvedValue({ data: { id: "top_1" }, error: null }),
      update: jest.fn().mockResolvedValue({ data: {}, error: null }),
    },
    contactProperties: {
      list: jest.fn().mockResolvedValue({ data: { data: [{ key: "clerk_user_id" }, { key: "clerk_created_at" }, { key: "source" }] }, error: null }),
      create: jest.fn().mockResolvedValue({ data: {}, error: null }),
    },
    contacts: {
      get: contactsGet,
      create: contactsCreate,
      update: contactsUpdate,
      remove: contactsRemove,
      list: contactsList,
      segments: { add: segmentsAdd },
    },
  })),
}));

import {
  syncClerkUserToAnnouncementAudience,
  syncClerkUsersToAnnouncementAudience,
  type ClerkAnnouncementUser,
} from "../resend-announcement-sync";

const ORIGINAL_ENV = process.env;

function verifiedUser(id: string, email: string): ClerkAnnouncementUser {
  return {
    id,
    first_name: "Test",
    last_name: "User",
    created_at: 1700000000000,
    primary_email_address_id: `email_${id}`,
    email_addresses: [
      { id: `email_${id}`, email_address: email, verification: { status: "verified" } },
    ],
  };
}

describe("announcement sync — only Clerk-verified addresses", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      RESEND_API_KEY: "re_test",
      CLERK_SECRET_KEY: "sk_test",
    };
    jest.useFakeTimers();
    contactsGet.mockResolvedValue({ data: { id: "c_1", email: "x", unsubscribed: false }, error: null });
    contactsCreate.mockResolvedValue({ data: { id: "c_new" }, error: null });
    contactsUpdate.mockResolvedValue({ data: {}, error: null });
    contactsRemove.mockResolvedValue({ data: {}, error: null });
    segmentsAdd.mockResolvedValue({ data: {}, error: null });
    contactsList.mockResolvedValue({ data: { data: [], has_more: false }, error: null });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  it("does not enrol a user whose only address is unverified", async () => {
    const user: ClerkAnnouncementUser = {
      id: "user_unverified",
      primary_email_address_id: "email_unverified",
      email_addresses: [
        { id: "email_unverified", email_address: "victim@gmail.com", verification: { status: "unverified" } },
      ],
    };

    const result = await syncClerkUserToAnnouncementAudience(user);

    expect(result).toEqual({ skipped: true, reason: "missing_email" });
    expect(contactsGet).not.toHaveBeenCalled();
    expect(contactsCreate).not.toHaveBeenCalled();
    expect(contactsUpdate).not.toHaveBeenCalled();
  });

  it("enrols the verified secondary address when the primary is unverified", async () => {
    const user: ClerkAnnouncementUser = {
      id: "user_mixed",
      primary_email_address_id: "email_primary",
      email_addresses: [
        { id: "email_primary", email_address: "typed-not-proven@gmail.com", verification: { status: "unverified" } },
        { id: "email_secondary", email_address: "proven@gmail.com", verification: { status: "verified" } },
      ],
    };
    contactsGet.mockResolvedValueOnce({
      error: { statusCode: 404, name: "not_found", message: "not found" },
    });

    const result = await syncClerkUserToAnnouncementAudience(user);
    await jest.runAllTimersAsync();

    expect(result.skipped).toBe(false);
    expect(contactsCreate).toHaveBeenCalledTimes(1);
    expect(contactsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: "proven@gmail.com" }),
    );
    const touched = [
      ...contactsGet.mock.calls,
      ...contactsCreate.mock.calls,
    ].map(([arg]) => arg.email);
    expect(touched).not.toContain("typed-not-proven@gmail.com");
  });

  it("still syncs a verified primary address (control)", async () => {
    contactsGet.mockResolvedValueOnce({
      error: { statusCode: 404, name: "not_found", message: "not found" },
    });

    const result = await syncClerkUserToAnnouncementAudience(
      verifiedUser("user_ok", "founder@gmail.com"),
    );
    await jest.runAllTimersAsync();

    expect(result.skipped).toBe(false);
    expect(contactsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: "founder@gmail.com" }),
    );
  });

  it("the cron batch leaves out users with no verified address", async () => {
    const users: ClerkAnnouncementUser[] = [
      verifiedUser("user_real", "real@gmail.com"),
      {
        id: "user_unverified",
        primary_email_address_id: "email_unverified",
        email_addresses: [
          { id: "email_unverified", email_address: "victim@gmail.com", verification: { status: "unverified" } },
        ],
      },
    ];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => users,
    }) as unknown as typeof fetch;
    contactsGet.mockResolvedValue({ data: { id: "c_x", email: "x", unsubscribed: false }, error: null });

    const promise = syncClerkUsersToAnnouncementAudience();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.recipients).toBe(1);
    expect(result.skipped).toBe(1);
    const syncedEmails = contactsGet.mock.calls.map(([arg]) => arg.email);
    expect(syncedEmails).toEqual(["real@gmail.com"]);
  });
});
