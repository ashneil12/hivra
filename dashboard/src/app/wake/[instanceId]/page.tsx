// Gateway auto-wake Phase 1: public wake page.
//
// This is the URL a parked box's Caddy 502 fallback redirects browsers to
// (https://<dashboard>/wake/<instanceId>) and the landing target for
// reactivation emails. It must work for BOTH:
//
//   - signed-out visitors: show an honest "this agent is asleep" card with a
//     sign-in CTA that returns here afterwards. No instance details are
//     fetched or leaked pre-auth — the page confirms nothing about whether
//     the id exists.
//   - the signed-in owner: hand off to the WakeFlow client component, which
//     triggers the admission-guarded start and polls until the box answers,
//     then redirects back to the box URL.
//
// Deliberately NOT under /dashboard so the middleware doesn't force-redirect
// anonymous visitors away before they can see what's happening.

import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import type { Metadata } from "next";

import WakeFlow from "./WakeFlow";

export const metadata: Metadata = {
  title: "Waking your agent",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

// Keep the id shape conservative: uuids and similar slugs. Anything else gets
// the generic invalid-link card rather than being echoed into API calls.
const INSTANCE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function WakePageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-[var(--ink-black)]/10 bg-[var(--vellum-bg)] p-8 shadow-sm">
        {children}
      </div>
    </main>
  );
}

export default async function WakePage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;
  const safeId = INSTANCE_ID_SHAPE.test(instanceId) ? instanceId : null;

  if (!safeId) {
    return (
      <WakePageShell>
        <h1 className="font-[family-name:var(--font-grotesk)] text-2xl font-medium">
          That link doesn&apos;t look right
        </h1>
        <p className="mt-3 text-sm opacity-80">
          This wake link is malformed. Open your dashboard to find your agent
          instead.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-lg bg-[#ff3a3b] px-4 py-2 text-sm font-medium text-white"
        >
          Go to dashboard
        </Link>
      </WakePageShell>
    );
  }

  const { userId } = await auth();

  if (!userId) {
    const signInHref = `/sign-in?redirect_url=${encodeURIComponent(`/wake/${safeId}`)}`;
    return (
      <WakePageShell>
        <h1 className="font-[family-name:var(--font-grotesk)] text-2xl font-medium">
          This agent is asleep
        </h1>
        <p className="mt-3 text-sm opacity-80">
          Agents that haven&apos;t been used for a while are parked to save
          resources. Waking one back up takes about 70 seconds.
        </p>
        <p className="mt-2 text-sm opacity-80">
          Sign in to wake it — you&apos;ll be sent straight back to your agent
          once it&apos;s up.
        </p>
        <Link
          href={signInHref}
          className="mt-6 inline-block rounded-lg bg-[#ff3a3b] px-4 py-2 text-sm font-medium text-white"
        >
          Sign in to wake it
        </Link>
      </WakePageShell>
    );
  }

  return (
    <WakePageShell>
      <WakeFlow instanceId={safeId} />
    </WakePageShell>
  );
}
