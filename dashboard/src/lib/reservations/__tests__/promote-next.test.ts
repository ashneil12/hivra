/**
 * Tests for the waitlist promotion gating. The destructive/DB paths are
 * exercised in integration; here we lock down the env gating + the
 * dark-ship no-op behavior so the cap/invite machinery can never fire unless
 * explicitly enabled.
 */

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/email/reservation-invite", () => ({ sendReservationInvite: jest.fn() }));
jest.mock("@/lib/email/reservation-confirmation", () => ({ sendReservationConfirmation: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  claimWindowHours,
  enqueueWaitlist,
  isAutoInviteEnabled,
  maxFreeInstances,
  promoteNext,
} from "../promote-next";
import { sendReservationConfirmation } from "@/lib/email/reservation-confirmation";
import { sendReservationInvite } from "@/lib/email/reservation-invite";

describe("promote-next env gating", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("isAutoInviteEnabled is true only for the literal 'true'", () => {
    process.env.RESERVATION_AUTO_INVITE_ENABLED = "true";
    expect(isAutoInviteEnabled()).toBe(true);
    process.env.RESERVATION_AUTO_INVITE_ENABLED = "1";
    expect(isAutoInviteEnabled()).toBe(false);
    process.env.RESERVATION_AUTO_INVITE_ENABLED = "false";
    expect(isAutoInviteEnabled()).toBe(false);
    delete process.env.RESERVATION_AUTO_INVITE_ENABLED;
    expect(isAutoInviteEnabled()).toBe(false);
  });

  it("maxFreeInstances parses the cap, defaults to 0 (disabled)", () => {
    delete process.env.MAX_FREE_INSTANCES;
    expect(maxFreeInstances()).toBe(0);
    process.env.MAX_FREE_INSTANCES = "150";
    expect(maxFreeInstances()).toBe(150);
    process.env.MAX_FREE_INSTANCES = "garbage";
    expect(maxFreeInstances()).toBe(0);
  });

  it("claimWindowHours defaults to 48 and rejects non-positive", () => {
    delete process.env.CLAIM_WINDOW_HOURS;
    expect(claimWindowHours()).toBe(48);
    process.env.CLAIM_WINDOW_HOURS = "24";
    expect(claimWindowHours()).toBe(24);
    process.env.CLAIM_WINDOW_HOURS = "0";
    expect(claimWindowHours()).toBe(48);
  });

  it("promoteNext is a no-op (sends nothing) when the feature flag is off", async () => {
    process.env.RESERVATION_AUTO_INVITE_ENABLED = "false";
    process.env.MAX_FREE_INSTANCES = "150";
    const result = await promoteNext();
    expect(result.enabled).toBe(false);
    expect(result.promoted).toBe(0);
    expect(sendReservationInvite).not.toHaveBeenCalled();
  });

  it("promoteNext is a no-op when no cap is configured even if enabled", async () => {
    process.env.RESERVATION_AUTO_INVITE_ENABLED = "true";
    delete process.env.MAX_FREE_INSTANCES;
    const result = await promoteNext();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("no_cap");
    expect(sendReservationInvite).not.toHaveBeenCalled();
  });

  it("enqueueWaitlist no-ops (no row, no confirmation) on empty email", async () => {
    const result = await enqueueWaitlist("", null);
    expect(result.position).toBeNull();
    expect(result.alreadyQueued).toBe(false);
    expect(sendReservationConfirmation).not.toHaveBeenCalled();
  });
});
