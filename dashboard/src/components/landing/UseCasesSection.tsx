"use client";
import Link from "next/link";
import { ArrowRight, Terminal, Brain, Clock, Server } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import styles from "./home.module.css";
import { HOMEPAGE_USE_CASES } from "./public-home-content";
import { PUBLIC_START_HREF } from "@/lib/public-start";
export default function UseCasesSection() {
  const { copy, locale } = useLocale();
  const english = locale.toLowerCase().startsWith("en");
  const section = english ? {
    eyebrow: "Make room for the work", titlePrefix: "Another computer.", titleEmphasis: "Plenty of reasons.",
    intro: "Set up a workspace for one project, one application or one agent. Keep it separate from the rest of your day.", items: HOMEPAGE_USE_CASES,
    footer: "A computer runs fine without an agent. Launch an agent and it gets a computer of its own.", cta: "Choose a computer",
  } : copy.useCases;
  const icons = [Terminal, Brain, Clock, Server];
  return <section id="use-cases" className={`${styles.section} ${styles.useSection}`}>
    <div className={styles.sectionHeading}><span className={styles.eyebrow}>05 / {section.eyebrow}</span><h2>{section.titlePrefix} <em>{section.titleEmphasis}</em></h2><p>{section.intro}</p></div>
    <div className={styles.useCases}>{section.items.map(({ headline, body }, index) => { const Icon = icons[index % icons.length]; return <article key={headline}><Icon size={28} /><span className={styles.useNumber}>{String(index + 1).padStart(2,"0")}</span><h3>{headline}</h3><p>{body}</p></article>; })}</div>
    <div className={styles.sectionEnding}><p>{section.footer}</p><Link href={english ? "#computers" : PUBLIC_START_HREF} className={styles.textLink}>{section.cta}<ArrowRight size={18} /></Link></div>
  </section>;
}
