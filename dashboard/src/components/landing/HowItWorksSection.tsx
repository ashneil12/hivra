"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import styles from "./home.module.css";
import refresh from "./copy-refresh.module.css";
import { HOMEPAGE_STEPS } from "./public-home-content";
export default function HowItWorksSection() {
  const { copy, locale } = useLocale();
  const english = locale.toLowerCase().startsWith("en");
  const section = english ? {
    eyebrow: "The launch", titlePrefix: "Start with an agent.", titleEmphasis: "Or a computer.", steps: HOMEPAGE_STEPS,
    footer: "Sometimes you know which agent you want. Sometimes you just need another computer. Start from either.", cta: "Choose your starting point",
  } : copy.howItWorks;
  return <section id="how-it-works" className={`${styles.section} ${styles.stepsSection}`}>
    <div className={styles.sectionHeading}><span className={styles.eyebrow}>04 / {section.eyebrow}</span><h2>{section.titlePrefix} <em>{section.titleEmphasis}</em></h2></div>
    <div className={`${styles.steps} ${english ? refresh.fourSteps : ""}`}>{section.steps.map(({ step, headline, body }) => <article key={step}><span className={styles.stepNumber}>{String(step).padStart(2,"0")}</span><h3>{headline}</h3><p>{body}</p></article>)}</div>
    <div className={styles.sectionEnding}><p>{section.footer}</p><Link href={english ? "/dashboard/launch?start=1" : "/get-started?plan=free"} className={styles.textLink}>{section.cta}<ArrowRight size={18} /></Link></div>
  </section>;
}
