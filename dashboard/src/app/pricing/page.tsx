import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialQuestions } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import homeStyles from "@/components/landing/home.module.css";
import cardStyles from "@/components/landing/pricing.module.css";
import StructuredData from "@/components/StructuredData";
import { MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import pageStyles from "./pricing.module.css";
import {
  HOSTED_SIZES,
  PRICING_DESCRIPTION,
  PRICING_FAQ,
  PRICING_TITLE,
  SELF_HOST_SOURCE_URL,
} from "./pricing-content";

// /pricing was an indexed page on the retired site. It states only what can be
// bought today (see pricing-content.ts); the proposed ladder stays a labelled
// preview on the homepage.
export const metadata: Metadata = {
  title: PRICING_TITLE,
  description: PRICING_DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/pricing", title: PRICING_TITLE, description: PRICING_DESCRIPTION }),
};

const pricingSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Pricing", item: `${SITE_URL}/pricing` },
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: PRICING_FAQ.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
  ],
};

// No LocaleProvider here: this page is English only (like /blog, /features,
// /agents and /tools). A provider with a forced locale would persist that
// locale into the visitor's hermes_locale cookie and localStorage on mount,
// resetting a visitor who chose another language across the whole site.
export default function PricingPage() {
  return (
    <PublicSite className={styles.page} data-page="pricing">
      <StructuredData schema={pricingSchema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Pricing" }]} />
        {/* The section below draws its own top rule; drop the masthead's so the
            two don't stack into an empty band. */}
        <header className={styles.masthead} style={{ borderBottom: "none", marginBottom: 0 }}>
          <span className={styles.eyebrow}>Pricing</span>
          <h1>
            Hivra <strong>pricing.</strong>
          </h1>
          <p>The platform is free to self-host. Pay only if you want Hivra to run the computer for you.</p>
        </header>
        <div className={homeStyles.pricingWrap}>
          <section className={`${cardStyles.pricing} ${pageStyles.section}`} aria-labelledby="pricing-today-heading">
            <header className={cardStyles.heading}>
              <h2 id="pricing-today-heading">What you can buy today.</h2>
              <p>Prices are in US dollars, per month. Each plan is a pool of CPU and memory for your agents&apos; computers.</p>
            </header>
            <div className={`${cardStyles.ladder} ${pageStyles.sizes}`}>
              <article className={`${cardStyles.machine} ${cardStyles.freeMachine}`} aria-labelledby="size-self-host">
                <div className={cardStyles.machineTop}>
                  <h3 id="size-self-host">Self-host</h3>
                  <span>Your server</span>
                </div>
                <p className={cardStyles.machinePrice}>
                  <strong>$0</strong>
                  <span>software</span>
                </p>
                <p className={cardStyles.description}>
                  Run Hivra on your own server. The source is public under the Apache-2.0 license, and self-hosting is a
                  preview for a single operator.
                </p>
                <p className={cardStyles.freeCosts}>You provide and maintain the server. Server and model usage are paid separately.</p>
                <a className={cardStyles.action} href={SELF_HOST_SOURCE_URL} target="_blank" rel="noopener noreferrer">
                  See the source on GitHub
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
              </article>
              {HOSTED_SIZES.map((size) => (
                <article key={size.planKey} className={cardStyles.machine} aria-labelledby={`size-${size.planKey}`}>
                  <div className={cardStyles.machineTop}>
                    <h3 id={`size-${size.planKey}`}>
                      {size.cpu} vCPU, {size.ramGb} GB
                    </h3>
                    <span>Hivra Cloud</span>
                  </div>
                  <p className={cardStyles.machinePrice}>
                    <strong>{size.price}</strong>
                    <span className={pageStyles.priceFor}>
                      a month for {size.cpu} vCPU and {size.ramGb} GB of RAM
                    </span>
                  </p>
                  <p className={cardStyles.description}>{size.body}</p>
                  <Link className={cardStyles.action} href={size.href}>
                    Choose {size.cpu} vCPU and {size.ramGb} GB
                    <ArrowRight size={18} aria-hidden="true" />
                  </Link>
                </article>
              ))}
            </div>
            <div className={cardStyles.notes}>
              <p>
                {MONEY_BACK_GUARANTEE}. Bring your own model key or login; that usage is billed by your model provider.
              </p>
              <p>
                Larger sizes are planned. The proposed sizes are in the <Link href="/#pricing">pricing preview</Link>.
              </p>
            </div>
          </section>
        </div>
        <EditorialQuestions questions={PRICING_FAQ} />
      </main>
    </PublicSite>
  );
}
