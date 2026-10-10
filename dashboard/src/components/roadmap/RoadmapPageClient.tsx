"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useScroll } from "framer-motion";

import PublicSite from "@/components/public-site/PublicSite";
// Types only. The content arrives as a prop from the server page, which decides
// per viewer whether it is the full roadmap or the restricted copy. Importing the
// content value here would put the token copy in the JavaScript sent to every
// browser, including the ones the token geo-policy blocks.
import type {
  RoadmapMetadataItem,
  RoadmapPageContent,
  RoadmapPhase,
  RoadmapUtilityCard,
} from "@/lib/roadmap-content";

import styles from "./RoadmapPage.module.css";
import { PUBLIC_START_HREF } from "@/lib/public-start";

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

interface RevealProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  delay?: number;
  x?: number;
  y?: number;
}

function Reveal({ children, className, style, delay = 0, x = 0, y = 30 }: RevealProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, x, y }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.72, delay, ease: EASE_OUT }}
      className={className}
      style={{ ...style, willChange: "transform, opacity" }}
    >
      {children}
    </motion.div>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className={styles.sectionHeader}>
      <p className={`mono ${styles.eyebrow}`}>{eyebrow}</p>
      <h2 className={`serif ${styles.sectionTitle}`}>{title}</h2>
    </div>
  );
}

function UtilityIcon({ icon }: { icon: RoadmapUtilityCard["icon"] }) {
  const commonProps = {
    className: styles.utilityIconSvg,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true,
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (icon) {
    case "server":
      return (
        <svg {...commonProps}>
          <rect x="4" y="5" width="16" height="5" rx="0" />
          <rect x="4" y="14" width="16" height="5" rx="0" />
          <path d="M15 7.5h1" />
          <path d="M18 7.5h.01" />
          <path d="M15 16.5h1" />
          <path d="M18 16.5h.01" />
        </svg>
      );
    case "gateway":
      return (
        <svg {...commonProps}>
          <circle cx="16.5" cy="7.5" r="3.5" />
          <path d="M4 18 12.5 9.5" />
          <path d="M9.5 9.5h3" />
          <path d="M12.5 9.5v3" />
        </svg>
      );
    case "clock":
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M12 8.5V12l2.5 2.5" />
          <path d="M17.5 6.5 20 4" />
        </svg>
      );
    case "market":
      return (
        <svg {...commonProps}>
          <rect x="5" y="5" width="5" height="5" rx="0" />
          <rect x="14" y="5" width="5" height="5" rx="0" />
          <rect x="5" y="14" width="5" height="5" rx="0" />
          <rect x="14" y="14" width="5" height="5" rx="0" />
        </svg>
      );
    case "loop":
      return (
        <svg {...commonProps}>
          <path d="M8 7a6 6 0 0 1 9 2" />
          <path d="M17 9V5h-4" />
          <path d="M16 17a6 6 0 0 1-9-2" />
          <path d="M7 15v4h4" />
        </svg>
      );
    case "network":
      return (
        <svg {...commonProps}>
          <circle cx="6" cy="16" r="2" />
          <circle cx="12" cy="7" r="2" />
          <circle cx="18" cy="16" r="2" />
          <path d="M7.3 14.4 10.7 8.6" />
          <path d="M13.3 8.6 16.7 14.4" />
          <path d="M8 16h8" />
        </svg>
      );
    case "exchange":
      return (
        <svg {...commonProps}>
          <circle cx="6" cy="12" r="2.25" />
          <circle cx="18" cy="12" r="2.25" />
          <path d="M8.5 10.2 11.5 10.2l2 1.8h2" />
          <path d="m15.5 9.8 2 2.2-2 2.2" />
          <path d="M15.5 14.2 12.5 14.2l-2-1.8h-2" />
          <path d="m8.5 14.2-2-2.2 2-2.2" />
        </svg>
      );
    case "settlement":
      return (
        <svg {...commonProps}>
          <rect x="4" y="7" width="8" height="10" rx="0" />
          <rect x="12" y="7" width="8" height="10" rx="0" />
          <path d="M10.5 12h3" />
          <path d="m12 10.5 1.5 1.5L12 13.5" />
        </svg>
      );
    case "governance":
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v8" />
          <path d="M8 10.5h8" />
          <path d="m9.2 10.5-1.7 3h3.4l-1.7-3Z" />
          <path d="m14.8 10.5-1.7 3h3.4l-1.7-3Z" />
        </svg>
      );
    default:
      return null;
  }
}

