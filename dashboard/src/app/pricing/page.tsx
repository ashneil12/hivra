import type { Metadata } from "next";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import homeStyles from "@/components/landing/home.module.css";
import StructuredData from "@/components/StructuredData";
import PricingSection from "@/components/landing/PricingSection";
import FAQSection from "@/components/landing/FAQSection";
import { HOMEPAGE_FAQ } from "@/components/landing/public-home-content";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";

// /pricing was an indexed page on the retired site; it now shows the same
// pricing section as the homepage so the two can never disagree.
const title = "Pricing: self-host free, hosted from $9.99";
const description =
  "Self-host Hivra for free, or let Hivra run the computer from $9.99 a month. See the hosted sizes and what each one includes.";

export const metadata: Metadata = {
  title,
  description,
  ...buildWebsiteMetadata({ path: "/pricing", title, description }),
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
      mainEntity: HOMEPAGE_FAQ.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
  ],
};

// No LocaleProvider here. This page is English only (like /blog, /features,
// /agents and /tools), and FAQSection falls back to the English default
// context without one. A provider with a forced locale would persist that
// locale into the visitor's hermes_locale cookie and localStorage on mount,
// resetting a visitor who chose another language across the whole site.
export default function PricingPage() {
  return (
    <PublicSite className={styles.page} data-page="pricing">
      <StructuredData schema={pricingSchema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Pricing" }]} />
        {/* The pricing section below draws its own top rule; drop the masthead's
            so the two don't stack into an empty band. */}
        <header className={styles.masthead} style={{ borderBottom: "none", marginBottom: 0 }}>
          <span className={styles.eyebrow}>Pricing</span>
          <h1>
            Hivra <strong>pricing.</strong>
          </h1>
          <p>The platform is free to self-host. Pay only if you want Hivra to run the computer for you.</p>
        </header>
        <div className={homeStyles.pricingWrap}>
          <PricingSection />
        </div>
        <FAQSection />
      </main>
    </PublicSite>
  );
}
