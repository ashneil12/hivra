import { redirect } from "next/navigation";

/**
 * The workspace route forwards to the landing page, preserving its query.
 *
 * The interaction area moved to `/dashboard` because that is the right address
 * for it, but this route's URL contract has to survive: roughly fifteen href
 * producers, the PWA manifest and every existing bookmark point here with
 * `?agent=<x-uid>&surface=<token>`. Rewriting those would be a large, risky
 * sweep for no user-visible gain, and any one missed link strands a user.
 *
 * So this forwards the *whole* query string and lets `/dashboard` do the work —
 * one implementation of the `?agent=&surface=` resolution (`WorkspaceView`),
 * reached by two addresses.
 *
 * A bare `/dashboard/workspace` therefore lands on the landing page, which is
 * where it used to send people anyway.
 */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0]) query.set(key, value[0]);
  }

  const search = query.toString();
  redirect(search ? `/dashboard?${search}` : "/dashboard");
}
