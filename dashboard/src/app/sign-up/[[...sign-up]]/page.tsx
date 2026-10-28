import { SignUp } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FunnelHeader } from "@/components/layout/LandingHeader";
import { authCardAppearance } from "@/components/auth/auth-card-appearance";
import funnelStyles from "@/components/public-site/public-site.module.css";
import { HOSTED_COMPUTE_NEEDS_PLAN } from "@/lib/blog/plan-facts";
import { buildAgentLaunchHref } from "@/lib/hivra/launch-navigation";
import { isLocalAuthMode } from "@/lib/self-host/config";
import styles from "./sign-up.module.css";

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

  // A new account goes straight to Launch. A free account works with a computer
  // or server the person connects; a computer Hivra Cloud runs needs a paid plan
  // (Launch says so before anything starts, and an agent a link asked for opens
  // its plan). The older reservation links (from=reserve) land here the same way.
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
      <main id="main-content" className={funnelStyles.funnelPage} style={{
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        position: "relative"
      }}>
        <div style={{ position: "relative", zIndex: 10, width: "100%", maxWidth: "420px" }}>
          {/* Ash's words for this page (11-reserve.md), then the shared sentence that Hivra runs no free computer
              (21 Oct 2026). /reserve and /reserved are redirects to here. */}
          <div className={styles.intro}>
            <h1>Create your Hivra account.</h1>
            <p>
              Run a supported AI agent on a persistent computer, use a computer without an agent or bring your own
              infrastructure.
            </p>
            <p>{HOSTED_COMPUTE_NEEDS_PLAN}</p>
          </div>
          <SignUp
            fallbackRedirectUrl={redirectUrl}
            appearance={authCardAppearance({
              headerTitle: "serif text-[2.2rem] font-normal text-[var(--ink-black)] leading-none mb-2",
            })}
          />
          <p className={styles.legal}>
            By continuing, you agree to the <Link href="/terms">Terms of Service</Link> and acknowledge the{" "}
            <Link href="/privacy">Privacy Policy</Link>.
          </p>
        </div>
      </main>
    </>
  );
}
