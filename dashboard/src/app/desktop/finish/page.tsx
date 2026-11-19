import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { desktopBrowserSignInEnabled } from "@/lib/desktop/browser-sign-in";
import FinishSignIn from "./FinishSignIn";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Signing you in",
  robots: { index: false, follow: false },
};

/** Loaded by the desktop app in its own web view with a one-time ticket. */
export default async function DesktopFinishPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!desktopBrowserSignInEnabled()) notFound();
  const { ticket } = await searchParams;
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 4096) notFound();
  return <FinishSignIn ticket={ticket} />;
}
