/**
 * The switch for the public status page: NEXT_PUBLIC_HIVRA_STATUS_PAGE.
 * OFF (unset, anything but 1/true) is the default.
 */
export const STATUS_PAGE_ENV = "NEXT_PUBLIC_HIVRA_STATUS_PAGE";

export function statusPageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[STATUS_PAGE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
