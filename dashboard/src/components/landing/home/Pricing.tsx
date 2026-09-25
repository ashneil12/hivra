import { ArrowRight, ArrowUpRight } from "lucide-react";
import { PRICING } from "./content";
import styles from "./home.module.css";

/**
 * What can be bought today, with one default. Prices never animate and the
 * section is never hidden behind a scroll animation.
 */
export default function Pricing() {
  const { cloud, server, selfHost } = PRICING;
  return (
    <section id="pricing" className={styles.pricing} aria-labelledby="pricing-heading">
      <span id="hosting" className={styles.anchor} aria-hidden="true" />
      <header className={styles.sectionHead}>
        <span className={styles.eyebrow}>{PRICING.eyebrow}</span>
        <h2 id="pricing-heading" className={styles.sectionTitle}>
          {PRICING.title} <em>{PRICING.titleTail}</em>
        </h2>
        <p className={styles.bodyText}>{PRICING.subhead}</p>
      </header>
      <div className={styles.priceGrid}>
        <article className={`${styles.priceCard} ${styles.priceCloud}`} aria-labelledby="price-cloud">
          <span className={styles.priceGlow} aria-hidden="true" />
          <div className={styles.priceTop}>
            <h3 id="price-cloud">{cloud.name}</h3>
            <span className={styles.priceMarker}>{cloud.marker}</span>
          </div>
          <p className={styles.priceFigure}>
            <strong>{cloud.price}</strong>
            <span>a month</span>
          </p>
          <p className={styles.priceSize}>{cloud.size}</p>
          <p className={styles.priceBody}>{cloud.body}</p>
          <a className={styles.primaryCta} href={cloud.href} data-cta="pricing-cloud">
            <span>{cloud.cta}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </a>
          <p className={styles.guarantee}>{cloud.guarantee}</p>
          <div className={styles.priceMore}>
            <p>{cloud.more}</p>
            <a href={cloud.moreHref} className={styles.textCta} data-cta="pricing-larger">
              {cloud.moreCta}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </article>
        <article id="own-server" className={`${styles.priceCard} ${styles.priceSide}`} aria-labelledby="price-server">
          <div className={styles.priceTop}>
            <h3 id="price-server">{server.name}</h3>
            <span className={styles.priceChip}>{server.chip}</span>
          </div>
          <p className={styles.priceBody}>{server.body}</p>
          <a href={server.href} className={styles.textCta} data-cta="pricing-server">
            {server.cta}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </article>
        <article className={`${styles.priceCard} ${styles.priceSide}`} aria-labelledby="price-self">
          <div className={styles.priceTop}>
            <h3 id="price-self">{selfHost.name}</h3>
            <span className={styles.priceChip}>{selfHost.chip}</span>
          </div>
          <p className={styles.priceFigure} data-small="">
            <strong>{selfHost.price}</strong>
          </p>
          <p className={styles.priceBody}>{selfHost.body}</p>
          <a href={selfHost.href} className={styles.textCta} target="_blank" rel="noopener noreferrer" data-cta="pricing-self-host">
            {selfHost.cta}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </article>
      </div>
      <p className={styles.priceFoot}>{PRICING.footnote}</p>
    </section>
  );
}