function MetadataTable({ items }: { items: readonly RoadmapMetadataItem[] }) {
  return (
    <div className={styles.metaTable}>
      {items.map((item) => (
        <div key={item.label} className={styles.metaRow}>
          <div className={`mono ${styles.metaLabel}`}>{item.label}</div>
          <div className={styles.metaValue}>{renderMetadataValue(item)}</div>
        </div>
      ))}
    </div>
  );
}

function renderMetadataValue(item: RoadmapMetadataItem) {
  if (!item.href) {
    return item.value;
  }

  if (item.href.startsWith("/")) {
    return <Link href={item.href}>{item.value}</Link>;
  }

  return (
    <a href={item.href} target="_blank" rel="noopener noreferrer">
      {item.value}
    </a>
  );
}

function VisionStickySection({ content }: { content: RoadmapPageContent }) {
  const reduceMotion = useReducedMotion();
  const sectionRef = useRef<HTMLElement | null>(null);
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  });
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const maybeMotionValue = scrollYProgress as { on?: (event: string, handler: (value: number) => void) => () => void };

    if (typeof maybeMotionValue.on !== "function") {
      return undefined;
    }

    const unsubscribe = maybeMotionValue.on("change", (value) => {
      if (value < 0.33) {
        setActiveIndex(0);
        return;
      }

      if (value < 0.66) {
        setActiveIndex(1);
        return;
      }

      setActiveIndex(2);
    });

    return unsubscribe;
  }, [scrollYProgress]);

  return (
    <section ref={sectionRef} className={styles.visionSection}>
      <div className={styles.visionSticky}>
        <div className={styles.visionFrame}>
          <p className={`mono ${styles.visionEyebrow}`}>{content.vision.eyebrow}</p>
          <div className={styles.visionCopyWrap}>
            {content.visionSticky.states.map((state, index) => {
              const isActive = index === activeIndex;

              return (
                <motion.div
                  key={`vision-state-${index}`}
                  className={styles.visionState}
                  aria-hidden={!isActive}
                  animate={
                    reduceMotion
                      ? { opacity: isActive ? 1 : 0 }
                      : {
                          opacity: isActive ? 1 : 0,
                          y: isActive ? 0 : 18,
                        }
                  }
                  transition={{ duration: 0.45, ease: EASE_OUT }}
                  style={{
                    opacity: isActive ? 1 : 0,
                    transform: `translateY(${isActive ? 0 : 18}px)`,
                    willChange: "transform, opacity",
                    pointerEvents: "none",
                  }}
                >
                  <p className={`serif ${styles.visionCopy}`}>
                    {"text" in state ? (
                      state.text
                    ) : (
                      <>
                        {state.textLead}
                        <span className={styles.goldHighlight}>{state.textHighlight}</span>
                        {state.textTail}
                      </>
                    )}
                  </p>
                </motion.div>
              );
            })}
          </div>
          <div className={styles.visionDots} aria-label={`Vision state ${activeIndex + 1} of 3`}>
            {content.visionSticky.states.map((_, index) => (
              <span
                key={`vision-dot-${index}`}
                className={`${styles.visionDot} ${index === activeIndex ? styles.visionDotActive : ""}`}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PhaseBlock({ phase, index }: { phase: RoadmapPhase; index: number }) {
  return (
    <Reveal className={styles.phaseBlock} delay={index * 0.04}>
      <div className={styles.phaseGrid}>
        <aside className={styles.phaseAside}>
          <span className={`mono ${styles.phaseChip}`}>{phase.tag}</span>
          <h3 className={`serif ${styles.phaseName}`}>{phase.name}</h3>
          <p className={`mono ${styles.phaseTimeline}`}>{phase.timeline}</p>
          <p className={styles.phaseDescriptor}>{phase.descriptor}</p>
        </aside>

        <div className={styles.phaseContent}>
          {phase.sections.map((section) => (
            <section key={section.heading} className={styles.phaseSection}>
              <h4 className={`mono ${styles.phaseSectionHeading}`}>{section.heading}</h4>
              {section.callout ? (
                <div className={`${styles.callout} ${styles.calloutPurple}`} style={{ marginTop: "0.95rem" }}>
                  <em>{section.callout}</em>
                </div>
              ) : null}
              {section.intro ? <p className={styles.phaseIntro}>{section.intro}</p> : null}
              {section.paragraphs ? (
                <div className={styles.phaseParagraphs}>
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph} className={styles.phaseParagraph}>
                      {paragraph}
                    </p>
                  ))}
                </div>
              ) : null}
              {section.bullets ? (
                <div className={styles.phaseBullets}>
                  {section.bullets.map((bullet) => (
                    <div key={bullet} className={styles.phaseBullet}>
                      <span className={styles.phaseArrow} aria-hidden="true">
                        →
                      </span>
                      <p className={styles.phaseParagraph}>{bullet}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

export default function RoadmapPageClient({ content, tokenSurfaces = false }: { content: RoadmapPageContent; tokenSurfaces?: boolean }) {
  const { scrollYProgress } = useScroll();
  // Null in the restricted copy for a viewer the token geo-policy blocks.
  const { token } = content;

  return (
    <PublicSite className={styles.page} data-page="roadmap" tokenSurfaces={tokenSurfaces}>
      <motion.div className={styles.progressBar} aria-hidden="true">
        <motion.div
          className={styles.progressFill}
          style={{ scaleX: scrollYProgress, transformOrigin: "0% 50%" }}
        />
      </motion.div>

      <nav className={styles.chapterNav} aria-label="Roadmap navigation">{content.navLinks.map((link) => <Link key={`${link.label}-${link.href}`} href={link.href}>{link.label}</Link>)}</nav>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <motion.p
              className={`mono ${styles.eyebrow} ${styles.heroReveal1}`}
              style={{ willChange: "transform, opacity" }}
            >
              {content.hero.eyebrow}
            </motion.p>

            <motion.h1
              className={`serif ${styles.heroTitle} ${styles.heroReveal2}`}
              style={{ willChange: "transform, opacity" }}
            >
              {content.hero.title}
            </motion.h1>

            <motion.p
              className={`${styles.heroSubtitle} ${styles.heroReveal3}`}
              style={{ willChange: "transform, opacity" }}
            >
              {content.hero.subtitle}
            </motion.p>

            <motion.div
              className={`${styles.heroActions} ${styles.heroReveal4}`}
              style={{ willChange: "transform, opacity" }}
            >
              <Link href={PUBLIC_START_HREF} className={`mono ${styles.secondaryButton}`}>
                Deploy Hivra
              </Link>
              <a href="#what-is-hermesos" className={`mono ${styles.primaryButton}`}>
                Read it here ↓
              </a>
            </motion.div>

            <motion.div
              className={`${styles.scrollPrompt} ${styles.heroReveal5}`}
              style={{ willChange: "transform, opacity" }}
            >
              <div className={styles.scrollIndicator} aria-hidden="true" />
              <span className={`mono ${styles.scrollText}`}>{content.hero.scrollLabel}</span>
            </motion.div>
          </div>
        </section>

        <section className={styles.ledeSection}>
          <Reveal>
            <p className={styles.lede}>
              <em>{content.hero.note}</em>
            </p>
          </Reveal>
        </section>

        <section id="what-is-hermesos" className={styles.section}>
          <Reveal>
            <SectionHeading
              eyebrow={content.whatIsHermesOS.eyebrow}
              title={content.whatIsHermesOS.title}
            />
          </Reveal>
          <div className={styles.sectionBody}>
            {content.whatIsHermesOS.paragraphs.map((paragraph, index) => (
              <Reveal key={paragraph} delay={index * 0.08}>
                <p className={styles.bodyCopy}>{paragraph}</p>
              </Reveal>
            ))}
            <Reveal delay={0.16}>
              <div className={styles.callout}>
                <em>{content.whatIsHermesOS.callout}</em>
              </div>
            </Reveal>
          </div>
        </section>

        <section id="who-is-hermesos-for" className={styles.section}>
          <Reveal>
            <SectionHeading eyebrow={content.audience.eyebrow} title={content.audience.title} />
          </Reveal>

          <div className={styles.sectionBody}>
            {content.audience.paragraphs.map((paragraph, index) => (
              <Reveal key={paragraph} delay={index * 0.08}>
                <p className={styles.bodyCopy}>{paragraph}</p>
              </Reveal>
            ))}
          </div>

          <div className={styles.cardGrid}>
            {content.audience.cards.map((card, index) => {
              const cardLabel = "label" in card && typeof card.label === "string" ? card.label : undefined;

              return (
                <Reveal key={card.title} delay={0.12 + index * 0.08} x={index === 0 ? -44 : 44}>
                  <article className={styles.card}>
                    {cardLabel ? <p className={`mono ${styles.cardLabel}`}>{cardLabel}</p> : null}
                    <h3 className={`serif ${styles.cardTitle} ${cardLabel ? "" : styles.cardTitleTight}`}>
                      {card.title}
                    </h3>
                    <p className={styles.cardBody}>{card.body}</p>
                  </article>
                </Reveal>
              );
            })}
          </div>

          <Reveal delay={0.28}>
            <div className={`${styles.sectionBody} ${styles.summaryText}`}>
              {content.audience.summary ? <p className={styles.bodyCopy}>{content.audience.summary}</p> : null}
              <p className={styles.bodyCopy}>{content.audience.detail}</p>
            </div>
          </Reveal>
        </section>

        <section id="what-is-live-today" className={styles.sectionWide}>
          <Reveal>
            <SectionHeading eyebrow={content.liveToday.eyebrow} title={content.liveToday.title} />
          </Reveal>
          <Reveal delay={0.06}>
            <div className={styles.sectionBody}>
              <p className={styles.bodyCopy}>{content.liveToday.intro}</p>
            </div>
          </Reveal>
          <div className={styles.featureTable}>
            {content.liveToday.features.map((feature, index) => (
              <Reveal key={feature.name} delay={0.08 + index * 0.05}>
                <div className={styles.featureRow}>
                  <span className={styles.liveDot} aria-hidden="true" />
                  <div className={styles.featureName}>{feature.name}</div>
                  <div className={styles.featureDescription}>{feature.description}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section id="product-vision" className={styles.section}>
          <Reveal>
            <SectionHeading eyebrow={content.vision.eyebrow} title={content.vision.title} />
          </Reveal>
          <Reveal delay={0.06}>
            <div className={styles.callout}>
              <em>{content.vision.callout}</em>
            </div>
          </Reveal>
          <div className={styles.sectionBody}>
            {content.vision.paragraphs.map((paragraph, index) => (
              <Reveal key={paragraph} delay={0.08 + index * 0.08}>
                <p className={styles.bodyCopy}>{paragraph}</p>
              </Reveal>
            ))}
            <Reveal delay={0.18}>
              <p className={styles.sectionLead}>{content.vision.directionLead}</p>
            </Reveal>
          </div>
        </section>

        <section className={`${styles.section} ${styles.visionDirectionSection}`}>
          <div className={styles.directionList}>
            {content.visionDirection.rows.map((row, index) => (
              <Reveal key={row.number} delay={index * 0.1} x={-36}>
                <div className={styles.directionRow}>
                  <div className={`mono ${styles.directionNumber}`}>{row.number}</div>
                  <div className={styles.directionContent}>
                    <h3 className={styles.directionTitle}>{row.title}</h3>
                    <p className={styles.directionBody}>{row.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <VisionStickySection content={content} />

        {token ? (
          <section id="hermesos-token" className={styles.section}>
            <Reveal>
              <SectionHeading eyebrow={token.eyebrow} title={token.title} />
            </Reveal>
            <div className={`${styles.sectionBody} ${styles.tokenIntro}`}>
              {token.originParagraphs.map((paragraph, index) => (
                <Reveal key={paragraph} delay={0.08 + index * 0.08}>
                  <p className={styles.bodyCopy}>{paragraph}</p>
                </Reveal>
              ))}
            </div>
            <Reveal delay={0.24}>
              <MetadataTable items={token.metadata} />
            </Reveal>

            <Reveal delay={0.28}>
              <div className={styles.utilitySectionLabelWrap}>
                <h3 className={`serif ${styles.utilitySectionLabel}`}>{token.utilityHeading}</h3>
                <span className={styles.utilitySectionRule} aria-hidden="true" />
              </div>
            </Reveal>
            <Reveal delay={0.32}>
              <div className={`${styles.sectionBody} ${styles.utilityIntro}`}>
                <p className={styles.bodyCopy}>{token.utilityIntro}</p>
              </div>
            </Reveal>

            <div className={styles.utilityGrid}>
              {token.utilities.map((utility, index) => (
                <Reveal
                  key={utility.number}
                  delay={index * 0.06}
                  className={styles.utilityStackItem}
                  style={{ ["--utility-index" as string]: index } as CSSProperties}
                >
                  <article className={styles.utilityCard} tabIndex={0}>
                    <p className={`serif ${styles.utilityGhostNumber}`} aria-hidden="true">
                      {utility.number}
                    </p>
                    <div className={styles.utilityIconWrap}>
                      <UtilityIcon icon={utility.icon} />
                    </div>
                    <div className={styles.utilityCardContent}>
                      <h3 className={styles.utilityTitle}>{utility.title}</h3>
                      <p className={styles.utilityDescription}>{utility.description}</p>
                    </div>
                  </article>
                </Reveal>
              ))}
            </div>
            <Reveal delay={0.48}>
              <p className={styles.finePrint}>{token.utilityNote}</p>
            </Reveal>
          </section>
        ) : null}

        <section id="roadmap-phases" className={styles.sectionWide}>
          <Reveal>
            <SectionHeading eyebrow={content.roadmap.eyebrow} title={content.roadmap.title} />
          </Reveal>
          <Reveal delay={0.06}>
            <div className={styles.sectionBody}>
              <p className={styles.bodyCopy}>{content.roadmap.intro}</p>
            </div>
          </Reveal>
          <div className={styles.phaseList}>
            {content.roadmap.phases.map((phase, index) => (
              <PhaseBlock key={phase.id} phase={phase} index={index} />
            ))}
          </div>
        </section>

        <section id="out-of-scope" className={styles.section}>
          <Reveal>
            <SectionHeading eyebrow={content.outOfScope.eyebrow} title={content.outOfScope.title} />
          </Reveal>
          <Reveal delay={0.06}>
            <div className={styles.sectionBody}>
              <p className={styles.bodyCopy}>{content.outOfScope.intro}</p>
            </div>
          </Reveal>
          <div className={styles.outOfScopeList}>
            {content.outOfScope.items.map((item, index) => (
              <Reveal key={item.title} delay={index * 0.05}>
                <div className={styles.outOfScopeItem}>
                  <span className={styles.outOfScopeMark} aria-hidden="true">
                    ✕
                  </span>
                  <p className={styles.outOfScopeText}>
                    <strong>{item.title}</strong>: {item.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={0.14}>
            <p className={styles.finePrint}>{content.outOfScope.note}</p>
          </Reveal>
        </section>

        <section id="where-this-is-heading" className={styles.section}>
          <Reveal>
            <SectionHeading eyebrow={content.closing.eyebrow} title={content.closing.title} />
          </Reveal>
          <Reveal delay={0.06}>
            <div className={styles.closingQuoteWrap}>
              <p className={`serif ${styles.closingQuote}`}>
                <em>{content.closing.quote}</em>
              </p>
            </div>
          </Reveal>
          <div className={styles.sectionBody} style={{ marginTop: "1.5rem" }}>
            {content.closing.paragraphs.map((paragraph, index) => (
              <Reveal key={paragraph} delay={0.08 + index * 0.08}>
                <p className={styles.bodyCopy}>{paragraph}</p>
              </Reveal>
            ))}
          </div>
          <Reveal delay={0.18}>
            <MetadataTable items={content.closing.metadata} />
          </Reveal>
          <Reveal delay={0.24}>
            <p className={styles.finePrint}>{content.closing.disclaimer}</p>
          </Reveal>
        </section>
      </main>

    </PublicSite>
  );
}
