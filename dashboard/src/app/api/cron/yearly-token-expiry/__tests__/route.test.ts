/** @jest-environment node */
/**
 * Route-level regressions for the yearly $HermesOS expiry cron (audit of
 * 2026-09-22, YR-5 and the expiry half of YR-7), run against an in-memory
 * Supabase with the production unique indexes.
 */

import { NextRequest } from "next/server";

import {
  createYearlyTokenMemoryDb,
  yearlySubscriptionRow,
  type YearlyTokenMemoryDb,
} from "@/test-utils/yearly-token-memory-db";

const DAY_MS = 24 * 60 * 60 * 1000;
const mockState: { memory: YearlyTokenMemoryDb | null; client: unknown } = { memory: null, client: null };
const mockSend = jest.fn();

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockState.client ?? mockState.memory?.db ?? null;
  },
}));

jest.mock("@/lib/email/yearly-token-subscription-notifications", () => ({
  sendYearlyTokenSubscriptionNotification: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

import { GET } from "../route";

const originalEnv = { ...process.env };

function cronRequest() {
  return new Request("http://localhost/api/cron/yearly-token-expiry", {
    headers: { authorization: "Bearer cron-secret" },
  }) as unknown as NextRequest;
}

async function runCron() {
  const response = await GET(cronRequest());
  expect(response.status).toBe(200);
  return response;
}

function at(offsetMs: number) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function setup(rows: Array<Record<string, unknown>>) {
  const memory = createYearlyTokenMemoryDb({ yearly_token_subscriptions: rows });
  mockState.memory = memory;
  mockState.client = null;
  return memory;
}

function row(memory: YearlyTokenMemoryDb, id: string) {
  return memory.tables.yearly_token_subscriptions.find((candidate) => candidate.id === id);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
  mockSend.mockResolvedValue({ sent: true });
});

afterAll(() => {
  process.env = originalEnv;
});

describe("YR-5: grace ends on its date, not on email delivery", () => {
  it("expires a grace subscription past its grace window even when the email cannot be sent", async () => {
    const memory = setup([
      yearlySubscriptionRow({ id: "ys_grace", status: "grace", expires_at: at(-8 * DAY_MS) }),
    ]);
    mockSend.mockResolvedValue({ sent: false, reason: "no_email" });

    await runCron();

    expect(row(memory, "ys_grace")).toMatchObject({ status: "expired", expired_email_sent_at: null });
  });

  it("keeps retrying the ended email after the row expired and stamps it once sent", async () => {
    const memory = setup([
      yearlySubscriptionRow({ id: "ys_grace", status: "grace", expires_at: at(-8 * DAY_MS) }),
    ]);
    mockSend.mockResolvedValueOnce({ sent: false, reason: "send_failed" });

    await runCron();
    expect(row(memory, "ys_grace")).toMatchObject({ status: "expired", expired_email_sent_at: null });

    await runCron();
    expect(row(memory, "ys_grace")).toMatchObject({ status: "expired" });
    expect(row(memory, "ys_grace")?.expired_email_sent_at).toEqual(expect.any(String));
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "user_1", tier: "pro", transition: "expired" })
    );
  });
});

describe("YR-7: expiry transitions are compare-and-set", () => {
  it("does not expire (or email) a subscription that was renewed after the candidate read", async () => {
    const renewedStale = yearlySubscriptionRow({ id: "ys_old", status: "grace", expires_at: at(-8 * DAY_MS) });
    const memory = setup([
      { ...renewedStale, status: "renewed" },
      yearlySubscriptionRow({ id: "ys_new", status: "active", expires_at: at(357 * DAY_MS) }),
    ]);
    // Every read sees the pre-renewal snapshot; writes hit the live rows.
    mockState.client = memory.withStaleReads("yearly_token_subscriptions", [renewedStale]);

    await runCron();

    expect(row(memory, "ys_old")).toMatchObject({ status: "renewed" });
    expect(row(memory, "ys_new")).toMatchObject({ status: "active" });
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ transition: "expired" }));
  });

  it("moves an active subscription past its end into grace", async () => {
    const memory = setup([
      yearlySubscriptionRow({ id: "ys_due", status: "active", expires_at: at(-1 * DAY_MS) }),
    ]);

    await runCron();

    expect(row(memory, "ys_due")).toMatchObject({ status: "grace" });
  });
});
