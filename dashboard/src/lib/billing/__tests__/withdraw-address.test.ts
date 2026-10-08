/**
 * Saving the lock wallet's withdraw address: a new or different address is
 * recorded with the time it was set (the cooldown runs from there) and the
 * account owner is emailed. Saving the same address again changes nothing and
 * sends nothing, so it can never restart the cooldown.
 */
type Row = Record<string, unknown>;

const mockRows: Row[] = [];
const mockUpserts: Row[] = [];
const mockNotify = jest.fn();

jest.mock("@/lib/supabase", () => {
  const byUser = (userId: unknown) => mockRows.find((row) => row.user_id === userId) ?? null;
  return {
    supabaseAdmin: {
      from: () => ({
        select: () => {
          let userId: unknown;
          const query = {
            eq: (_column: string, value: unknown) => {
              userId = value;
              return query;
            },
            maybeSingle: async () => ({ data: byUser(userId), error: null }),
          };
          return query;
        },
        upsert: (row: Row) => {
          mockUpserts.push(row);
          const existing = byUser(row.user_id);
          const stored = existing
            ? Object.assign(existing, row)
            : { set_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
          if (!existing) mockRows.push(stored);
          return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
        },
      }),
    },
  };
});

jest.mock("@/lib/email/withdraw-destination-changed", () => ({
  sendWithdrawDestinationChangedEmail: (...args: unknown[]) => mockNotify(...args),
}));

jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { setUserWithdrawAddress } from "../withdraw-address";

const FIRST = "0x1111111111111111111111111111111111111111";
const SECOND = "0x2222222222222222222222222222222222222222";
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  mockRows.length = 0;
  mockUpserts.length = 0;
  mockNotify.mockReset();
  mockNotify.mockResolvedValue({ sent: true });
});

it("emails the owner and starts the cooldown when an address is first saved", async () => {
  const before = Date.now();
  const result = await setUserWithdrawAddress({ userId: "user_1", address: FIRST, acknowledged: true });

  expect(result.status).toBe("saved");
  expect(mockNotify).toHaveBeenCalledTimes(1);
  const notice = mockNotify.mock.calls[0][0];
  expect(notice).toMatchObject({ userId: "user_1", kind: "lock_wallet", previousAddress: null, newAddress: FIRST });
  expect(notice.availableAt.getTime() - notice.changedAt.getTime()).toBe(24 * HOUR);
  expect(Date.parse(String(mockUpserts[0].set_at))).toBeGreaterThanOrEqual(before);
});

it("emails the owner with the old and new address and restarts the cooldown on a change", async () => {
  mockRows.push({
    user_id: "user_1",
    address: FIRST,
    normalized_address: FIRST,
    network: "base",
    acknowledged_responsibility: true,
    set_at: new Date(Date.now() - 72 * HOUR).toISOString(),
    updated_at: new Date(Date.now() - 72 * HOUR).toISOString(),
  });

  const result = await setUserWithdrawAddress({ userId: "user_1", address: SECOND, acknowledged: true });

  expect(result.status).toBe("saved");
  expect(mockNotify).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "lock_wallet", previousAddress: FIRST, newAddress: SECOND })
  );
  expect(Date.parse(String(mockRows[0].set_at))).toBeGreaterThan(Date.now() - HOUR);
});

it("writes nothing and emails nobody when the same address is saved again", async () => {
  const setAt = new Date(Date.now() - 72 * HOUR).toISOString();
  const lower = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  mockRows.push({
    user_id: "user_1",
    address: lower,
    normalized_address: lower,
    network: "base",
    acknowledged_responsibility: true,
    set_at: setAt,
    updated_at: setAt,
  });

  // The same address in another letter case is the same address.
  const result = await setUserWithdrawAddress({ userId: "user_1", address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", acknowledged: true });

  expect(result.status).toBe("saved");
  expect(mockUpserts).toEqual([]);
  expect(mockNotify).not.toHaveBeenCalled();
  expect(mockRows[0].set_at).toBe(setAt);
});

it("still saves the address when the email cannot be sent", async () => {
  mockNotify.mockResolvedValue({ sent: false, reason: "send_failed", errorMessage: "resend down" });

  const result = await setUserWithdrawAddress({ userId: "user_1", address: FIRST, acknowledged: true });

  expect(result.status).toBe("saved");
  expect(mockRows).toHaveLength(1);
});
