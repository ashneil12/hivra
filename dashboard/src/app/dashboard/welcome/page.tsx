/**
 * /dashboard/welcome — kept so older links, emails and bookmarks still land.
 *
 * It used to be a first-run launcher of its own. Launch is now the one place
 * to start an agent or a computer: a new account turns the Free plan on
 * there, checkout returns there, and templates start there. This route only
 * maps the old link's intent onto Launch (see welcomeRedirect).
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

import { welcomeRedirect } from "@/lib/launch/welcome-redirect";

export const metadata: Metadata = {
  title: "Launch",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  redirect(welcomeRedirect(query));
}
