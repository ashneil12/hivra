import { ArrowRight } from "lucide-react";
import { PRICING } from "./content";
import styles from "./home.module.css";
import { glossify } from "@/components/gloss/glossify";

/**
 * Three offers, hosted first: the two Hivra Cloud sizes, then your own server,
 * which has no Hivra hosting charge. Prices never animate and the section is
 * never hidden behind a scroll animation.
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
        {PRICING.lead.map(text => <p key={text} className={styles.bodyText}>{text}</p>)}
      </header>
      <div className={styles.priceGrid}>
        <article className={styles.priceCard} aria-labelledby="price-cloud">
          <h3 id="price-cloud" className={styles.priceName}>{cloud.name}</h3>
          <p className={styles.priceTagline}>{cloud.tagline}</p>
          <p className={styles.priceFigure}>
            <strong>{cloud.price}</strong>
            <span>{cloud.per}</span>
          </p>
          <p className={styles.priceSize}>{cloud.size}</p>
          {cloud.body.map(text => <p key={text} className={styles.priceBody}>{glossify(text)}</p>)}
          <div className={styles.priceActions}>
            <a className={styles.primaryCta} href={cloud.href} data-cta="pricing-cloud">
              <span>{cloud.cta}</span>
              <ArrowRight size={18} aria-hidden="true" />
            </a>
          </div>
          <p className={styles.priceNote}>{cloud.note}</p>
        </article>
        <article className={styles.priceCard} aria-labelledby="price-larger">
          <h3 id="price-larger" className={styles.priceName}>{larger.name}</h3>
          <p className={styles.priceTagline}>{larger.tagline}</p>
          <p className={styles.priceFigure}>
            <strong>{larger.price}</strong>
            <span>{larger.per}</span>
          </p>
          <p className={styles.priceSize}>{larger.size}</p>
          {larger.body.map(text => <p key={text} className={styles.priceBody}>{glossify(text)}</p>)}
          <div className={styles.priceActions}>
            <a className={styles.textCta} href={larger.href} data-cta="pricing-larger">
              {larger.cta}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </article>
        <article id="own-server" className={styles.priceCard} aria-labelledby="price-free">
          <h3 id="price-free" className={styles.priceName}>{free.name}</h3>
          <p className={styles.priceTagline}>{free.tagline}</p>
          {free.body.map(text => <p key={text} className={styles.priceBody}>{glossify(text)}</p>)}
          <div className={styles.priceActions}>
            <a className={styles.textCta} href={free.href} data-cta="pricing-free">
              {free.cta}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </article>
      </div>
    </section>
  );
}
