import type { Metadata } from "next";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialQuestions, type EditorialQuestion } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { getTokenSurfaceView, tokenSurfacesVisible } from "@/lib/compliance/token-surface-view";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { ABOUT_DESCRIPTION, ABOUT_TITLE, buildAboutContent, type AboutContent } from "./about-content";
import about from "./about.module.css";
import { Inline } from "./inline";

// /about was a 308 to the founder essay, then the entity home. It is now the
// owner's rewritten page: who and what Hivra is, the former name, what it does
// today, what it is not, what it costs, where it is going and how to check and
// reach it. The copy is in about-content.ts. The title is the owner's finished
// browser title, so it skips the layout's " | Hivra" suffix (absoluteTitle).
export const metadata: Metadata = {
  title: absoluteTitle(ABOUT_TITLE),
  description: ABOUT_DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/about", title: ABOUT_TITLE, description: ABOUT_DESCRIPTION }),
};

function aboutSchema(content: AboutContent) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "About", item: `${SITE_URL}/about` },
        ],
      },
      {
        // The Organization node itself lives on the homepage; this page points at it.
        "@type": "AboutPage",
        "@id": `${SITE_URL}/about#webpage`,
        url: `${SITE_URL}/about`,
        name: ABOUT_TITLE,
        description: ABOUT_DESCRIPTION,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        about: { "@id": `${SITE_URL}/#organization` },
        mainEntity: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "FAQPage",
        mainEntity: content.faq.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };
}

function Prose({ paragraphs, gloss = false }: { paragraphs: readonly string[]; gloss?: boolean }) {
  return (
    <div className={about.prose}>
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>
          <Inline text={paragraph} gloss={gloss} />
        </p>
      ))}
    </div>
  );
}

export default async function AboutPage() {
  // Every sentence about a token renders only when the token surfaces are on and
  // this viewer is not geo-blocked; the same decision shapes the FAQ markup below.
  const view = await getTokenSurfaceView();
  const content = buildAboutContent({ tokens: tokenSurfacesVisible(view) });
  const { headings } = content;

  const questions: EditorialQuestion[] = content.faq.map(({ q, a, markup }) => ({
    q,
    a,
    ...(markup ? { node: <p><Inline text={markup} /></p> } : {}),
  }));

  return (
    <PublicSite className={styles.page} data-page="about" tokenSurfaces={tokenSurfacesVisible(view)}>
      <StructuredData schema={aboutSchema(content)} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "About" }]} />
        <header className={`${styles.masthead} ${about.mastheadGrid}`}>
          <h1>
            About <strong>Hivra</strong>
          </h1>
          <p>
            <Inline text={content.intro.lead} gloss />
          </p>
          <div className={about.mastheadMore}>
            {content.intro.more.map((paragraph) => (
              <p key={paragraph}>
                <Inline text={paragraph} gloss />
              </p>
            ))}
          </div>
        </header>

        <div className={about.sections}>
          <section className={about.row} aria-labelledby="about-origin">
            <h2 id="about-origin">{headings.origin}</h2>
            <Prose paragraphs={content.origin} />
          </section>

          <section className={about.wide} aria-labelledby="about-today">
            <h2 id="about-today">{headings.today}</h2>
            <dl className={about.ledger}>
              {content.today.map((item) => (
                <div className={about.ledgerRow} key={item.lead}>
                  <dt>{item.lead}</dt>
                  <dd>
                    <Inline text={item.text} gloss />
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className={about.wide} aria-labelledby="about-is-not">
            <h2 id="about-is-not">{headings.isNot}</h2>
            <div className={about.statements}>
              {content.isNot.map((item) => (
                <p className={about.statement} key={item.lead}>
                  <strong>{item.lead}</strong> <Inline text={item.text} />
                </p>
              ))}
            </div>
          </section>

          <section className={about.row} aria-labelledby="about-open-source">
            <h2 id="about-open-source">{headings.openSource}</h2>
            <Prose paragraphs={content.openSource} />
          </section>

          <section className={about.row} aria-labelledby="about-costs">
            <h2 id="about-costs">{headings.costs}</h2>
            <Prose paragraphs={content.costs} />
          </section>

          <section className={about.row} aria-labelledby="about-going">
            <h2 id="about-going">{headings.going}</h2>
            <div className={about.prose}>
              <p>
                <Inline text={content.going.intro} />
              </p>
              <p className={about.planned}>
                <Inline text={content.going.planned} />
              </p>
              <p>
                <Inline text={content.going.closing} />
              </p>
            </div>
          </section>

          <section className={about.row} aria-labelledby="about-builder">
            <h2 id="about-builder">{headings.builder}</h2>
            <Prose paragraphs={content.builder} />
          </section>

          <section className={about.row} aria-labelledby="about-contact">
            <h2 id="about-contact">{headings.contact}</h2>
            <div className={about.prose}>
              <p>
                <Inline text={content.contact.lead} />
              </p>
              <ul className={about.contactList}>
                {content.contact.items.map((item) => (
                  <li key={item.label}>
                    <span>
                      <Inline text={item.label} />
                    </span>
                    <span>{item.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className={about.notice} aria-labelledby="about-right-hivra">
            <h2 id="about-right-hivra">{headings.rightHivra}</h2>
            <p>
              <Inline text={content.rightHivra} />
            </p>
          </section>
        </div>

        <div className={about.faq}>
          <EditorialQuestions questions={questions} />
        </div>
      </main>
    </PublicSite>
  );
}
