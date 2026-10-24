import Link from "next/link";
import { ArrowRight } from "lucide-react";
import PublicSite from "@/components/public-site/PublicSite";
import StructuredData from "@/components/StructuredData";
import { Breadcrumbs, EditorialQuestions, EditorialRelated } from "@/components/public-editorial/Editorial";
import ArticleNavigation from "@/components/public-editorial/ArticleNavigation.client";
import ActionLinks from "@/components/public-editorial/ActionLinks";
import ComparisonTable from "@/components/public-editorial/ComparisonTable";
import { COMPETITOR_FACTS_CHECKED, PRICE_TABLE, formatCheckedMonth } from "@/lib/compare/competitor-facts";
import { SITE_URL } from "@/lib/seo-urls";
import type { CompareBlock, CompareSection, CompareSources, ComparePage } from "@/lib/compare/types";
import styles from "../../components/public-editorial/secondary-site.module.css";
import compare from "./compare.module.css";
import Inline from "./Inline";

const GLANCE_COLUMNS = [{ label: "Hivra" }, { label: "Alternative" }];
const PRICE_COLUMNS = ["Price for the size", "Billing and what it leaves out", "Source"];

function PriceTable({ caption }: { caption: string }) {
  // The wrapper only exists for the stylesheet: on a phone this table's long column labels stack above their values.
  return (
    <div className={compare.priceTable}>
      <ComparisonTable
        caption={caption}
        rowHeading="Provider"
        columns={PRICE_COLUMNS}
        rows={PRICE_TABLE.map(({ provider, price, terms, source }) => ({
          label: provider,
          cells: [
            price,
            terms,
            source.href.startsWith("/") ? (
              <Link href={source.href}>{source.label}</Link>
            ) : (
              <a href={source.href} rel="noopener noreferrer">
                {source.label}
              </a>
            ),
          ],
        }))}
      />
    </div>
  );
}

function Block({ block }: { block: CompareBlock }) {
  switch (block.kind) {
    case "p":
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case "entries":
      return (
        <div className={compare.entries}>
          {block.items.map(({ lead, text }) => (
            <div key={lead} className={compare.entry}>
              <p>
                <strong>{lead}</strong> <Inline text={text} />
              </p>
            </div>
          ))}
        </div>
      );
    case "steps":
      return (
        <ol className={compare.steps} role="list">
          {block.items.map(({ lead, text }) => (
            <li key={lead}>
              <p>
                <strong>{lead}</strong> <Inline text={text} />
              </p>
            </li>
          ))}
        </ol>
      );
    case "providers":
      return (
        <ol className={compare.providers} role="list">
          {block.items.map(({ slug, label, text }) => (
            <li key={slug}>
              <p>
                <Link href={`/compare/${slug}`}>{label}</Link>
                {/* The copy's colon stays in the text; the row sets the name above its description, so the colon is not drawn. */}
                <span className={compare.colon}>: </span>
                {text}
              </p>
              <ArrowRight size={20} aria-hidden="true" />
            </li>
          ))}
        </ol>
      );
    case "glance":
      return (
        <ComparisonTable
          caption={block.caption}
          rowHeading="Criterion"
          columns={GLANCE_COLUMNS}
          highlight={0}
          rows={block.rows.map((row) => ({
            label: row.criterion,
            cells: [<Inline key="hivra" text={row.hivra} />, <Inline key="alternative" text={row.alternative} />],
          }))}
        />
      );
    case "priceTable":
      return <PriceTable caption={block.caption} />;
  }
}

function sectionClass(section: CompareSection): string | undefined {
  if (section.tone === "lede") return compare.lede;
  if (section.tone === "callout") return compare.callout;
  if (section.tone === "note") return compare.note;
  return undefined;
}

/** The month in the sources paragraph is wrapped in a machine readable <time>. */
function SourcesIntro({ text }: { text: string }) {
  const month = formatCheckedMonth();
  const at = text.indexOf(month);
  if (at < 0) return <Inline text={text} />;
  return (
    <>
      <Inline text={text.slice(0, at)} />
      <time dateTime={COMPETITOR_FACTS_CHECKED}>{month}</time>
      <Inline text={text.slice(at + month.length)} />
    </>
  );
}

function Sources({ sources }: { sources: CompareSources }) {
  return (
    <section id="fact-sources" aria-labelledby="fact-sources-heading">
      <h2 id="fact-sources-heading">{sources.heading ?? "Where these numbers come from"}</h2>
      <p>
        <SourcesIntro text={sources.intro} />
      </p>
      {sources.notes?.map((note) => (
        <p key={note}>
          <Inline text={note} />
        </p>
      ))}
      <ul className={compare.sourceList}>
        {sources.links.map(({ label, href }) => (
          <li key={href}>
            <a href={href} rel="noopener noreferrer">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface CompareArticleProps {
  page: ComparePage;
  /** "detail": a /compare/[slug] page. "directory": the /compare page itself. */
  variant: "detail" | "directory";
}

/**
 * One layout for the ten comparison pages: a plain masthead, the on-page contents beside a reading
 * column, then the closing row. The copy is data (lib/compare); this component only lays it out.
 */
export default function CompareArticle({ page, variant }: CompareArticleProps) {
  const detail = variant === "detail";
  const pageUrl = detail ? `${SITE_URL}/compare/${page.slug}` : `${SITE_URL}/compare`;

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Compare", item: `${SITE_URL}/compare` },
          ...(detail ? [{ "@type": "ListItem", position: 3, name: page.h1, item: pageUrl }] : []),
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: page.faqs.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };

  const contents = [
    ...page.sections.map((section, index) => ({ id: `section-${index + 1}`, label: section.heading })),
    ...(page.sources ? [{ id: "fact-sources", label: page.sources.heading ?? "Where these numbers come from" }] : []),
    { id: "questions", label: "Common questions" },
  ];

  const closingLinks = page.closing.links.map(({ label, href, kind }) => ({ label, href, kind }));

  return (
    <PublicSite className={styles.page} data-page={detail ? "compare-detail" : "compare"}>
      <StructuredData schema={schema} />
      <main className={`${styles.main} ${compare.main}`} id="main-content">
        <div className={detail ? compare.crumbsKeep : undefined}>
          <Breadcrumbs items={detail ? [{ label: "Compare", href: "/compare" }] : [{ label: "Compare" }]} />
        </div>
        <header className={compare.masthead}>
          <h1>{page.h1}</h1>
        </header>
        <div className={styles.articleLayout}>
          <ArticleNavigation items={contents} />
          <div className={`${styles.articleBody} ${compare.body}`}>
            {page.sections.map((section, index) => (
              <section key={section.heading} id={`section-${index + 1}`} className={sectionClass(section)}>
                <h2>{section.heading}</h2>
                {section.blocks.map((block, blockIndex) => (
                  <Block key={blockIndex} block={block} />
                ))}
              </section>
            ))}
            {page.sources ? <Sources sources={page.sources} /> : null}
            <div id="questions" className={compare.questions}>
              <EditorialQuestions questions={page.faqs} />
            </div>
          </div>
        </div>
        <section className={compare.closing} aria-labelledby="closing-heading">
          <div>
            <h2 id="closing-heading">{page.closing.heading}</h2>
            <p>
              <Inline text={page.closing.text} />
            </p>
          </div>
          <ActionLinks items={closingLinks} />
        </section>
        {page.related.length ? (
          <div className={compare.related}>
            <EditorialRelated links={page.related} />
          </div>
        ) : null}
      </main>
    </PublicSite>
  );
}
