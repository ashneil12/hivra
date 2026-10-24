import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import ActionLinks from "@/components/public-editorial/ActionLinks";
import StructuredData from "@/components/StructuredData";
import type { Metadata } from "next";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import {
  DIRECTORY_BREADCRUMB_LABEL,
  DIRECTORY_EYEBROW,
  DIRECTORY_FAQS,
  DIRECTORY_H1,
  DIRECTORY_ITEMS,
  DIRECTORY_ITEMS_HEADING,
  DIRECTORY_LEAD,
  DIRECTORY_PRICE,
} from "./_content/directory";
import { FeatureFaq } from "./_components/FeatureFaq";
import { plainText, renderInline } from "./_components/Inline";
import styles from "../../components/public-editorial/secondary-site.module.css";
import local from "./features.module.css";

const TITLE = "Hivra Features | Persistent AI Agent Hosting";
const DESCRIPTION =
  "Explore Hivra's managed AI agent hosting: persistent memory, cloud browsers, scheduled tasks, multiple agents and simple deployment without Docker.";

// The copy supplies the finished browser title, so the root template adds no brand after it.
export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({
    path: "/features",
    title: TITLE,
    description: DESCRIPTION,
  }),
};

const schema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: DIRECTORY_BREADCRUMB_LABEL, item: `${SITE_URL}/features` },
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: DIRECTORY_FAQS.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: plainText(a) },
      })),
    },
  ],
};

export default function FeaturesPage() {
  return (
    <PublicSite className={styles.page} data-page="features">
      <StructuredData schema={schema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: DIRECTORY_BREADCRUMB_LABEL }]} />
        <header className={`${styles.masthead} ${local.masthead}`}>
          <span className={`${styles.eyebrow} ${local.eyebrow}`}>{DIRECTORY_EYEBROW}</span>
          <h1>{DIRECTORY_H1}</h1>
        </header>

        <section className={`${local.introBand} ${local.split}`}>
          <h2>{DIRECTORY_LEAD.heading}</h2>
          <div className={local.prose}>
            {DIRECTORY_LEAD.paragraphs.map((paragraph) => (
              <p key={paragraph}>{renderInline(paragraph)}</p>
            ))}
            <ActionLinks items={DIRECTORY_LEAD.actions} />
          </div>
        </section>

        <section aria-labelledby="six-things">
          <div className={local.sectionHead}>
            <h2 id="six-things">{DIRECTORY_ITEMS_HEADING}</h2>
          </div>
          <ol className={local.index}>
            {DIRECTORY_ITEMS.map((item) => (
              <li key={item.title} className={`${local.item} ${local.split}`}>
                <h3>
                  <span className={local.itemNumber}>{item.number}</span> {item.title}
                </h3>
                <div className={local.prose}>
                  {item.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{renderInline(paragraph)}</p>
                  ))}
                  <ActionLinks items={[{ label: item.link.label, href: item.link.href, kind: "secondary" }]} />
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className={`${local.panel} ${local.split}`}>
          <h2>{DIRECTORY_PRICE.heading}</h2>
          <div className={local.prose}>
            {DIRECTORY_PRICE.paragraphs.map((paragraph) => (
              <p key={paragraph}>{renderInline(paragraph)}</p>
            ))}
            <ActionLinks items={DIRECTORY_PRICE.actions} />
          </div>
        </section>

        <div className={local.faqSplit}>
          <FeatureFaq faqs={DIRECTORY_FAQS} />
        </div>
      </main>
    </PublicSite>
  );
}
