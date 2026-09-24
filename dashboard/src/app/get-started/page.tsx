'use client';

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import {
  CheckCircle, Shield, Loader2,
  Cpu, HardDrive, Users,
} from "lucide-react";
import { captureClient } from "@/lib/telemetry/posthog-client";
import {
  PLANS, ACTIVE_PLAN_KEYS, formatPrice, type PlanKey, type Cadence,
} from "@/lib/subscription";
import { buildAgentTypeQuery, resolveWelcomeAgentTypeKey } from "@/lib/welcome-agent-catalog";
import InteractiveBackground from "@/components/InteractiveBackground";
import { LanguageSwitcher, LocaleProvider, useLocale } from "@/components/i18n/LocaleProvider";
import { FunnelHeader } from "@/components/layout/LandingHeader";
import funnelStyles from "@/components/public-site/public-site.module.css";
import { isLocalAuthMode } from "@/lib/self-host/config";

const GET_STARTED_ROUTE = "/get-started";

// Named funnel events for the /get-started -> /get-started/activate onboarding
// flow (canary #131). Each step emits a distinct, named event so the drop-off
// can be read as a PostHog funnel.
//
// Routed through captureClient (NOT the raw posthog singleton): PostHogProvider
// defers posthog.init() via requestIdleCallback (up to ~2s). A raw
// posthog.capture() that fires before init completes hits an uninitialized
// client and is silently dropped — losing get_started_viewed (and the other
// #190 funnel events) for real users whose page mounts before the deferred
// init. captureClient queues early calls and flushes them in order once init
// completes, and never throws, so analytics can't block the signup flow.
function captureFunnelEvent(event: string, properties: Record<string, unknown>) {
  captureClient(event, {
    source: "get-started",
    route: GET_STARTED_ROUTE,
    ...properties,
  });
}

function resolvePlanParam(planParam: string | null): PlanKey {
  if (planParam && (ACTIVE_PLAN_KEYS as string[]).includes(planParam)) {
    return planParam as PlanKey;
  }
  // No explicit plan intent → lead with Pro (the "Most popular" pick). Free
  // stays one click away in the switcher below — no dark patterns.
  return "operator";
}

function resolveCadenceParam(cadenceParam: string | null): Cadence {
  return cadenceParam === "yearly" ? "yearly" : "monthly";
}

/** Yearly price in cents for plans that have one configured; 0 otherwise. */
function yearlyPriceCents(planKey: PlanKey): number {
  const plan = PLANS[planKey];
  return "yearlyPrice" in plan ? plan.yearlyPrice : 0;
}

export default function GetStartedPage() {
  return (
    <LocaleProvider>
      <Suspense fallback={
        <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
          <Loader2 size={24} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
        </div>
      }>
        <GetStartedPageContent />
      </Suspense>
    </LocaleProvider>
  );
}

function GetStartedPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const selfHosted = isLocalAuthMode();
  const { copy } = useLocale();
  const setup = copy.getStarted;

  const planParam = searchParams?.get("plan") ?? null;
  const agentTypeKey = resolveWelcomeAgentTypeKey(searchParams?.get("agentType"));
  const agentTypeQuery = buildAgentTypeQuery(agentTypeKey);
  const [selectedPlan, setSelectedPlan] = useState<PlanKey>(
    resolvePlanParam(planParam)
  );
  const [cadence, setCadence] = useState<Cadence>(
    resolveCadenceParam(searchParams?.get("cadence") ?? null)
  );
  const selectedYearlyPrice = yearlyPriceCents(selectedPlan);
  const hasYearly = selectedYearlyPrice > 0;
  // Free has no yearly price — a yearly pick silently falls back to monthly
  // for the URL/checkout while the toggle state survives plan switches.
  const isYearly = cadence === "yearly" && hasYearly;
  const cadenceQuery = isYearly ? "&cadence=yearly" : "";
  const activationUrl = `/get-started/activate?plan=${selectedPlan}${cadenceQuery}${agentTypeQuery}`;
  const signInUrl = `/sign-in?plan=${selectedPlan}${cadenceQuery}${agentTypeQuery}`;

  const plan = PLANS[selectedPlan];
  const savePercent = hasYearly
    ? Math.round((1 - selectedYearlyPrice / (plan.price * 12)) * 100)
    : 0;
  const saveLabel = setup.cadence.saveLabel.replace("{percent}", String(savePercent));
  // Real annual savings in whole dollars, computed from the actual monthly vs
  // yearly prices (e.g. Pro: $9.99×12 = $119.88 − $79 = ~$41). No fabricated
  // anchors — this is the genuine delta between the two real prices.
  const saveDollars = hasYearly
    ? Math.round((plan.price * 12 - selectedYearlyPrice) / 100)
    : 0;
  const saveDollarsLabel = setup.cadence.saveDollarsLabel.replace(
    "{dollars}",
    String(saveDollars)
  );

  // Funnel step 1: a prospective user is shown the signup page. Fire once, only
  // for signed-out visitors — already-signed-in users are redirected straight to
  // activation and aren't entering the signup funnel.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (selfHosted || !isLoaded || isSignedIn || viewedRef.current) return;
    viewedRef.current = true;
    captureFunnelEvent("get_started_viewed", {
      plan: selectedPlan,
      cadence,
      agentType: agentTypeKey ?? null,
    });
  }, [selfHosted, isLoaded, isSignedIn, selectedPlan, cadence, agentTypeKey]);

  // This page is the hosted account and plan funnel. An independent install
  // has one installation-owned operator instead, so it must never render the
  // Clerk sign-up surface or imply that a Hivra Cloud account can be created
  // inside the local control plane.
  useEffect(() => {
    if (!selfHosted || !isLoaded) return;
    router.replace(isSignedIn ? "/dashboard" : "/sign-in");
  }, [selfHosted, isLoaded, isSignedIn, router]);

  // A signed-in visitor with a paid plan goes to activation to start checkout.
  // A Free intent (the public Register link) needs no checkout, so it goes
  // straight to the dashboard instead of re-running the Free activation.
  useEffect(() => {
    if (!selfHosted && isLoaded && isSignedIn) {
      router.replace(planParam === "free" ? "/dashboard" : activationUrl);
    }
  }, [activationUrl, planParam, selfHosted, isLoaded, isSignedIn, router]);

  const showPlanSwitcher = () => {
    const switcher = document.getElementById("get-started-plans");
    switcher?.scrollIntoView({ behavior: "smooth", block: "center" });
    switcher?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  };

  // Rendered twice: in the plan column on wide screens, and above the form
  // in the single-column layout, where the form comes first.
  const stepIndicator = (className: string) => (
    <div className={className} style={{
      display: "flex", alignItems: "center", gap: 12,
      marginBottom: "2rem",
    }}>
      <StepBadge number={1} label={setup.steps.choosePlan} active />
      <div className="get-started-step-line" style={{ width: 32, height: 1, background: "var(--etched-border)" }} />
      <StepBadge number={2} label={setup.steps.createAccount} active />
      <div className="get-started-step-line" style={{ width: 32, height: 1, background: "var(--etched-border)" }} />
      <StepBadge number={3} label={selectedPlan === "free" ? setup.steps.activate : setup.steps.payment} />
    </div>
  );

  if (selfHosted) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <Loader2 size={24} style={{ opacity: 0.4, animation: "spin 1s linear infinite" }} />
          <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.5 }}>
            Opening Local Hivra
          </span>
        </div>
      </div>
    );
  }

  // Show nothing while Clerk loads to avoid flash
  if (!isLoaded) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <Loader2 size={24} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  // If already signed in, show loading while redirect happens
  if (isSignedIn) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <Loader2 size={24} style={{ opacity: 0.4, animation: "spin 1s linear infinite" }} />
          <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.5 }}>
            {setup.loadingCheckout}
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <InteractiveBackground />
      <FunnelHeader homeHref={selfHosted ? undefined : "/"} trailing={<LanguageSwitcher />} />
      <div className={funnelStyles.funnelPage} style={{
        padding: "2rem",
        position: "relative",
      }}>
        {/* Main container */}
        <div className="get-started-grid" style={{
          maxWidth: 1100,
          margin: "0 auto",
          paddingTop: "1.5rem",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "3rem",
          alignItems: "start",
          position: "relative",
          zIndex: 10,
        }}>

          {/* ── RIGHT: Clerk Sign Up ────────────────────────────────── */}
          {/* First in the DOM so the single-column reading and tab order match the screen. */}
          <div className="get-started-form">
            {stepIndicator("get-started-steps-compact")}
            {/* Phones get the form first; this line keeps the plan in view. */}
            <div className="get-started-summary">
              <span className="mono">
                {plan.name} · {formatPrice(isYearly ? selectedYearlyPrice : plan.price)}{isYearly ? setup.perYear : setup.perMonth}
              </span>
              <button type="button" className="mono" onClick={showPlanSwitcher}>{setup.switchPlan}</button>
            </div>
            <div style={{ marginBottom: "1.25rem" }}>
              <h3 className="serif" style={{ fontSize: "1.5rem", fontWeight: 400, marginBottom: "0.4rem" }}>
                {setup.createAccountTitle}
              </h3>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                {selectedPlan === "free" ? setup.createAccountIntroFree : setup.createAccountIntroPaid}
              </p>
            </div>

            <SignUp
              routing="hash"
              forceRedirectUrl={activationUrl}
              fallbackRedirectUrl={activationUrl}
              signInUrl={signInUrl}
              appearance={{
                elements: {
                  rootBox: "w-full",
                  cardBox: "w-full max-w-full",
                  card: "rounded-none border border-[var(--etched-border)] shadow-[0_24px_80px_rgba(0,0,0,0.08)] bg-white/95 backdrop-blur-xl p-8 pb-10",
                  headerTitle: "serif text-[2rem] font-light text-[var(--ink-black)] leading-none mb-2",
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
                  main: "gap-6",
                },
                variables: {
                  borderRadius: 0,
                  colorPrimary: "var(--ink-black)",
                  colorBackground: "transparent",
                  colorText: "var(--ink-black)",
                  colorInputBackground: "transparent",
                  colorInputText: "var(--ink-black)",
                  fontFamily: "inherit",
                },
              }}
            />

            <div className="mt-6 text-center text-[var(--text-muted)] font-mono text-[9px] uppercase tracking-wider">
              {setup.legalPrefix} <br className="hidden sm:block" />
              <Link href="/terms" className="underline hover:text-[var(--ink-black)] transition-colors">{setup.terms}</Link> {setup.and} <Link href="/privacy" className="underline hover:text-[var(--ink-black)] transition-colors">{setup.privacy}</Link>
            </div>
          </div>

          {/* ── LEFT: Plan Summary ──────────────────────────────────── */}
          <div className="get-started-sticky" style={{ position: "sticky", top: "3rem" }}>
            {stepIndicator("get-started-steps")}

            {/* Selected plan card */}
            <div className={funnelStyles.funnelCard} style={{
              border: "1px solid var(--ink-black)",
              background: "var(--bg-surface)",
              padding: "2.5rem",
              boxShadow: "4px 4px 0px var(--ink-black)",
              position: "relative",
            }}>
              {/* Gold bar */}
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--gold-leaf)" }} />

              {/* Guarantee badge and cadence share a wrapping row, so a wrapped toggle starts flush left. */}
              <div style={{
                display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px",
                marginBottom: hasYearly ? "1rem" : "0.75rem",
              }}>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 12px",
                  background: "rgba(22,163,106,0.08)",
                  border: "1px solid rgba(22,163,106,0.2)",
                }}>
                  <span className="mono" style={{
                    fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em",
                    fontWeight: 700, color: "#16a36a",
                  }}>
                    {selectedPlan === "free" ? setup.badges.free : setup.badges.paid}
                  </span>
                </div>

                {/* Monthly / Yearly toggle — only for plans that sell yearly */}
                {hasYearly ? (
                  <div role="group" aria-label="Billing cadence" className="get-started-cadence" style={{ display: "inline-flex", border: "1px solid var(--etched-border)" }}>
                    {(["monthly", "yearly"] as const).map((c) => {
                      const active = (cadence === "yearly") === (c === "yearly");
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setCadence(c)}
                          aria-pressed={active}
                          className="mono"
                          style={{
                            border: "none",
                            background: active ? "var(--ink-black)" : "transparent",
                            color: active ? "var(--bg-surface)" : "var(--text-secondary)",
                            fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em",
                            fontWeight: 700, padding: "6px 10px", cursor: "pointer",
                            display: "inline-flex", alignItems: "center", gap: 6,
                          }}
                        >
                          <span>{c === "yearly" ? setup.cadence.yearly : setup.cadence.monthly}</span>
                          {c === "yearly" ? (
                            <span style={{ color: active ? "var(--gold-leaf)" : "#16a36a", textTransform: "none", letterSpacing: "0.02em" }}>
                              {saveLabel}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
                <div>
                  <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5, fontWeight: 700 }}>
                    {setup.yourPlan}
                  </span>
                  <h2 className="serif" style={{ fontSize: "2rem", fontWeight: 700, marginTop: 4 }}>
                    {plan.name}
                  </h2>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                    <span className="serif" style={{ fontSize: "2.5rem", fontWeight: 700, lineHeight: 1 }}>
                      {formatPrice(isYearly ? selectedYearlyPrice : plan.price)}
                    </span>
                    <span className="mono" style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>{isYearly ? setup.perYear : setup.perMonth}</span>
                  </div>
                  {isYearly ? (
                    <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: "#16a36a", letterSpacing: "0.04em" }}>
                      {saveDollarsLabel}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Specs */}
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem",
                padding: "1rem", background: "var(--bg-elevated)",
                border: "1px solid var(--etched-border)", marginBottom: "1.5rem",
              }}>
                <SpecItem icon={<Users size={14} />} label={setup.specs.agents} value={plan.specs.agents} />
                <SpecItem icon={<Cpu size={14} />} label={setup.specs.cpu} value={plan.specs.cpu} />
                <SpecItem icon={<HardDrive size={14} />} label={setup.specs.ram} value={plan.specs.ram} />
              </div>

              {/* Features */}
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.55rem", marginBottom: selectedPlan === "free" ? "0.9rem" : "1.5rem" }}>
                {plan.features.slice(0, 5).map((f) => (
                  <li key={f} style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <CheckCircle size={12} style={{ color: "var(--gold-leaf)", flexShrink: 0, marginTop: 2 }} />
                    {f}
                  </li>
                ))}
              </ul>

              {/* What Free concretely lacks — honest gap line, free card only */}
              {selectedPlan === "free" ? (
                <div style={{
                  padding: "9px 12px", marginBottom: "1.5rem",
                  border: "1px dashed var(--etched-border)", background: "var(--bg-elevated)",
                }}>
                  <span className="mono" style={{ fontSize: 10, letterSpacing: "0.04em", color: "var(--text-muted)", lineHeight: 1.6, display: "block" }}>
                    {setup.freeGap}
                  </span>
                </div>
              ) : null}

              {/* Honest market anchor — generic, true (no competitor named, no
                  fabricated "was $X"). Paid cards only. */}
              {selectedPlan !== "free" ? (
                <div style={{
                  padding: "9px 12px", marginBottom: "1.5rem",
                  border: "1px dashed var(--etched-border)", background: "var(--bg-elevated)",
                }}>
                  <span className="mono" style={{ fontSize: 10, letterSpacing: "0.04em", color: "var(--text-muted)", lineHeight: 1.6, display: "block" }}>
                    {setup.marketAnchor}
                  </span>
                </div>
              ) : null}

              {/* Guarantee */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 14px", border: "1px solid var(--etched-border)",
              }}>
                <Shield size={12} style={{ opacity: 0.4 }} />
                <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5, fontWeight: 600 }}>
                  {selectedPlan === "free" ? setup.guarantee.free : setup.guarantee.paid}
                </span>
              </div>
            </div>

            {/* Plan switcher */}
            <div id="get-started-plans" style={{ marginTop: "1.5rem" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 12, marginBottom: "0.75rem",
              }}>
                <div style={{ flex: 1, height: 1, background: "var(--etched-border)" }} />
                <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.35, fontWeight: 700 }}>
                  {setup.switchPlan}
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--etched-border)" }} />
              </div>
              <div style={{ display: "flex", gap: "0.75rem", paddingTop: 8 }}>
                {ACTIVE_PLAN_KEYS.map((key) => {
                  const p = PLANS[key];
                  const isSelected = key === selectedPlan;
                  const isMostPopular = key === "operator";
                  const optionYearly = yearlyPriceCents(key);
                  const showYearly = cadence === "yearly" && optionYearly > 0;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        // Funnel step: plan selection changed on the landing page.
                        if (key !== selectedPlan) {
                          captureFunnelEvent("get_started_plan_selected", {
                            plan: key,
                            previousPlan: selectedPlan,
                            cadence,
                          });
                        }
                        setSelectedPlan(key);
                      }}
                      style={{
                        flex: 1,
                        padding: "10px 12px",
                        border: isSelected
                          ? "2px solid var(--ink-black)"
                          : isMostPopular
                            ? "1px solid var(--gold-leaf)"
                            : "1px solid var(--etched-border)",
                        background: isSelected ? "var(--bg-elevated)" : "var(--bg-surface)",
                        cursor: "pointer",
                        textAlign: "center",
                        transition: "all 0.2s ease",
                        position: "relative",
                      }}
                    >
                      {isMostPopular ? (
                        <span className="mono" style={{
                          position: "absolute", top: -9, left: "50%", transform: "translateX(-50%)",
                          background: "var(--gold-leaf)", color: "var(--ink-black)",
                          fontSize: 8, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em",
                          padding: "2px 7px", whiteSpace: "nowrap",
                        }}>
                          {setup.mostPopular}
                        </span>
                      ) : null}
                      <span className="serif" style={{ fontSize: 13, fontWeight: 700, display: "block" }}>{p.name}</span>
                      <span className="mono" style={{ fontSize: 10, opacity: 0.5 }}>
                        {showYearly ? `${formatPrice(optionYearly)}${setup.perYear}` : `${formatPrice(p.price)}${setup.perMonth}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{
              marginTop: "1rem",
              padding: "14px 16px",
              border: "1px solid var(--etched-border)",
              background: "var(--bg-elevated)",
            }}>
              <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.5, fontWeight: 700, marginBottom: 6 }}>
                {setup.bestFit}
              </div>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
                {setup.planGuidance[selectedPlan]}
              </p>
            </div>
          </div>
        </div>

        {/* Responsive styles */}
        <style>{`
          .get-started-summary {
            display: none;
          }
          .get-started-steps-compact {
            display: none !important;
          }
          /* The form leads the DOM; the wide layout keeps the plan column on the left. */
          .get-started-grid {
            reading-flow: grid-rows;
          }
          .get-started-sticky {
            grid-column: 1;
            grid-row: 1;
          }
          .get-started-form {
            grid-column: 2;
            grid-row: 1;
          }
          @media (max-width: 840px) {
            .get-started-steps {
              display: none !important;
            }
            .get-started-steps-compact {
              display: flex !important;
              margin-bottom: 1.25rem !important;
            }
            .get-started-grid {
              grid-template-columns: 1fr !important;
              gap: 2rem !important;
            }
            .get-started-sticky {
              position: static !important;
            }
            .get-started-sticky,
            .get-started-form {
              grid-column: auto;
              grid-row: auto;
            }
            .get-started-summary {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
              margin-bottom: 1.25rem;
              padding-left: 12px;
              border: 1px solid var(--etched-border);
              border-left: 3px solid var(--gold-leaf);
              background: var(--bg-surface);
              font-size: 12px;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.08em;
            }
            .get-started-summary > span {
              min-width: 0;
              overflow-wrap: anywhere;
            }
            .get-started-summary > button {
              flex-shrink: 0;
              min-height: 44px;
              padding: 0 14px;
              border: 0;
              border-left: 1px solid var(--etched-border);
              background: transparent;
              color: var(--ink-black);
              font-size: 11px;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.1em;
              cursor: pointer;
            }
          }
          @media (max-width: 767px) {
            .get-started-steps-compact {
              gap: 8px !important;
            }
            .get-started-steps-compact span {
              font-size: 11px !important;
              letter-spacing: 0.06em !important;
            }
            .get-started-steps-compact .get-started-step-line {
              width: auto !important;
              flex: 0 1 32px;
              min-width: 8px;
            }
          }
          @media (max-width: 840px), (pointer: coarse) {
            .get-started-cadence button {
              min-height: 44px;
              padding: 0 14px !important;
              font-size: 11px !important;
            }
          }
          @media (max-width: 480px) {
            .get-started-cadence {
              display: flex !important;
              width: 100%;
            }
            .get-started-cadence button {
              flex: 1;
              justify-content: center;
            }
          }
        `}</style>
      </div>
    </>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StepBadge({ number, label, active }: { number: number; label: string; active?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: active ? 1 : 0.35 }}>
      <span style={{
        width: 22, height: 22,
        display: "flex", alignItems: "center", justifyContent: "center",
        border: active ? "1.5px solid var(--ink-black)" : "1px solid var(--etched-border)",
        background: active ? "var(--ink-black)" : "transparent",
        color: active ? "var(--bg-surface)" : "var(--ink-black)",
        fontFamily: "var(--font-mono), monospace",
        fontSize: 10, fontWeight: 700,
      }}>
        {number}
      </span>
      <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
        {label}
      </span>
    </div>
  );
}

function SpecItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 4, opacity: 0.4 }}>
        {icon}
      </div>
      <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5, fontWeight: 700, display: "block" }}>
        {label}
      </span>
      <span className="mono" style={{ fontSize: 11, fontWeight: 700, display: "block", marginTop: 2 }}>
        {value}
      </span>
    </div>
  );
}
