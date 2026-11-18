import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  createHandoffCode,
  desktopBrowserSignInEnabled,
  desktopCallbackUrl,
  handoffSecret,
  isValidChallenge,
  isValidState,
} from "@/lib/desktop/browser-sign-in";
import ReturnToApp from "./ReturnToApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in to the Hivra app",
  robots: { index: false, follow: false },
};

/**
 * Opened by the desktop app in the person's browser. Signs them in on the
 * website as usual, then hands the session back to the app through hivra://.
 * See lib/desktop/browser-sign-in.ts for the whole flow.
 */
export default async function DesktopSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!desktopBrowserSignInEnabled()) notFound();
  const params = await searchParams;
  const challenge = params.challenge;
  const state = params.state;
  const intent = params.intent === "sign-up" ? "sign-up" : "sign-in";
  if (!isValidChallenge(challenge) || !isValidState(state)) notFound();

  const { userId } = await auth();
  if (!userId) {
    const back = `/desktop/sign-in?${new URLSearchParams({ challenge, state }).toString()}`;
    redirect(`/${intent}?${new URLSearchParams({ redirect_url: back }).toString()}`);
  }

  const secret = handoffSecret();
  if (!secret) notFound();
  const code = createHandoffCode({ userId, challenge, secret });
  return <ReturnToApp href={desktopCallbackUrl(code, state)} />;
}
