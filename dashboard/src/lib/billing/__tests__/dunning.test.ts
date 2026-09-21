/**
 * Dunning trigger/skip/dedupe tests (lib/billing/dunning.ts). Locks in:
 *   - flag-gated (HERMES_DUNNING_EMAIL_ENABLED, default OFF)
 *   - sends once per failed invoice, ledger-keyed on the invoice id
 *   - attempt 1 is silent (Smart Retries get one shot before we email)
 *   - webhook redeliveries dedupe via the lifecycle_email_sends ledger
 *   - an invoice paid between event and send is never dunned
 *   - non-card (send_invoice) invoices are skipped
 *   - a failed send leaves no ledger row (next attempt retries);
 *     a failed ledger write after an accepted send still counts as sent
 */

import type Stripe from "stripe";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockInvoicesRetrieve = jest.fn();
jest.mock("@/lib/stripe", () => ({
  getStripe: () => ({ invoices: { retrieve: mockInvoicesRetrieve } }),
}));

jest.mock("@/lib/email/payment-failed-recovery", () => {
  const actual = jest.requireActual("@/lib/email/payment-failed-recovery");
  return { ...actual, sendPaymentFailedRecoveryEmail: jest.fn() };
});

// Mutable results the chainable supabase mock reads at call time.
let mockLedgerSelectResult: { data: unknown; error: { message?: string } | null };
let mockUpsertResult: { error: { message?: string } | null };
const mockUpsertCalls: Array<{ table: string; payload: unknown; options: unknown }> = [];
const mockFrom = jest.fn((table: string) => ({
  select: jest.fn(() => ({
    eq: jest.fn(() => ({
      eq: jest.fn(() => ({
        maybeSingle: jest.fn(async () => mockLedgerSelectResult),
      })),
    })),
  })),
  upsert: jest.fn(async (payload: unknown, options: unknown) => {
    mockUpsertCalls.push({ table, payload, options });
    return mockUpsertResult;
  }),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: mockFrom },
}));

import {
  isDunningEmailEnabled,
  maybeSendPaymentFailedRecoveryEmail,
} from "@/lib/billing/dunning";
import { sendPaymentFailedRecoveryEmail } from "@/lib/email/payment-failed-recovery";

const mockSend = sendPaymentFailedRecoveryEmail as jest.Mock;

function invoiceFixture(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: "in_123",
    collection_method: "charge_automatically",
    attempt_count: 2,
    customer_email: "payer@example.com",
    customer_name: "john smith",
    hosted_invoice_url: "https://invoice.stripe.com/i/pay_in_123",
    status: "open",
    ...overrides,
  } as unknown as Stripe.Invoice;
}

const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  process.env.HERMES_DUNNING_EMAIL_ENABLED = "true";
  mockLedgerSelectResult = { data: null, error: null };
  mockUpsertResult = { error: null };
  mockUpsertCalls.length = 0;
  mockInvoicesRetrieve.mockResolvedValue(invoiceFixture());
  mockSend.mockResolvedValue({ sent: true, messageId: "re_1" });
});

afterEach(() => {
  process.env = originalEnv;
});

describe("isDunningEmailEnabled", () => {
  it("defaults OFF and only turns on for 'true'", () => {
    delete process.env.HERMES_DUNNING_EMAIL_ENABLED;
    expect(isDunningEmailEnabled()).toBe(false);
    process.env.HERMES_DUNNING_EMAIL_ENABLED = "false";
    expect(isDunningEmailEnabled()).toBe(false);
    process.env.HERMES_DUNNING_EMAIL_ENABLED = " TRUE ";
    expect(isDunningEmailEnabled()).toBe(true);
  });
});

describe("maybeSendPaymentFailedRecoveryEmail", () => {
  it("does nothing while the flag is unset (default OFF)", async () => {
    delete process.env.HERMES_DUNNING_EMAIL_ENABLED;
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture(),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: false, reason: "disabled" });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends once for a retried failed invoice and records the invoice-keyed ledger row", async () => {
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture(),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      email: "payer@example.com",
      firstName: "John",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/pay_in_123",
      idempotencyKey: "payment_failed_recovery_in_123",
    });
    expect(mockUpsertCalls).toEqual([
      {
        table: "lifecycle_email_sends",
        payload: { user_id: "user_1", email_key: "payment_failed_recovery_in_123" },
        options: { onConflict: "user_id,email_key", ignoreDuplicates: true },
      },
    ]);
  });

  it("prefers the freshly fetched invoice's recipient/url over the (possibly stale) event payload", async () => {
    mockInvoicesRetrieve.mockResolvedValue(
      invoiceFixture({
        customer_email: "updated@example.com",
        customer_name: "priya raman",
        hosted_invoice_url: "https://invoice.stripe.com/i/pay_in_123_fresh",
      })
    );
    await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture({ customer_email: null, customer_name: null }),
      userId: "user_1",
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "updated@example.com",
        firstName: "Priya",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/pay_in_123_fresh",
      })
    );
  });

  it("greets 'there' when Stripe has no customer name", async () => {
    mockInvoicesRetrieve.mockResolvedValue(invoiceFixture({ customer_name: null }));
    await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture({ customer_name: null }),
      userId: "user_1",
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "there" })
    );
  });

  it("stays silent on the first failed attempt so Smart Retries get one shot", async () => {
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture({ attempt_count: 1 }),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: false, reason: "first_attempt" });
    expect(mockInvoicesRetrieve).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpsertCalls).toHaveLength(0);
  });

  it("dedupes a webhook redelivery (and later attempts) via the ledger", async () => {
    mockLedgerSelectResult = { data: { id: "ledger-row" }, error: null };
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture({ attempt_count: 3 }),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: false, reason: "already_sent" });
    expect(mockInvoicesRetrieve).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpsertCalls).toHaveLength(0);
  });

  it("never dunns an invoice that got paid between the event and the send", async () => {
    mockInvoicesRetrieve.mockResolvedValue(invoiceFixture({ status: "paid" }));
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture(),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: false, reason: "invoice_not_open" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpsertCalls).toHaveLength(0);
  });

  it("skips non-card (send_invoice) invoices", async () => {
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture({ collection_method: "send_invoice" }),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: false, reason: "not_charge_automatically" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("fails closed when the ledger can't be read", async () => {
    mockLedgerSelectResult = { data: null, error: { message: "db down" } };
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture(),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: false, reason: "ledger_check_failed" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("leaves no ledger row on a failed send so the next attempt retries", async () => {
    mockSend.mockResolvedValue({ sent: false, reason: "send_failed" });
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture(),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: false, reason: "send_failed" });
    expect(mockUpsertCalls).toHaveLength(0);
  });

  it("still reports sent when the ledger write fails after Resend accepts (idempotencyKey backstop)", async () => {
    mockUpsertResult = { error: { message: "insert failed" } };
    const outcome = await maybeSendPaymentFailedRecoveryEmail({
      invoice: invoiceFixture(),
      userId: "user_1",
    });
    expect(outcome).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
