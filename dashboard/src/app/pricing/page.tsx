import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import ActionLinks from "@/components/public-editorial/ActionLinks";
import ComparisonTable from "@/components/public-editorial/ComparisonTable";
import TokenSurfaceGate from "@/components/public-editorial/TokenSurfaceGate";
import extras from "@/components/public-editorial/editorial-extras.module.css";
import styles from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { glossify } from "@/components/gloss/glossify";
import { ENTRY_PLAN_PRICE } from "@/lib/blog/plan-facts";
import { getTokenSurfaceView, tokenSurfacesVisible } from "@/lib/compliance/token-surface-view";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { renderLinkedText } from "./linked-text";
import page from "./pricing.module.css";
import {
  PRICES_AS_OF,
  PRICING_ACTIONS,
  PRICING_AGENTS,
  PRICING_CLOSING,
  PRICING_COMPARISON,
  PRICING_FAQ,
  PRICING_FAQ_HEADING,
  PRICING_INTRO,
  PRICING_OPTIONS,
  PRICING_PAYING,
  PRICING_REFUNDS,
  buildPricingOffers,
  formatPricesAsOf,
  visiblePricingFaq,
  type PricingFaqItem,
} from "./pricing-content";

// The finished browser title and description from the pricing rewrite. The title
// is written out here, not imported, so app/__tests__/absolute-title-metadata.test.ts
// can read it; absoluteTitle() keeps the root layout from appending " | Hivra"
// a second time. __tests__/page.test.tsx checks both against the plans' price.
const PAGE_TITLE = "Hivra Pricing | Self-host free or cloud from $9.99/month";
const PAGE_DESCRIPTION = `Run Hivra on your own infrastructure for free, or choose a managed agent computer from ${ENTRY_PLAN_PRICE}/month. Compare resources, AI costs and hosting options.`;

// /pricing states only what can be bought today (see pricing-content.ts); larger
// sizes are described as planned and never listed as available.
export const metadata: Metadata = {
  title: absoluteTitle(PAGE_TITLE),
  description: PAGE_DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/pricing", title: PAGE_TITLE, description: PAGE_DESCRIPTION }),
};

function buildPricingSchema(faq: PricingFaqItem[]) {
  return {
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
        // The same plans as the comparison table: one Offer per option (pricing-content.ts).
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#softwareapp`,
        name: "Hivra",
        applicationCategory: "DeveloperApplication",
        url: SITE_URL,
        offers: buildPricingOffers(SITE_URL),
      },
      {
        // The visible questions and answers, word for word.
        "@type": "FAQPage",
        mainEntity: faq.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };
}

