import type { Metadata } from "next";
import Link from "next/link";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialMarkdownLink, EditorialQuestions } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { SITE_DESCRIPTION } from "@/lib/brand-description";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { glossify } from "@/components/gloss/glossify";
import { ABOUT_DESCRIPTION, ABOUT_FAQ, ABOUT_LINKS, ABOUT_SECTIONS, ABOUT_TITLE } from "./about-content";

// /about was a 308 to the founder essay. It is now the entity home: one
// definition sentence, the former name, what Hivra is and is not, how it is paid
// for, and how to check and reach it. The copy is in about-content.ts.
export const metadata: Metadata = {
  title: ABOUT_TITLE,
  description: ABOUT_DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/about", title: ABOUT_TITLE, description: ABOUT_DESCRIPTION }),
};

const aboutSchema = {
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
      mainEntity: ABOUT_FAQ.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
  ],
};

export default function AboutPage() {
  const { is, isNot, built, contact, others } = ABOUT_SECTIONS;
  return (
    <PublicSite className={styles.page} data-page="about">
      <StructuredData schema={aboutSchema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "About" }]} />
        <header className={styles.masthead}>
          <span className={styles.eyebrow}>About</span>
          <h1>
            About <strong>Hivra.</strong>
          </h1>
          <p>{SITE_DESCRIPTION}</p>
        </header>
        <div className={styles.articleBody}>
          <section aria-labelledby="about-is">
            <h2 id="about-is">{is.heading}</h2>
            {is.paragraphs.map((paragraph) => (
              <p key={paragraph}>{glossify(paragraph)}</p>
            ))}
          </section>
          <section aria-labelledby="about-is-not">
            <h2 id="about-is-not">{isNot.heading}</h2>
            <ul>
              {isNot.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="about-built">
            <h2 id="about-built">{built.heading}</h2>
            {built.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <p>
              See <Link href="/pricing">the pricing page</Link> for what each plan includes.
            </p>
          </section>
          <section aria-labelledby="about-contact">
            <h2 id="about-contact">{contact.heading}</h2>
            <p>{contact.lead}</p>
            <ul>
              {ABOUT_LINKS.map((link) => (
                <li key={link.href}>
                  {link.href.startsWith("https://") ? (
                    <EditorialMarkdownLink href={link.href}>{link.label}</EditorialMarkdownLink>
                  ) : (
                    <Link href={link.href}>{link.label}</Link>
                  )}
                  : {link.note}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="about-others">
            <h2 id="about-others">{others.heading}</h2>
            {others.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        </div>
        <EditorialQuestions questions={ABOUT_FAQ} />
      </main>
    </PublicSite>
  );
}
