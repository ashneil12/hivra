"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useScroll } from "framer-motion";

import PublicSite from "@/components/public-site/PublicSite";
import { tokenVerificationContent } from "@/lib/token-verification-content";

import styles from "./TokenPage.module.css";

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

const NAV_LINKS = [
  { label: "Verify", href: "#verify" },
  { label: "Live", href: "#live-now" },
  { label: "Flywheel", href: "#flywheel" },
  { label: "Holders", href: "#hold" },
  { label: "Mechanics", href: "#mechanics" },
  { label: "Build", href: "#flywheel" },
] as const;

const FLYWHEEL_PILLARS = tokenVerificationContent.ecosystemPillars;

interface RevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  x?: number;
  y?: number;
}

function Reveal({ children, className, delay = 0, x = 0, y = 22 }: RevealProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      initial={{ opacity: 0, x, y }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, amount: 0.16 }}
      transition={{ duration: 0.68, delay, ease: EASE_OUT }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function SectionHeading({ eyebrow, title, chip, children }: { eyebrow: string; title: string; chip?: string; children?: ReactNode }) {
  return (
    <div className={styles.sectionHeader}>
      {chip ? <span className={`mono ${styles.phaseChip}`} style={{ marginBottom: "0.9rem" }}>{chip}</span> : null}
      <p className={`mono ${styles.eyebrow}`}>{eyebrow}</p>
      <h2 className={`serif ${styles.sectionTitle}`}>{title}</h2>
      {children ? <p className={styles.sectionIntro}>{children}</p> : null}
    </div>
  );
}

function SquareLink({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <Link href={href} className={`mono ${primary ? styles.primaryButton : styles.secondaryButton}`}>
      {children}
      <span aria-hidden="true">↓</span>
    </Link>
  );
}

function CertifiedTokenPanel() {
  const [copied, setCopied] = useState(false);
  const contractAddress = tokenVerificationContent.tokenDetails.contractAddress;

  const copyContract = async () => {
    if (!contractAddress || typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(contractAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <aside className={styles.certifiedPanel} id="verify" aria-label="Certified token details">
      <div className={styles.certifiedTopline}>
        <span className={`mono ${styles.phaseChip}`}>Certified · Base</span>
      </div>
      <h2 className={`serif ${styles.certifiedTitle}`}>Certified token details</h2>
      <p className={styles.certifiedIntro}>Verify these before you do anything else.</p>

      <div className={styles.metaTable}>
        {tokenVerificationContent.tokenDetails.fields.map((field) => (
          <div key={field.label} className={styles.metaRow}>
            <div className={`mono ${styles.metaLabel}`}>{field.label}</div>
            <div className={styles.metaValue}>{field.value}</div>
          </div>
        ))}
      </div>

      {contractAddress ? (
        <button type="button" className={`mono ${styles.copyButton}`} onClick={copyContract}>
          {copied ? "Copied" : "Copy contract address"}
        </button>
      ) : null}

      <div className={styles.certifiedNotices}>
        {tokenVerificationContent.statusNotice.map((notice) => (
          <span key={notice} className={`mono ${styles.certifiedNoticeItem}`}>{notice}</span>
        ))}
      </div>
    </aside>
  );
}

function HeroNarrative() {
  return (
    <div className={styles.heroNarrative}>
      <p className={`mono ${styles.eyebrow}`}>{tokenVerificationContent.hero.badge}</p>
      <h1 className={`serif ${styles.heroTitle}`}>{tokenVerificationContent.hero.title}</h1>
      <p className={`mono ${styles.heroSupport}`}>{tokenVerificationContent.hero.supportLine}</p>
      <p className={styles.heroSubtitle}>{tokenVerificationContent.hero.subtitle}</p>
      <div className={styles.heroActions}>
        <SquareLink href="#verify" primary>{tokenVerificationContent.hero.primaryCta}</SquareLink>
        <SquareLink href="#live-now">{tokenVerificationContent.hero.secondaryCta}</SquareLink>
      </div>
      <p className={styles.heroTrust}>{tokenVerificationContent.hero.trustNote}</p>
    </div>
  );
}

function StateBoard() {
  return (
    <div className={styles.stateBoard}>
      {tokenVerificationContent.stateColumns.map((column, columnIndex) => (
        <Reveal key={column.title} delay={columnIndex * 0.05}>
          <article className={styles.stateColumn}>
            <p className={`mono ${styles.stateEyebrow}`}>{column.eyebrow}</p>
            <h3 className="serif">{column.title}</h3>
            <p>{column.body}</p>
            <div className={styles.stateRows}>
              {column.items.map((item, itemIndex) => (
                <div key={item.title} className={styles.stateRow}>
                  <span className={`mono ${styles.featureIndex}`}>{String(itemIndex + 1).padStart(2, "0")}</span>
                  <div>
                    <span className={`mono ${styles.statusLabel}`}>{item.status}</span>
                    <strong>{item.title}</strong>
                    <p>{item.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </Reveal>
      ))}
    </div>
  );
}

function EconomyIntro() {
  return (
    <div className={styles.economyIntro}>
      <p className={`mono ${styles.eyebrow}`}>{tokenVerificationContent.economyIntro.eyebrow}</p>
      <div className={styles.economyIntroGrid}>
        <h2 className={`serif ${styles.economyIntroTitle}`}>{tokenVerificationContent.economyIntro.title}</h2>
        <div className={styles.economyIntroCopy}>
          <p>{tokenVerificationContent.economyIntro.body}</p>
          <p>{tokenVerificationContent.economyIntro.support}</p>
        </div>
      </div>
    </div>
  );
}

function OperatorVision() {
  return (
    <div className={styles.operatorVision}>
      <SectionHeading
        eyebrow={tokenVerificationContent.operatorVision.eyebrow}
        title={tokenVerificationContent.operatorVision.title}
      >
        {tokenVerificationContent.operatorVision.intro}
      </SectionHeading>
      <p className={styles.operatorVisionSupport}>{tokenVerificationContent.operatorVision.support}</p>
      <div className={styles.operatorVisionBoard}>
        {tokenVerificationContent.operatorVision.items.map((item, index) => (
          <Reveal key={item.title} delay={index * 0.04}>
            <article className={styles.operatorVisionCard}>
              <span className={`mono ${styles.statusLabel}`}>{item.status}</span>
              <h3 className="serif">{item.title}</h3>
              <p>{item.body}</p>
            </article>
          </Reveal>
        ))}
      </div>
      <p className={styles.operatorVisionClose}>{tokenVerificationContent.operatorVision.close}</p>
    </div>
  );
}

function TokenLoopCards() {
  return (
    <div className={styles.loopStack} aria-label="Token product loop">
      {FLYWHEEL_PILLARS.map((pillar, index) => (
        <Reveal key={pillar.key} delay={index * 0.04} className={styles.loopCardFrame}>
          <article className={styles.loopCard}>
            <div className={styles.loopCardTopline}>
              <span className={`mono ${styles.pillarNumber}`}>{String(index + 1).padStart(2, "0")}</span>
              <span className={`mono ${styles.phaseChip}`}>{pillar.state}</span>
            </div>
            <div className={styles.loopCardMain}>
              <p className={`serif ${styles.loopCardLabel}`}>{pillar.label}</p>
              <div>
                <h3 className="serif">{pillar.title}</h3>
                <p>{pillar.why}</p>
              </div>
            </div>
            <div className={styles.detailColumns}>
              <div>
                <h4 className="mono">Live or ready</h4>
                <ul>
                  {pillar.live.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
              <div>
                <h4 className="mono">Opens next</h4>
                <ul>
                  {pillar.next.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            </div>
          </article>
        </Reveal>
      ))}
    </div>
  );
}

function HolderMatrix() {
  return (
    <div className={styles.holderMatrix}>
      {tokenVerificationContent.holderTiers.map((tier, index) => (
        <Reveal key={tier.name} delay={index * 0.04}>
          <article className={styles.holderTier}>
            <div className={styles.tierHead}>
              <span className={`mono ${styles.statusLabel}`}>{tier.status}</span>
              <span className={`mono ${styles.tierCompute}`}>{tier.compute}</span>
            </div>
            <h3 className="serif">{tier.name}</h3>
            <strong>{tier.headline}</strong>
            <div className={styles.tierUnlock}>
              <span className={`mono ${styles.tierUnlockLabel}`}>To unlock</span>
              <ul className={styles.tierUnlockList}>
                {tier.unlock.map((route) => <li key={route}>{route}</li>)}
              </ul>
            </div>
            <span className={`mono ${styles.tierUnlockLabel}`}>What it unlocks</span>
            <ul>
              {tier.perks.map((perk) => <li key={perk}>{perk}</li>)}
            </ul>
          </article>
        </Reveal>
      ))}
    </div>
  );
}

function BurnSurfaceTable() {
  return (
    <div className={styles.mechanicsTable}>
      {tokenVerificationContent.burnSurfaces.map((row, index) => (
        <Reveal key={row.title} delay={index * 0.04}>
          <div className={styles.mechanicsRow}>
            <span className={`mono ${styles.featureIndex}`}>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <span className={`mono ${styles.statusLabel}`}>{row.status}</span>
              <h3 className="serif">{row.title}</h3>
            </div>
            <p>{row.body}</p>
          </div>
        </Reveal>
      ))}
    </div>
  );
}

function BurnLedgerModule() {
  return (
    <aside className={styles.burnModule}>
      <span className={`mono ${styles.phaseChip}`}>{tokenVerificationContent.burnLedger.eyebrow}</span>
      <h3 className="serif">{tokenVerificationContent.burnLedger.title}</h3>
      <p>{tokenVerificationContent.burnLedger.body}</p>
      <div className={styles.metaTable}>
        {tokenVerificationContent.burnLedger.rows.map((row) => (
          <div key={row.label} className={styles.metaRow}>
            <div className={`mono ${styles.metaLabel}`}>{row.label}</div>
            <div className={styles.metaValue}>{row.value}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function GetPaidRows() {
  return (
    <div className={styles.roadmapRows}>
      {tokenVerificationContent.getPaid.rows.map((row, index) => (
        <Reveal key={row.title} delay={index * 0.04}>
          <article className={styles.roadmapRow}>
            <div>
              <span className={`mono ${styles.featureIndex}`}>{String(index + 1).padStart(2, "0")}</span>
              <p className={`mono ${styles.statusLabel}`}>{row.status}</p>
            </div>
            <div>
              <span className={`mono ${styles.phaseChip}`}>{row.settlement}</span>
              <h3 className="serif">{row.title}</h3>
              <p>{row.body}</p>
            </div>
            <ul>
              {row.examples.map((example) => <li key={example}>{example}</li>)}
            </ul>
          </article>
        </Reveal>
      ))}
    </div>
  );
}

function FAQRows() {
  return (
    <div className={styles.faqRows}>
      {tokenVerificationContent.faqs.map((faq) => (
        <details key={faq.question} className={styles.faqItem}>
          <summary className={`serif ${styles.faqQuestion}`}>{faq.question}</summary>
          <p>{faq.answer}</p>
        </details>
      ))}
    </div>
  );
}

export default function TokenPageClient() {
  const { scrollYProgress } = useScroll();

  return (
    <PublicSite className={styles.page} data-page="token">
      <motion.div className={styles.progressBar} aria-hidden="true">
        <motion.div className={styles.progressFill} style={{ scaleX: scrollYProgress, transformOrigin: "0% 50%" }} />
      </motion.div>

      <nav className={styles.chapterNav} aria-label="Token page navigation">{NAV_LINKS.map((link) => <Link key={`${link.label}-${link.href}`} href={link.href}>{link.label}</Link>)}</nav>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroGrid}>
            <Reveal x={-18}>
              <CertifiedTokenPanel />
            </Reveal>
            <Reveal delay={0.08} x={18}>
              <HeroNarrative />
            </Reveal>
          </div>
        </section>

        <section className={styles.sectionWide}>
          <Reveal>
            <EconomyIntro />
          </Reveal>
        </section>

        <section className={styles.sectionWide}>
          <Reveal>
            <OperatorVision />
          </Reveal>
        </section>

        <section id="live-now" className={styles.sectionWide}>
          <Reveal>
            <SectionHeading eyebrow="02 / STATE OF THE NETWORK" title="Live now. Shipping next.">
              No mystery map. What you can use today, and the pieces being wired next.
            </SectionHeading>
          </Reveal>
          <StateBoard />
        </section>

        <section id="flywheel" className={styles.sectionWide}>
          <Reveal>
            <SectionHeading eyebrow="03 / PRODUCT LOOP" title="Hold. Use. Build. Get paid.">
              One loop, not four disconnected promises: hold for access, use token for real product value, build what operators need, and get paid when operators run the work.
            </SectionHeading>
          </Reveal>
          <Reveal delay={0.08}>
            <TokenLoopCards />
          </Reveal>
        </section>

        <section id="hold" className={styles.sectionWide}>
          <Reveal>
            <SectionHeading eyebrow="04 / HOLDER ACCESS" title="What holding unlocks.">
              Free compute gets anyone started. Hold $HermesOS to run a bigger tier with no subscription and get earlier access to what ships. You can also pay any tier by card.
            </SectionHeading>
          </Reveal>
          <Reveal delay={0.05}>
            <p className={styles.mechanicCallout}>{tokenVerificationContent.holderMechanic}</p>
          </Reveal>
          <HolderMatrix />
        </section>

        <section id="mechanics" className={`${styles.sectionWide} ${styles.sectionTight}`}>
          <Reveal>
            <SectionHeading eyebrow="05 / BURNS" title="Use it for access. Then burn it.">
              Access is the starting point. Over time, $HermesOS becomes the economic layer connecting operators, services, and infrastructure across the ecosystem. Start simple: pay for a yearly Pro or Power plan in $HermesOS. Your access turns on, and once the burn rail is live, that token payment gets burned. Everything else keeps moving through the product for now.
            </SectionHeading>
          </Reveal>
          <div className={styles.mechanicsLayout}>
            <BurnSurfaceTable />
            <BurnLedgerModule />
          </div>
        </section>

        <section className={styles.sectionWide}>
          <Reveal>
            <SectionHeading eyebrow={tokenVerificationContent.getPaid.eyebrow} title={tokenVerificationContent.getPaid.title}>
              {tokenVerificationContent.getPaid.body}
            </SectionHeading>
          </Reveal>
          <Reveal delay={0.04}>
            <p className={styles.mechanicCallout}>{tokenVerificationContent.getPaid.examplesIntro}</p>
          </Reveal>
          <Reveal delay={0.05}>
            <p className={styles.mechanicCallout}>{tokenVerificationContent.getPaid.principle}</p>
          </Reveal>
          <GetPaidRows />
        </section>

        <section className={styles.sectionWide}>
          <Reveal>
            <SectionHeading eyebrow="07 / FAQ" title="Simple answers" />
          </Reveal>
          <FAQRows />
          <p className={`mono ${styles.footerDisclaimer}`}>{tokenVerificationContent.footerDisclaimer}</p>
        </section>
      </main>

    </PublicSite>
  );
}
