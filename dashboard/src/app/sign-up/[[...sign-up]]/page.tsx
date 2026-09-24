import { SignUp } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FunnelHeader } from "@/components/layout/LandingHeader";
import { authCardAppearance } from "@/components/auth/auth-card-appearance";
import funnelStyles from "@/components/public-site/public-site.module.css";
import { buildAgentLaunchHref } from "@/lib/hivra/launch-navigation";
import { isLocalAuthMode } from "@/lib/self-host/config";

// Paid sign-ups start on /get-started, which carries the plan through
// checkout. Internal keys (operator/fleet) match the PLANS map.
const PAID_SIGNUP_PLANS = new Set(["operator", "fleet"]);

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  if (isLocalAuthMode()) {
    redirect("/sign-in");
    return null;
  }

  const resolvedParams = await searchParams;
  const rawPlan = typeof resolvedParams?.plan === "string" ? resolvedParams.plan : undefined;
  const plan = rawPlan && PAID_SIGNUP_PLANS.has(rawPlan) ? rawPlan : undefined;

  if (plan) {
    redirect(`/get-started?plan=${plan}`);
  }

  // A new account goes straight to Launch, where the Free plan is turned on
  // with its own button, and only for a launch on Hivra Cloud. Every agent and
  // computer is on offer there, and an agent a link asked for opens its plan.
  // The older reservation links (from=reserve) land here the same way.
  const agentType = typeof resolvedParams?.agentType === "string" ? resolvedParams.agentType : null;
  const redirectUrl = buildAgentLaunchHref(agentType);

  // Public "start" links come here whether or not the visitor has an account;
  // one who is already signed in goes on to Launch.
  const { userId } = await auth();
  if (userId) {
    redirect(redirectUrl);
  }

  return (
    <>
      <FunnelHeader homeHref={isLocalAuthMode() ? undefined : "/"} />
      <div className={funnelStyles.funnelPage} style={{
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        position: "relative"
      }}>
        <div style={{ position: "relative", zIndex: 10, width: "100%", maxWidth: "420px" }}>
          <SignUp
            fallbackRedirectUrl={redirectUrl}
            appearance={authCardAppearance({
              headerTitle: "serif text-[2.2rem] font-normal text-[var(--ink-black)] leading-none mb-2",
            })}
          />
          <div className="mt-8 px-6 flex flex-col items-center justify-center w-full text-center text-[var(--text-muted)] font-mono text-[10px] leading-loose uppercase tracking-wider">
            <span>By continuing, you agree to our</span>
            <div className="mt-1 flex items-center justify-center gap-2">
              <Link href="/terms" className="underline hover:text-[var(--ink-black)] transition-colors">Terms of Service</Link>
              <span>and</span>
              <Link href="/privacy" className="underline hover:text-[var(--ink-black)] transition-colors">Privacy Policy</Link>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
