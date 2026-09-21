/**
 * Time-budget tests for the announcement-audience sync.
 *
 * The sync sleeps ~800ms per recipient (Resend rate-limit headroom) and again
 * per orphan-prune contact, so runtime is linear in audience size and used to
 * silently 504 ("Task timed out after 300 seconds") once the audience grew. The
 * cron now passes a wall-clock budget so the loops stop cleanly under
 * maxDuration and the idempotent daily re-sync converges the tail. These tests
 * pin the budget behavior with an injected clock so they need no real time.
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

import { syncClerkUsersToAnnouncementAudience } from "../resend-announcement-sync";

const ORIGINAL_ENV = process.env;

function makeClerkUsers(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `user_${i}`,
    first_name: "Test",
    last_name: `User${i}`,
    created_at: 1700000000000,
    primary_email_address_id: `email_${i}`,
    email_addresses: [
      { id: `email_${i}`, email_address: `user${i}@example.com`, verification: { status: "verified" } },
    ],
  }));
}

describe("syncClerkUsersToAnnouncementAudience time budget", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      RESEND_API_KEY: "re_test",
      CLERK_SECRET_KEY: "sk_test",
    };
    // The per-recipient sleep is real setTimeout; make it resolve instantly so
    // the test's wall-clock is driven purely by the injected `now` clock, not by
    // actual elapsed time.
    jest.useFakeTimers();
    // Each recipient is treated as already-existing (update path), no prune
    // candidates by default.
    contactsGet.mockResolvedValue({ data: { id: "c_1", email: "x", unsubscribed: false }, error: null });
    contactsUpdate.mockResolvedValue({ data: {}, error: null });
    contactsCreate.mockResolvedValue({ data: { id: "c_new" }, error: null });
    segmentsAdd.mockResolvedValue({ data: {}, error: null });
    contactsList.mockResolvedValue({ data: { data: [], has_more: false }, error: null });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  function stubClerkFetch(users: ReturnType<typeof makeClerkUsers>) {
    // fetchClerkAnnouncementUsers pages by 100; return all in one page (<100) so
    // it stops after a single fetch.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => users,
    }) as unknown as typeof fetch;
  }

  it("processes the whole audience and prunes when there is no budget pressure", async () => {
    const users = makeClerkUsers(3);
    stubClerkFetch(users);

    // Clock never advances past any deadline; with a generous budget every
    // recipient is processed and prune runs.
    const t = 0;
    const promise = syncClerkUsersToAnnouncementAudience({
      timeBudgetMs: 1_000_000,
      now: () => t,
    });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.recipients).toBe(3);
    expect(result.recipientsProcessed).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(contactsUpdate).toHaveBeenCalledTimes(3);
  });

  it("stops the recipient loop cleanly and reports timedOut when the budget is exhausted", async () => {
    const users = makeClerkUsers(50);
    stubClerkFetch(users);

    // Advance the injected clock by 100ms on every read. With a 250ms budget the
    // loop should stop after ~2 recipients instead of running all 50.
    let t = 0;
    const now = () => {
      t += 100;
      return t;
    };

    const promise = syncClerkUsersToAnnouncementAudience({
      timeBudgetMs: 250,
      now,
    });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.timedOut).toBe(true);
    // Far fewer than the full 50 were processed — the budget truncated the run.
    expect(result.recipientsProcessed).toBeLessThan(50);
    expect(result.recipientsProcessed).toBeGreaterThan(0);
    // Prune is skipped entirely when recipients already exhausted the budget, so
    // we never started removing contacts.
    expect(contactsRemove).not.toHaveBeenCalled();
  });

  it("does not bound the run when no budget is supplied (legacy behavior)", async () => {
    const users = makeClerkUsers(4);
    stubClerkFetch(users);

    const promise = syncClerkUsersToAnnouncementAudience();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.recipientsProcessed).toBe(4);
    expect(result.timedOut).toBe(false);
  });
});
