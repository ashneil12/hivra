import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { PRICING } from "./content";
import styles from "./home.module.css";
import { glossify } from "@/components/gloss/glossify";

/**
 * What can be bought today: two hosted sizes, a server you already rent, and
 * the open source platform itself. One default (the first card). Prices never
 * animate and the section is never hidden behind a scroll animation.
 */
export default function Pricing() {
  const { cloud, larger, server, selfHost } = PRICING;
  return (
    <section id="pricing" className={styles.pricing} aria-labelledby="pricing-heading">
      <span id="hosting" className={styles.anchor} aria-hidden="true" />
      <header className={styles.sectionHead}>
        <span className={styles.eyebrow} aria-hidden="true" />
        <h2 id="pricing-heading" className={styles.sectionTitle}>
          {PRICING.title} <em>{PRICING.titleTail}</em>
        </h2>
      </header>
      <div className={styles.priceGrid}>
        <article className={`${styles.priceCard} ${styles.priceCloud}`} aria-labelledby="price-cloud">
          <span className={styles.priceGlow} aria-hidden="true" />
          <div className={styles.priceTop}>
            <h3 id="price-cloud">{cloud.name}</h3>
          </div>
          <p className={styles.priceFigure}>
            <strong>{cloud.price}</strong>
            <span>{cloud.per}</span>
          </p>
          <p className={styles.priceSize}>{cloud.size}</p>
          <p className={styles.priceBody}>{glossify(cloud.body)}</p>
          <a className={styles.primaryCta} href={cloud.href} data-cta="pricing-cloud">
            <span>{cloud.cta}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </article>
        <article className={`${styles.priceCard} ${styles.priceLarger}`} aria-labelledby="price-larger">
          <div className={styles.priceTop}>
            <h3 id="price-larger">{larger.name}</h3>
          </div>
          <p className={styles.priceFigure}>
            <strong>{larger.price}</strong>
            <span>{larger.per}</span>
          </p>
          <p className={styles.priceSize}>{larger.size}</p>
          <p className={styles.priceBody}>{glossify(larger.body)}</p>
          <a className={styles.outlineCta} href={larger.href} data-cta="pricing-larger">
            <span>{larger.cta}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </article>
        <article id="own-server" className={`${styles.priceCard} ${styles.priceSide}`} aria-labelledby="price-server">
          <div className={styles.priceTop}>
            <h3 id="price-server">{server.name}</h3>
          </div>
          <p className={styles.priceBody}>{glossify(server.body)}</p>
          <a href={server.href} className={styles.textCta} data-cta="pricing-server">
            {server.cta}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </article>
        <article className={`${styles.priceCard} ${styles.priceSide}`} aria-labelledby="price-self">
          <div className={styles.priceTop}>
            <h3 id="price-self">{selfHost.name}</h3>
          </div>
          <p className={styles.priceFigure} data-small="">
            <strong>{selfHost.price}</strong>
            <span>{selfHost.per}</span>
          </p>
          <p className={styles.priceBody}>{glossify(selfHost.body)}</p>
          <a href={selfHost.href} className={styles.textCta} target="_blank" rel="noopener noreferrer" data-cta="pricing-self-host">
            {selfHost.cta}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </article>
      </div>
      <div className={styles.priceNotes}>
        <p>
          {PRICING.aiUsage} {PRICING.guarantee.lead}{" "}
          <Link href={PRICING.guarantee.href}>{PRICING.guarantee.link}</Link>.
        </p>
        <Link href={PRICING.full.href} className={styles.textCta} data-cta="pricing-full">
          {PRICING.full.label}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
