/**
 * The reservation email lookups must treat the email as a literal, never a
 * pattern. The fake table follows PostgreSQL LIKE (and PostgREST's `*` alias
 * for `%`), so a lookup that still passed the email through ilike unescaped
 * would match the wrong row here, the way it did in production.
 */

import type { ReservationsFake } from "@/test-utils/reservations-fake";

let mockFake: ReservationsFake;

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockFake.admin;
  },
}));
jest.mock("@/lib/email/reservation-invite", () => ({ sendReservationInvite: jest.fn() }));
jest.mock("@/lib/email/reservation-confirmation", () => ({
  sendReservationConfirmation: jest.fn(async () => ({ ok: true })),
}));
jest.mock("@/lib/logger", () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { createReservationsFake } from "@/test-utils/reservations-fake";
import { supabaseAdmin } from "@/lib/supabase";
import {
  enqueueWaitlist,
  markReservationOnboardedByEmail,
} from "@/lib/reservations/promote-next";
import {
  escapeLikeLiteral,
  findReservationByEmail,
  normalizeReservationEmail,
} from "@/lib/reservations/email-lookup";

const alice = { id: "alice", email: "alice@gmail.com", position: 1, status: "queued", tier_intent: "free", clerk_user_id: null };
const bob = { id: "bob", email: "bob@gmail.com", position: 2, status: "queued", tier_intent: "pro", clerk_user_id: null };
const dotted = { id: "dotted", email: "john.smith@yahoo.com", position: 3, status: "invited", tier_intent: "free", clerk_user_id: null };

function client() {
  return supabaseAdmin as NonNullable<typeof supabaseAdmin>;
}

describe("normalizeReservationEmail and escapeLikeLiteral", () => {
  it("trims and lower-cases", () => {
    expect(normalizeReservationEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("escapes backslash, percent and underscore, and nothing else", () => {
    expect(escapeLikeLiteral("a_b%c\\d@x.com")).toBe("a\\_b\\%c\\\\d@x.com");
  });
});

describe("findReservationByEmail", () => {
  beforeEach(() => {
    mockFake = createReservationsFake([alice, bob, dotted]);
  });

  it("finds a row by its exact email, whatever the case of the query", async () => {
    const result = await findReservationByEmail<{ id: string }>(client(), " Alice@GMAIL.com ", "id");
    expect(result.data).toEqual({ id: "alice" });
    expect(mockFake.emailEqValues).toEqual(["alice@gmail.com"]);
  });

  it.each([
    ["percent suffix", "a%@gmail.com"],
    ["bare percent", "%@gmail.com"],
    ["percent domain", "%@%.com"],
    ["underscore for a letter", "a_ice@gmail.com"],
    ["all underscores", "_____@gmail.com"],
    ["star alias", "a*@gmail.com"],
    ["backslash", "alice\\@gmail.com"],
  ])("matches nothing for a pattern email (%s)", async (_label, email) => {
    const result = await findReservationByEmail<{ id: string }>(client(), email, "id");
    expect(result.error).toBeNull();
    expect(result.data).toBeNull();
  });

  it("does not let an underscore in the email match a different character", async () => {
    const result = await findReservationByEmail<{ id: string }>(client(), "john_smith@yahoo.com", "id");
    expect(result.data).toBeNull();
  });

  it("still finds a row whose own email has an underscore", async () => {
    mockFake.rows.push({ id: "under", email: "john_smith@yahoo.com", position: 4, status: "queued" });
    const result = await findReservationByEmail<{ id: string }>(client(), "John_Smith@yahoo.com", "id");
    expect(result.data).toEqual({ id: "under" });
  });

  it("finds a row stored with mixed case before every writer lower-cased, without treating the email as a pattern", async () => {
    mockFake.rows.push({ id: "legacy", email: "Carol_Jones@Example.com", position: 5, status: "queued" });
    // With the underscore taken as a wildcard this second row would match too,
    // and the lookup would fail with "multiple rows".
    mockFake.rows.push({ id: "other", email: "CarolXJones@example.com", position: 6, status: "queued" });

    const found = await findReservationByEmail<{ id: string }>(client(), "carol_jones@example.com", "id");

    expect(found.error).toBeNull();
    expect(found.data).toEqual({ id: "legacy" });
    expect(mockFake.ilikePatterns).toEqual(["carol\\_jones@example.com"]);
  });

  it("never uses ilike for an email containing a star, which PostgREST cannot escape", async () => {
    mockFake.rows.push({ id: "star", email: "Star*Person@example.com", position: 7, status: "queued" });
    const result = await findReservationByEmail<{ id: string }>(client(), "star*person@example.com", "id");
    expect(mockFake.ilikePatterns).toEqual([]);
    expect(result.data).toBeNull();
  });
});

describe("enqueueWaitlist", () => {
  beforeEach(() => {
    mockFake = createReservationsFake([alice, bob, dotted]);
  });

  it("does not hand back another person's queue position for a pattern email, and does not link the caller to their row", async () => {
    const result = await enqueueWaitlist("a%@gmail.com", "user_attacker");

    expect(result.alreadyQueued).toBe(false);
    expect(mockFake.rows.find((row) => row.id === "alice")?.clerk_user_id).toBeNull();
    // A pattern is stored as the literal text it is, never as a match for alice.
    expect(mockFake.rows.some((row) => row.email === "a%@gmail.com")).toBe(true);
  });

  it("stores the email trimmed and lower-cased", async () => {
    await enqueueWaitlist("  New.Person@Example.COM ", null);
    expect(mockFake.rows.some((row) => row.email === "new.person@example.com")).toBe(true);
    expect(mockFake.rows.some((row) => row.email === "  New.Person@Example.COM ")).toBe(false);
  });

  it("finds an existing row whatever the case of the email", async () => {
    const result = await enqueueWaitlist("ALICE@gmail.com", "user_alice");
    expect(result).toEqual({ position: 1, alreadyQueued: true });
    expect(mockFake.rows.find((row) => row.id === "alice")?.clerk_user_id).toBe("user_alice");
  });

  it("re-reads a legacy mixed-case row after the unique index refuses the insert", async () => {
    mockFake.rows.push({ id: "legacy", email: "Dana@Example.com", position: 9, status: "queued" });
    const result = await enqueueWaitlist("dana@example.com", null);
    expect(result).toEqual({ position: 9, alreadyQueued: true });
    expect(mockFake.rows.filter((row) => row.email.toLowerCase() === "dana@example.com")).toHaveLength(1);
  });
});

describe("markReservationOnboardedByEmail", () => {
  beforeEach(() => {
    mockFake = createReservationsFake([alice, bob, dotted]);
  });

  it("marks only the row for that exact email", async () => {
    await markReservationOnboardedByEmail("Alice@gmail.com");
    expect(mockFake.rows.find((row) => row.id === "alice")?.status).toBe("onboarded");
    expect(mockFake.rows.find((row) => row.id === "bob")?.status).toBe("queued");
    expect(mockFake.rows.find((row) => row.id === "dotted")?.status).toBe("invited");
  });

  it.each(["%@gmail.com", "a%@gmail.com", "john_smith@yahoo.com", "%", "*@gmail.com"])(
    "does not touch anyone's row for the pattern email %s",
    async (email) => {
      await markReservationOnboardedByEmail(email);
      expect(mockFake.rows.map((row) => row.status)).toEqual(["queued", "queued", "invited"]);
    },
  );

  it("leaves a row that is already onboarded alone", async () => {
    mockFake.rows.push({ id: "done", email: "done@example.com", position: 8, status: "onboarded", notes: { keep: true } });
    await markReservationOnboardedByEmail("done@example.com");
    expect(mockFake.rows.find((row) => row.id === "done")?.notes).toEqual({ keep: true });
  });
});
