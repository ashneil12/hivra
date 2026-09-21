"use client";
import { Plus } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import styles from "./home.module.css";
import { HOMEPAGE_FAQ } from "./public-home-content";
export default function FAQSection() {
  const { copy, locale } = useLocale();
  const questions = locale.toLowerCase().startsWith("en") ? HOMEPAGE_FAQ : copy.faq.items;
  return <section id="faq" className={`${styles.section} ${styles.faqSection}`}>
    <div className={styles.stickyHeading}><span className={styles.eyebrow}>08 / {copy.faq.eyebrow}</span><h2>{copy.faq.title}</h2></div>
    <div className={styles.faqList}>{questions.map(({ q, a }, index) => <details key={q} open={index === 0}><summary><h3>{q}</h3><Plus size={20} aria-hidden="true" /></summary><p>{a}</p></details>)}</div>
  </section>;
}
