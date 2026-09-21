"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AnimateIn } from "@/components/ui/animate-in";
import { useLocale } from "@/components/i18n/LocaleProvider";

export default function FinalCTASection() {
  const { copy } = useLocale();
  const finalCta = copy.finalCta;

  return (
    <section style={{ maxWidth: 800, width: "100%", padding: "0 2rem 8rem", textAlign: "center", zIndex: 10 }}>
      <AnimateIn>
        <div style={{ padding: "4rem 2.5rem", border: "1px solid var(--etched-border)", background: "var(--overlay-bg)", backdropFilter: "blur(12px)" }}>
          <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.4, fontWeight: 700, marginBottom: "1.5rem" }}>
            {finalCta.eyebrow}
          </div>
          <h2 className="serif" style={{ fontSize: "clamp(1.8rem, 3vw, 2.4rem)", fontWeight: 300, marginBottom: "1.25rem", color: "var(--ink-black)", lineHeight: 1.2 }}>
            {finalCta.title}
          </h2>
          <p style={{ fontSize: "0.95rem", lineHeight: 1.7, color: "var(--text-secondary)", maxWidth: 480, margin: "0 auto 2.5rem" }}>
            {finalCta.body}
          </p>

          <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap", marginBottom: "1.75rem" }}>
            <Link
              href="/get-started?plan=free"
              id="final-cta"
              className="action-button"
              style={{
                padding: "16px 36px",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                textDecoration: "none",
                letterSpacing: "0.12em",
              }}
            >
              {finalCta.primary} <ArrowRight size={14} />
            </Link>
            <Link
              href="#pricing"
              style={{
                padding: "16px 28px",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                textDecoration: "none",
                border: "1px solid var(--ink-black)",
                color: "var(--ink-black)",
                fontFamily: "var(--font-mono), monospace",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                background: "transparent",
              }}
            >
              {finalCta.secondary}
            </Link>
          </div>

          <p style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 480, margin: "0 auto 1.5rem", lineHeight: 1.6 }}>
            {finalCta.note}
          </p>

          <Link href="/sign-in" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}>
            {finalCta.accountPrefix}{" "}
            <span style={{ color: "var(--ink-black)", borderBottom: "1px solid var(--etched-border)", paddingBottom: 1 }}>
              {finalCta.accountLink}
            </span>
          </Link>
        </div>
      </AnimateIn>
    </section>
  );
}
