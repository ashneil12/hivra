/**
 * Rules for where Hivra-held funds may be withdrawn to.
 *
 * Every withdrawal Hivra sends goes to a destination the account saved
 * beforehand: the lock wallet's withdraw address, an agent wallet's
 * withdrawal destination, or (for a lock-wallet move) the wallet the account
 * verified by signature. Without these rules, anyone who got into an account
 * could point a destination at their own address and empty every wallet in
 * the same minute. With them:
 *
 *   1. Changing a destination needs a fresh sign-in check (Clerk
 *      reverification, WITHDRAW_DESTINATION_REVERIFICATION).
 *   2. The account owner is emailed whenever a destination changes.
 *   3. A destination cannot receive anything until
 *      WITHDRAW_DESTINATION_COOLDOWN_MS after it was set, which gives the
 *      owner time to see that email and act.
 *
 * This module is pure (no server imports) so the dashboard can show the same
 * cooldown the server enforces.
 */

/**
 * How long a newly set withdrawal destination waits before it can receive
 * funds. OWNER DECISION: 24 hours is the conservative default; the security
 * review suggested 24 to 48 hours. It applies to a first destination too,
 * because an account that never set one is otherwise the easiest to empty.
 */
export const WITHDRAW_DESTINATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Clerk reverification level required to change a destination. "strict" asks
 * for a second factor verified in the last 10 minutes, or the first factor
 * when the account has no second factor. OWNER DECISION.
 */
export const WITHDRAW_DESTINATION_REVERIFICATION = "strict" as const;

export function withdrawDestinationCooldownHours(): number {
  return Math.round(WITHDRAW_DESTINATION_COOLDOWN_MS / (60 * 60 * 1000));
}

function parseTime(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** When a destination set at `setAt` can first receive funds. */
export function withdrawDestinationAvailableAt(setAt: string | Date): Date;
export function withdrawDestinationAvailableAt(setAt: string | Date | null | undefined): Date | null;
export function withdrawDestinationAvailableAt(setAt: string | Date | null | undefined): Date | null {
  const time = parseTime(setAt);
  return time === null ? null : new Date(time + WITHDRAW_DESTINATION_COOLDOWN_MS);
}

/**
 * The time a destination set at `setAt` stops being held, or null when it is
 * not held at `now`. A destination with no recorded set time was saved before
 * these rules and is not held.
 */
export function withdrawDestinationHeldUntil(
  setAt: string | Date | null | undefined,
  now: Date = new Date()
): Date | null {
  const availableAt = withdrawDestinationAvailableAt(setAt);
  return availableAt && availableAt.getTime() > now.getTime() ? availableAt : null;
}

/** The message shown when a withdrawal is refused because its destination is held. */
export function withdrawDestinationHeldMessage(
  availableAt: Date,
  subject = "This withdrawal destination",
  verb = "saved"
): string {
  return (
    `${subject} was ${verb} less than ${withdrawDestinationCooldownHours()} hours ago. ` +
    `For your safety it can receive withdrawals from ${availableAt.toUTCString()}.`
  );
}
