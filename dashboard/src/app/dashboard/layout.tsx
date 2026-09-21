import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { auth, currentUser } from "@clerk/nextjs/server";

import { ClientLayoutWrapper } from "@/components/layout/ClientLayoutWrapper";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { PostHogIdentify } from "@/app/providers/PostHogProvider";
import { AuthClerkProvider } from "@/components/auth/AuthClerkProvider";
import { LOCALE_COOKIE_NAME, resolveRequestLocale } from "@/lib/i18n";
import { isOpsAdminUser } from "@/lib/ops-access";

export const metadata: Metadata = {
  title: "Dashboard | Hivra",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  await auth.protect();
  const [user, cookieStore, headerStore] = await Promise.all([currentUser(), cookies(), headers()]);
  const locale = resolveRequestLocale({
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
  const userEmail = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || "";
  const showOpsLink = isOpsAdminUser({
    userId: userId || user?.id || null,
    email: userEmail,
  });

  return (
    <AuthClerkProvider>
      <PostHogIdentify />
      <LocaleProvider initialLocale={locale}>
        <ClientLayoutWrapper
          userName={user?.firstName || "Operator"}
          userEmail={userEmail}
          resourceOwnerKey={userId || user?.id || undefined}
          showOpsLink={showOpsLink}
        >
          {children}
        </ClientLayoutWrapper>
      </LocaleProvider>
    </AuthClerkProvider>
  );
}
