import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { PRICING } from "./content";
import styles from "./home.module.css";
import { glossify } from "@/components/gloss/glossify";

/**
 * Three offers, free first: a free account (your own server, or self-host), then the two hosted
 * sizes. Prices never animate and the section is never hidden behind a scroll animation.
 */
export default function Pricing() {
  const { free, cloud, larger } = PRICING;
  return (
    <section id="pricing" className={styles.pricing} aria-labelledby="pricing-heading">
      <span id="hosting" className={styles.anchor} aria-hidden="true" />
      <header className={styles.sectionHead}>
        <h2 id="pricing-heading" className={styles.sectionTitle}>
          {PRICING.title} <em>{PRICING.titleTail}</em>
        </h2>
      </header>
      <div className={styles.priceGrid}>
        <article id="own-server" className={styles.priceCard} aria-labelledby="price-free">
          <h3 id="price-free" className={styles.priceName}>{free.name}</h3>
          <p className={styles.priceFigure}>
            <strong>{free.price}</strong>
            <span>{free.per}</span>
          </p>
          <p className={styles.priceSize}>{free.size}</p>
          <p className={styles.priceBody}>{glossify(free.body)}</p>
          <div className={styles.priceActions}>
            <a className={styles.primaryCta} href={free.href} data-cta="pricing-free">
              <span>{free.cta}</span>
              <ArrowRight size={18} aria-hidden="true" />
            </a>
            <a className={styles.inlineLink} href={free.selfHost.href} target="_blank" rel="noopener noreferrer" data-cta="pricing-self-host">
              {free.selfHost.label}
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
        </article>
        {[
          { offer: cloud, id: "price-cloud", cta: "pricing-cloud" },
          { offer: larger, id: "price-larger", cta: "pricing-larger" },
        ].map(({ offer, id, cta }) => (
          <article key={id} className={styles.priceCard} aria-labelledby={id}>
            <h3 id={id} className={styles.priceName}>{offer.name}</h3>
            <p className={styles.priceFigure}>
              <strong>{offer.price}</strong>
              <span>{offer.per}</span>
            </p>
            <p className={styles.priceSize}>{offer.size}</p>
            <p className={styles.priceBody}>{glossify(offer.body)}</p>
            <div className={styles.priceActions}>
              <a className={styles.textCta} href={offer.href} data-cta={cta}>
                {offer.cta}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
          </article>
        ))}
      </div>
      <div className={styles.priceNotes}>
        <p>
          {PRICING.aiUsage} {PRICING.guarantee.lead}{" "}
          <Link href={PRICING.guarantee.href}>{PRICING.guarantee.link}</Link>.{" "}
          <Link href={PRICING.full.href} data-cta="pricing-full">{PRICING.full.label}</Link>
        </p>
      </div>
    </section>
  );
}
