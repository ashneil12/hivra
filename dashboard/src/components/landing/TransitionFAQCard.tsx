import Link from "next/link";

export default function TransitionFAQCard() {
  return (
    <section
      aria-labelledby="homepage-hivra-transition-title"
      style={{
        width: "100%",
        maxWidth: 960,
        padding: "0 2rem 5rem",
      }}
    >
      <div
        className="etched-card"
        style={{
          display: "grid",
          gap: "0.75rem",
          borderColor: "var(--hivra-red-line)",
          background: "linear-gradient(135deg, var(--hivra-red-soft), var(--overlay-bg))",
          padding: "1.4rem clamp(1.25rem, 4vw, 2rem)",
        }}
      >
        <p
          className="mono"
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--gold-leaf)",
          }}
        >
          Transition FAQ
        </p>
        <h3
          id="homepage-hivra-transition-title"
          className="serif"
          style={{ fontSize: "1.15rem", fontWeight: 700, color: "var(--ink-black)" }}
        >
          What happened to HermesOS?
        </h3>
        <p style={{ maxWidth: 760, fontSize: 13, lineHeight: 1.8, color: "var(--text-secondary)" }}>
          HermesOS is evolving into Hivra as the platform expands beyond a single agent ecosystem. Existing deployments, accounts, and $HermesOS continue to operate normally.
        </p>
        <Link
          href="/why-hivra/evolution"
          className="mono"
          style={{
            width: "max-content",
            color: "var(--gold-leaf)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.12em",
            textDecoration: "none",
            textTransform: "uppercase",
          }}
        >
          Read the transition note →
        </Link>
      </div>
    </section>
  );
}
