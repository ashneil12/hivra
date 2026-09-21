/**
 * Internal non-receiving recipient suppression for the announcement-audience sync.
 *
 * The first-run audit harness signs up synthetic Clerk users as
 * firstrun-audit-<hex>@hermesos.cloud, and both hermesos.cloud and hivra.cloud
 * have receiving disabled in Resend. Adding any of them as audience contacts
 * hard-bounces every future broadcast and poisons sender reputation — the same
 * class of problem the welcome-email suppression fixed. These tests pin that the
 * sync skips them at the webhook, reservation, and cron-batch entry points, and
 * that the orphan-prune pass removes any that already leaked into the audience.
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
  syncReservationToAnnouncementAudience,
  syncClerkUsersToAnnouncementAudience,
  type ClerkAnnouncementUser,
} from "../resend-announcement-sync";

const ORIGINAL_ENV = process.env;

function makeUser(id: string, email: string): ClerkAnnouncementUser {
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

describe("announcement sync — internal non-receiving recipient suppression", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      RESEND_API_KEY: "re_test",
      CLERK_SECRET_KEY: "sk_test",
    };
    jest.useFakeTimers();
    // Default happy-path stubs (used only by non-skipped control cases).
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

  describe("syncClerkUserToAnnouncementAudience (webhook path)", () => {
    it.each([
      ["firstrun-audit synthetic", "firstrun-audit-a1b2c3@hermesos.cloud"],
      ["hermesos.cloud placeholder", "ops@hermesos.cloud"],
      ["hivra.cloud placeholder", "ops@hivra.cloud"],
      ["mixed-case internal address", "Firstrun-Audit-DEAD@HERMESOS.CLOUD"],
    ])("skips a %s without any Resend call", async (_label, email) => {
      const result = await syncClerkUserToAnnouncementAudience(makeUser("user_int", email));

      expect(result).toEqual({ skipped: true, reason: "internal_recipient" });
      expect(contactsGet).not.toHaveBeenCalled();
      expect(contactsCreate).not.toHaveBeenCalled();
      expect(contactsUpdate).not.toHaveBeenCalled();
    });

    it("still syncs a normal external recipient (control)", async () => {
      // No existing contact → create path.
      contactsGet.mockResolvedValueOnce({
        error: { statusCode: 404, name: "not_found", message: "not found" },
      });

      const result = await syncClerkUserToAnnouncementAudience(
        makeUser("user_ext", "founder@gmail.com"),
      );
      await jest.runAllTimersAsync();

      expect(result.skipped).toBe(false);
      expect(contactsCreate).toHaveBeenCalledTimes(1);
      expect(contactsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ email: "founder@gmail.com" }),
      );
    });
  });

  describe("syncReservationToAnnouncementAudience (reservation path)", () => {
    it("skips an internal reservation email", async () => {
      const result = await syncReservationToAnnouncementAudience("firstrun-audit-99@hivra.cloud");

      expect(result).toEqual({ skipped: true, reason: "internal_recipient" });
      expect(contactsGet).not.toHaveBeenCalled();
      expect(contactsCreate).not.toHaveBeenCalled();
    });

    it("still syncs a normal reservation email (control)", async () => {
      contactsGet.mockResolvedValueOnce({
        error: { statusCode: 404, name: "not_found", message: "not found" },
      });

      const result = await syncReservationToAnnouncementAudience("waitlist@gmail.com");
      await jest.runAllTimersAsync();

      expect(result.skipped).toBe(false);
      expect(contactsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ email: "waitlist@gmail.com" }),
      );
    });
  });

  describe("syncClerkUsersToAnnouncementAudience (cron batch)", () => {
    it("filters internal recipients out of the sync and counts them as skipped", async () => {
      const users = [
        makeUser("user_real1", "a@gmail.com"),
        makeUser("user_audit", "firstrun-audit-77@hermesos.cloud"),
        makeUser("user_ops", "ops@hivra.cloud"),
        makeUser("user_real2", "b@gmail.com"),
      ];
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => users,
      }) as unknown as typeof fetch;

      // Both real recipients already exist → update path; no prune candidates.
      contactsGet.mockResolvedValue({ data: { id: "c_x", email: "x", unsubscribed: false }, error: null });

      const promise = syncClerkUsersToAnnouncementAudience();
      await jest.runAllTimersAsync();
      const result = await promise;

      // 4 Clerk users, 2 internal → only 2 real recipients synced.
      expect(result.recipients).toBe(2);
      expect(result.recipientsProcessed).toBe(2);
      expect(result.skipped).toBe(2);
      expect(contactsUpdate).toHaveBeenCalledTimes(2);

      const syncedEmails = contactsGet.mock.calls.map(([arg]) => arg.email);
      expect(syncedEmails).toContain("a@gmail.com");
      expect(syncedEmails).toContain("b@gmail.com");
      expect(syncedEmails).not.toContain("firstrun-audit-77@hermesos.cloud");
      expect(syncedEmails).not.toContain("ops@hivra.cloud");
    });

    it("prunes an internal contact that already leaked into the audience", async () => {
      const users = [makeUser("user_real", "real@gmail.com")];
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => users,
      }) as unknown as typeof fetch;

      // Sync path (recipient) + prune detail path share contacts.get; branch on email.
      contactsGet.mockImplementation(({ email }: { email: string }) => {
        if (email === "real@gmail.com") {
          return Promise.resolve({
            data: {
              id: "c_real",
              email,
              unsubscribed: false,
              properties: {
                source: { value: "clerk" },
                clerk_user_id: { value: "user_real" },
              },
            },
            error: null,
          });
        }
        return Promise.resolve({ data: { id: "c_x", email, unsubscribed: false }, error: null });
      });

      // Audience currently holds one leaked internal contact + the real one.
      contactsList.mockResolvedValue({
        data: {
          data: [
            { id: "c_audit", email: "firstrun-audit-42@hermesos.cloud" },
            { id: "c_real", email: "real@gmail.com" },
          ],
          has_more: false,
        },
        error: null,
      });

      const promise = syncClerkUsersToAnnouncementAudience();
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.pruned).toBe(1);
      expect(contactsRemove).toHaveBeenCalledTimes(1);
      expect(contactsRemove).toHaveBeenCalledWith({
        email: "firstrun-audit-42@hermesos.cloud",
      });
    });
  });
});