// No LocaleProvider here: this page is English only (like /blog, /features,
// /agents and /tools). A provider with a forced locale would persist that
// locale into the visitor's hermes_locale cookie and localStorage on mount,
// resetting a visitor who chose another language across the whole site.
export default async function PricingPage() {
  // One decision per render: the token question, its link and the matching
  // FAQPage entry show only while the token surfaces are on and the viewer is
  // not geo-blocked. With the switch off nothing token related is read or shown.
  const view = await getTokenSurfaceView();
  const showToken = tokenSurfacesVisible(view);
  const options = PRICING_OPTIONS;

  return (
    <PublicSite className={styles.page} data-page="pricing" tokenSurfaces={showToken}>
      <StructuredData schema={buildPricingSchema(visiblePricingFaq(showToken))} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Pricing" }]} />

        <header className={styles.masthead}>
          <h1>
            A computer for your agent. <strong className={page.headlineTail}>Without the server setup.</strong>
          </h1>
          {PRICING_INTRO.map((paragraph) => (
            <p key={paragraph} className={page.introLine}>
              {paragraph}
            </p>
          ))}
        </header>

        <section className={page.firstSection} aria-labelledby="pricing-options-heading">
          <div className={page.sectionHead}>
            <h2 id="pricing-options-heading">{options.heading}</h2>
            <p>{options.pool}</p>
          </div>

          <div className={page.offers}>
            <article className={`${page.offer} ${page.offerSelf}`} aria-labelledby="offer-self-host">
              <h3 id="offer-self-host">{options.selfHost.title}</h3>
              <p className={page.price}>
                <strong>{options.selfHost.price}</strong> <span>{options.selfHost.priceNote}</span>
              </p>
              <p className={page.meta}>
                <strong>{options.selfHost.meta}</strong>
              </p>
              <p>{options.selfHost.body}</p>
              <p>{options.selfHost.goodFor}</p>
              <dl className={page.scope}>
                <div>
                  <dt>Included:</dt>
                  <dd>{options.selfHost.included}</dd>
                </div>
                <div>
                  <dt>Not included:</dt>
                  <dd>{options.selfHost.notIncluded}</dd>
                </div>
              </dl>
              <a className={page.action} href={PRICING_ACTIONS.viewSource.href} target="_blank" rel="noopener noreferrer">
                {PRICING_ACTIONS.viewSource.label}
                <ArrowUpRight size={18} aria-hidden="true" />
              </a>
            </article>

            <article className={`${page.offer} ${page.offerCloud}`} aria-labelledby="offer-hivra-cloud">
              <h3 id="offer-hivra-cloud">{options.entry.title}</h3>
              <p className={page.price}>
                <strong>{options.entry.price}</strong>
                <span>{options.entry.priceNote}</span>
              </p>
              <p className={page.meta}>
                <strong>{glossify(options.entry.meta)}</strong>
              </p>
              {options.entry.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <p>{options.entry.goodFor}</p>
              <Link className={`${page.action} ${page.actionPrimary}`} href={PRICING_ACTIONS.chooseEntry.href}>
                {PRICING_ACTIONS.chooseEntry.label}
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </article>

            <article className={`${page.offer} ${page.offerCloud}`} aria-labelledby="offer-hivra-cloud-more-room">
              <h3 id="offer-hivra-cloud-more-room">{options.larger.title}</h3>
              <p className={page.price}>
                <strong>{options.larger.price}</strong>
                <span>{options.larger.priceNote}</span>
              </p>
              <p className={page.meta}>
                <strong>{glossify(options.larger.meta)}</strong>
              </p>
              {options.larger.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <Link className={page.action} href={PRICING_ACTIONS.chooseLarger.href}>
                {PRICING_ACTIONS.chooseLarger.label}
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </article>
          </div>

          <div className={page.ownServer}>
            <div>
              <h3>{options.ownServer.title}</h3>
              <p>{options.ownServer.body}</p>
            </div>
            <Link className={page.action} href={PRICING_ACTIONS.connectServer.href}>
              {PRICING_ACTIONS.connectServer.label}
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section className={page.section} id="pricing-table" aria-labelledby="pricing-compare-heading">
          <div className={page.sectionHead}>
            <h2 id="pricing-compare-heading">{PRICING_COMPARISON.heading}</h2>
          </div>
          <ComparisonTable
            caption={PRICING_COMPARISON.caption}
            columns={PRICING_COMPARISON.columns}
            rows={PRICING_COMPARISON.rows.map((row) => ({ label: row.label, cells: row.cells }))}
          />
          <p className={page.asOf}>
            Prices as of <time dateTime={PRICES_AS_OF}>{formatPricesAsOf()}</time>.
          </p>
        </section>

        <section className={page.split} aria-labelledby="pricing-paying-heading">
          <h2 id="pricing-paying-heading">{PRICING_PAYING.heading}</h2>
          <div className={page.prose}>
            <p className={page.lede}>{PRICING_PAYING.lede}</p>
            {PRICING_PAYING.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </section>

        <section className={page.split} aria-labelledby="pricing-agents-heading">
          <h2 id="pricing-agents-heading">{PRICING_AGENTS.heading}</h2>
          <div className={page.prose}>
            <p>{PRICING_AGENTS.intro}</p>
            <ul className={page.rules}>
              {PRICING_AGENTS.items.map((item) => (
                <li key={item.name}>
                  <strong>{item.name}</strong>{" "}
                  <span>{"link" in item ? renderLinkedText(item.text, [item.link]) : item.text}</span>
                </li>
              ))}
            </ul>
            <p>{PRICING_AGENTS.outro}</p>
          </div>
        </section>

        <section className={page.split} aria-labelledby="pricing-refunds-heading">
          <h2 id="pricing-refunds-heading">{PRICING_REFUNDS.heading}</h2>
          <div className={page.prose}>
            <p className={page.callout}>
              {PRICING_REFUNDS.guarantee.before}
              <strong>{PRICING_REFUNDS.guarantee.bold}</strong>
              {PRICING_REFUNDS.guarantee.after}
              <Link href={PRICING_REFUNDS.guarantee.link.href}>{PRICING_REFUNDS.guarantee.link.text}</Link>
              {PRICING_REFUNDS.guarantee.end}
            </p>
            {PRICING_REFUNDS.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </section>

        {/* Page-local, not the shared EditorialQuestions: that component fixes its heading as
            "Common questions", and this page keeps its own. The look is the shared one. */}
        <section className={styles.questions} aria-labelledby="pricing-faq-heading">
          <h2 id="pricing-faq-heading" className={page.questionsHeading}>
            {PRICING_FAQ_HEADING}
          </h2>
          <div>
            {PRICING_FAQ.map((item) => {
              const entry = (
                <details key={item.q} open>
                  <summary>
                    {item.q}
                    <span aria-hidden="true">+</span>
                  </summary>
                  <div className={`${extras.answerNode} ${page.answer}`}>
                    <p>{renderLinkedText(item.a, item.links)}</p>
                  </div>
                </details>
              );
              return item.tokenOnly ? (
                <TokenSurfaceGate key={item.q} view={view}>
                  {entry}
                </TokenSurfaceGate>
              ) : (
                entry
              );
            })}
          </div>
        </section>

        <section className={page.closing} aria-labelledby="pricing-closing-heading">
          <div>
            <h2 id="pricing-closing-heading">{PRICING_CLOSING.heading}</h2>
            <p>{PRICING_CLOSING.body}</p>
          </div>
          <ActionLinks
            label="Get started"
            items={[
              { label: PRICING_ACTIONS.launchCloud.label, href: PRICING_ACTIONS.launchCloud.href, kind: "primary" },
              { label: PRICING_ACTIONS.selfHostFromGitHub.label, href: PRICING_ACTIONS.selfHostFromGitHub.href, kind: "secondary", external: true },
            ]}
          />
        </section>
      </main>
    </PublicSite>
  );
}
