import { isLocalAuthMode, SELF_HOST_USER_ID } from "@/lib/self-host/config";

/** Clerk issues user ids as `user_` followed by base62 characters. */
export const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

/**
 * Whether `userId` is an account id this deployment's identity provider
 * issues: a Clerk user id on the hosted service, or the installation's operator
 * in self-host local auth mode.
 *
 * Every application path writes owner columns such as `hermes_instances.user_id`
 * from one of these, so any other value (for example the UUID `sub` of a
 * Supabase Auth JWT) did not come from the application. Destructive sweeps use
 * this to refuse to act on such a row.
 *
 * It checks where the id came from, not whether the account still exists: a
 * deleted Clerk user's id still passes, because the orphan sweep deliberately
 * schedules those users' instances for purge.
 */
export function isPlatformAccountId(userId: unknown): userId is string {
  if (typeof userId !== "string") return false;
  if (CLERK_USER_ID_PATTERN.test(userId)) return true;
  return isLocalAuthMode() && userId === SELF_HOST_USER_ID;
}
