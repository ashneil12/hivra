import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shield, Zap } from "lucide-react";
import { FunnelHeader } from "@/components/layout/LandingHeader";
import funnelStyles from "@/components/public-site/public-site.module.css";
import {
  HACKATHON_PROMO_END_LABEL,
  HACKATHON_PROMO_NAME,
  HACKATHON_PROMO_TRIAL_DAYS,
  isHackathonPromoActive,
} from "@/lib/subscription";
import { isLocalAuthMode } from "@/lib/self-host/config";

// Sign-up plan badges. Internal keys (operator/fleet) match the
// PLANS map; user-facing names (Pro/Power) match the new launch
// pricing. Kept in sync with src/lib/subscription/plans.ts.
const PLAN_META: Record<string, { name: string; price: string; highlight: string }> = {
  operator: { name: "Pro",   price: "$9.99/mo",  highlight: "1 agent · 48-hr refund" },
  fleet:    { name: "Power", price: "$19.99/mo", highlight: "3 agents · 48-hr refund" },
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  if (isLocalAuthMode()) {
    redirect("/sign-in");
    return null;
  }

  const hackathonActive = isHackathonPromoActive();
  const resolvedParams = await searchParams;
  const rawPlan = typeof resolvedParams?.plan === "string" ? resolvedParams.plan : undefined;
  const plan = rawPlan && PLAN_META[rawPlan] ? rawPlan : undefined;
  const fromReserve = resolvedParams?.from === "reserve";

  if (plan) {
    redirect(`/get-started?plan=${plan}`);
  }

  if (fromReserve) {
    redirect("/get-started?plan=free");
  }

  const redirectUrl = plan
    ? `/dashboard/welcome?plan=${plan}`
    : "/dashboard/welcome";
  const planMeta =
    plan && PLAN_META[plan]
      ? {
          ...PLAN_META[plan],
          highlight:
            plan === "operator" && hackathonActive
              ? `${HACKATHON_PROMO_NAME} · ${HACKATHON_PROMO_TRIAL_DAYS} days free before ${HACKATHON_PROMO_END_LABEL}`
              : PLAN_META[plan].highlight,
        }
      : null;

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
          {/* Same three steps as /get-started; a plain sign-up picks its plan after the account. */}
          <div className="font-mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.55, fontWeight: 700, marginBottom: "1rem", textAlign: "center" }}>
            Step 1 of 3 — Create Account
          </div>

          {plan && planMeta && (
            <div style={{
              marginBottom: "1rem",
              padding: "12px 16px",
              border: "1px solid var(--gold-leaf)",
              background: "rgba(255, 44, 45, 0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Zap size={12} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
                <div>
                  <span className="font-mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--ink-black)" }}>
                    {planMeta.name} Plan · {planMeta.price}
                  </span>
                  <div className="font-mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--gold-leaf)", marginTop: 2 }}>
                    {planMeta.highlight}
                  </div>
                </div>
              </div>
              <Shield size={12} style={{ color: "var(--gold-leaf)", opacity: 0.7, flexShrink: 0 }} />
            </div>
          )}

          <SignUp
            fallbackRedirectUrl={redirectUrl}
            appearance={{
              elements: {
                rootBox: "w-full",
                cardBox: "w-full max-w-full",
                card: "rounded-none border border-[var(--etched-border)] shadow-[0_24px_80px_rgba(0,0,0,0.08)] bg-white/95 backdrop-blur-xl p-8 pb-10",
                headerTitle: "serif text-[2.2rem] font-normal text-[var(--ink-black)] leading-none mb-2",
                headerSubtitle: "mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)] mt-0",
                formButtonPrimary: "rounded-none bg-[var(--ink-black)] text-white hover:bg-black font-mono uppercase tracking-[0.15em] text-[11px] font-bold py-3.5 transition-all mt-2",
                formFieldInput: "rounded-none border-[var(--etched-border)] focus:border-[var(--ink-black)] focus:ring-1 focus:ring-[var(--ink-black)] text-sm py-2.5 bg-transparent",
                formFieldLabel: "mono text-[9px] uppercase tracking-[0.15em] font-bold text-[var(--text-secondary)] mb-1.5",
                footerActionLink: "text-[var(--gold-leaf)] hover:text-[var(--ink-black)] font-bold transition-colors",
                identityPreview: "rounded-none border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-4 py-3",
                identityPreviewEditButton: "text-[var(--gold-leaf)] hover:text-[var(--ink-black)] transition-colors",
                dividerLine: "bg-[var(--etched-border)]",
                dividerText: "mono text-[9px] uppercase tracking-[0.15em] text-[var(--text-muted)] bg-transparent",
                socialButtonsBlockButton: "rounded-none border border-[var(--etched-border)] hover:bg-[var(--bg-elevated)] hover:border-[var(--ink-black)] text-[var(--ink-black)] transition-all",
                socialButtonsBlockButtonText: "mono text-[11px] font-semibold tracking-wider uppercase",
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
