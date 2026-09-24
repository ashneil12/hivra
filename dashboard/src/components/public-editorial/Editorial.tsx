import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import styles from "./secondary-site.module.css";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export function EditorialMarkdownLink({ href, ...props }: ComponentProps<"a">) {
  let external = false;
  try {
    const url = new URL(href ?? "", "https://hivra.cloud");
    external = /^https?:$/.test(url.protocol) && url.origin !== "https://hivra.cloud";
  } catch {
    // Markdown sanitization still owns invalid destinations.
  }
  return <a {...props} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} />;
}

export function EditorialArt({ number = "01", label = "Hivra" }: { number?: string; label?: string }) {
  return <div className={styles.art} aria-hidden="true"><span className={styles.artLabel}>{label}</span><span className={styles.artNumber}>{number}</span><div className={styles.artLines}><i /><i /><i /><i /><i /></div><ArrowDownRight className={styles.artArrow} strokeWidth={0.8} /></div>;
}

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><Link href="/">Home</Link>{items.map((item, index) => <span key={`${item.label}-${index}`}><span aria-hidden="true">/</span>{item.href ? <Link href={item.href}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}</span>)}</nav>;
}

export function EditorialCTA({ title, label = "Start Now" }: { title?: ReactNode; label?: string }) {
  return <section className={styles.cta}><div><h2>{title ?? <>Give your agent a computer <strong>that stays on.</strong></>}</h2><p>From $9.99/mo. BYO AI key. 7-day money-back guarantee on card payments.</p></div><Link href={PUBLIC_START_HREF} className={styles.button}>{label}<ArrowUpRight size={20} aria-hidden="true" /></Link></section>;
}

export function EditorialQuestions({ questions }: { questions: { q: string; a: string }[] }) {
  if (!questions.length) return null;
  return <section className={styles.questions}><h2>Common questions</h2><div>{questions.map(({ q, a }) => <details key={q} open><summary>{q}<span aria-hidden="true">+</span></summary><p>{a}</p></details>)}</div></section>;
}

export function EditorialRelated({ title = "Related", links }: { title?: string; links: { label: string; href: string }[] }) {
  return <section className={styles.related}><h2>{title}</h2><div>{links.map(({ label, href }) => <Link key={`${href}-${label}`} href={href}><span>{label}</span><ArrowUpRight size={20} aria-hidden="true" /></Link>)}</div></section>;
}
