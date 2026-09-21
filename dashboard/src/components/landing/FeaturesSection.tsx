"use client";
import Link from "next/link";
import { ArrowUpRight, Terminal, Zap, Lock, MessageSquare, RefreshCw, Shield } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import styles from "./home.module.css";
import { HOMEPAGE_FEATURES } from "./public-home-content";
export default function FeaturesSection() {
  const { copy, locale } = useLocale();
  const section = locale.toLowerCase().startsWith("en") ? {
    eyebrow: "The workspace", titlePrefix: "A computer you can", titleEmphasis: "actually work in.", items: HOMEPAGE_FEATURES,
  } : copy.features;
  const icons = [Terminal, Zap, Lock, MessageSquare, RefreshCw, Shield];
  return <section className={`${styles.section} ${styles.featureSection}`}>
    <div className={styles.stickyHeading}><span className={styles.eyebrow}>02 / {section.eyebrow}</span><h2 aria-label={`${section.titlePrefix} ${section.titleEmphasis}`}>{section.titlePrefix}{" "}<em>{section.titleEmphasis}</em></h2><Link href="/features" className={styles.textLink}>Explore the platform <ArrowUpRight size={18} /></Link></div>
    <div className={styles.featureList}>{section.items.map(({ headline, body }, index) => { const Icon = icons[index % icons.length]; return <article key={headline}><span className={styles.featureNumber}>{String(index + 1).padStart(2,"0")}</span><div><Icon size={22} aria-hidden="true" /><h3>{headline}</h3><p>{body}</p></div></article>; })}</div>
  </section>;
}
