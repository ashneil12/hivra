import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { FunnelHeader } from "@/components/layout/LandingHeader";
import funnelStyles from "@/components/public-site/public-site.module.css";
import { PLANS, type PlanKey } from "@/lib/subscription";
import { isLocalAuthMode } from "@/lib/self-host/config";
import { buildAgentLaunchHref, launchProfileForAgentType } from "@/lib/hivra/launch-navigation";
import { buildAgentTypeQuery, resolveWelcomeAgentTypeKey } from "@/lib/welcome-agent-catalog";

function safeInternalRedirect(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : undefined;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const resolvedParams = await searchParams;
  const planParam = typeof resolvedParams?.plan === "string" ? resolvedParams.plan : undefined;
  const plan = planParam && planParam in PLANS ? (planParam as PlanKey) : undefined;
  const agentTypeParam = typeof resolvedParams?.agentType === "string" ? resolvedParams.agentType : undefined;
  const agentTypeQuery = buildAgentTypeQuery(resolveWelcomeAgentTypeKey(agentTypeParam));
  const requestedRedirect = safeInternalRedirect(resolvedParams?.redirect_url);
  // An agent a link asked for opens its plan in Launch. Otherwise Home: it
  // lists a returning owner's agents and computers, and offers Launch to an
  // account that has none yet.
  const agentLaunch = !plan && launchProfileForAgentType(agentTypeParam) ? buildAgentLaunchHref(agentTypeParam) : undefined;
  const redirectUrl = plan
    ? `/get-started/activate?plan=${plan}${agentTypeQuery}`
    : requestedRedirect ?? agentLaunch ?? "/dashboard";
  const signUpUrl = plan
    ? `/get-started?plan=${plan}${agentTypeQuery}`
    : agentLaunch ? `/sign-up?agentType=${encodeURIComponent(agentTypeParam ?? "")}` : "/sign-up";

  return (
    <>
      <FunnelHeader homeHref={isLocalAuthMode() ? undefined : "/"} />
      <div className={`flex flex-col items-center justify-center w-full relative p-4 md:p-8 ${funnelStyles.funnelPage}`}>
        <div className="relative z-10 flex flex-col items-center w-full max-w-md">
          <SignIn
            {...(plan || requestedRedirect || agentLaunch ? { forceRedirectUrl: redirectUrl } : {})}
            fallbackRedirectUrl={redirectUrl}
            signUpUrl={signUpUrl}
            appearance={{
              elements: {
                rootBox: "w-full",
                cardBox: "w-full max-w-full",
                card: "rounded-none border border-[var(--etched-border)] shadow-[0_24px_80px_rgba(0,0,0,0.08)] bg-white/95 backdrop-blur-xl p-8 pb-10",
                headerTitle: "serif text-[2.5rem] font-light text-[var(--ink-black)] leading-none mb-2 text-center",
                headerSubtitle: "mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)] mt-0 text-center",
                formButtonPrimary: "rounded-none bg-[var(--ink-black)] text-white hover:bg-black font-mono uppercase tracking-[0.15em] text-[11px] font-bold py-3.5 transition-all mt-2 text-center flex justify-center",
                formFieldInput: "rounded-none border-[var(--etched-border)] focus:border-[var(--ink-black)] focus:ring-1 focus:ring-[var(--ink-black)] text-sm py-2.5 bg-transparent",
                formFieldLabel: "mono text-[9px] uppercase tracking-[0.15em] font-bold text-[var(--text-secondary)] mb-1.5",
                footerActionLink: "text-[var(--gold-leaf)] hover:text-[var(--ink-black)] font-bold transition-colors",
                identityPreview: "rounded-none border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-4 py-3",
                identityPreviewEditButton: "text-[var(--gold-leaf)] hover:text-[var(--ink-black)] transition-colors",
                dividerLine: "bg-[var(--etched-border)]",
                dividerText: "mono text-[9px] uppercase tracking-[0.15em] text-[var(--text-muted)] bg-transparent",
                socialButtonsBlockButton: "rounded-none border border-[var(--etched-border)] hover:bg-[var(--bg-elevated)] hover:border-[var(--ink-black)] text-[var(--ink-black)] transition-all flex items-center justify-center",
                socialButtonsBlockButtonText: "mono text-[11px] font-semibold tracking-wider uppercase text-center flex-1",
                footer: "!bg-transparent !bg-none border-none rounded-none mt-2",
                footerActionText: "text-xs text-[var(--text-secondary)]",
                main: "gap-6"
              },
              variables: {
                borderRadius: 0,
                colorPrimary: "var(--ink-black)",
                colorBackground: "transparent",
                colorText: "var(--ink-black)",
                colorInputBackground: "transparent",
                colorInputText: "var(--ink-black)",
                fontFamily: "inherit"
              }
            }}
          />
          <div style={{ marginTop: "3rem", paddingBottom: "3rem" }} className="px-6 flex items-center justify-center w-full gap-6 text-center text-[var(--text-muted)] font-mono text-[10px] uppercase tracking-wider">
            <Link href="/terms" className="underline hover:text-[var(--ink-black)] transition-colors py-2">Terms</Link>
            <span className="opacity-50">•</span>
            <Link href="/privacy" className="underline hover:text-[var(--ink-black)] transition-colors py-2">Privacy</Link>
          </div>
        </div>
      </div>
    </>
  );
}
