"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { HOMEPAGE_UPCOMING } from "./public-home-content";
import styles from "./home.module.css";
import refresh from "./copy-refresh.module.css";

export default function WhatsComingSection() {
  const { copy, locale } = useLocale();
  const english = locale.toLowerCase().startsWith("en");
  const section = copy.whatsComing;
  const items = HOMEPAGE_UPCOMING;
  return <section id="whats-coming" className={styles.section}>
    <div className={styles.sectionHeading}>
      <span className={styles.eyebrow}>{english ? "What we're building next" : section.eyebrow}</span>
      <h2>{english ? <>More room to work.</> : <>{section.titlePrefix} <em>{section.titleEmphasis}</em></>}</h2>
      {!english && <p>{section.intro}</p>}
    </div>
    <div className={refresh.upcoming}>{items.map(({ title, body, stage }) => <article key={title}>
      <span>{stage}</span><h3>{title}</h3><p>{body}</p>
    </article>)}</div>
    <p className={refresh.upcomingNote}>{english ? "The longer plan, including Gate, Exchange, Arena and Signal, is in the litepaper." : section.footer}</p>
    <div className={styles.sectionEnding}><Link href="/roadmap" className={styles.textLink}>Follow the roadmap<ArrowRight size={18} aria-hidden="true" /></Link><a href="/docs/litepaper/index.html#future" target="_blank" rel="noopener noreferrer" className={styles.textLink}>Explore the full plan<ArrowRight size={18} aria-hidden="true" /></a></div>
  </section>;
}
