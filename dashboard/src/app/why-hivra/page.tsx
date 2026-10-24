import type { Metadata } from "next";
import { Fragment } from "react";
import PublicSite from "@/components/public-site/PublicSite";
import { ActionLinks, type ActionLink } from "@/components/public-editorial/ActionLinks";
import { Breadcrumbs, EditorialMarkdownLink } from "@/components/public-editorial/Editorial";
import StructuredData from "@/components/StructuredData";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
import { SITE_URL } from "@/lib/seo-urls";
import styles from "@/components/public-editorial/secondary-site.module.css";
import founder from "./founder-page.module.css";
import { FOUNDER_NOTE, type NoteParagraph } from "./founder-note";

const TITLE = "Why I'm building Hivra | A note from the founder";
const DESCRIPTION =
  "Why Hivra's founder believes AI agents need separate computers, meaningful limits and infrastructure people can inspect.";

// absoluteTitle keeps the root layout from adding " | Hivra" after a title that already ends the way the owner wrote it.
// buildWebsiteMetadata sets only canonical, Open Graph and Twitter fields, so the title and description are written here.
export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/why-hivra", title: TITLE, description: DESCRIPTION }),
};

// The visible breadcrumb, as structured data: Home, then the note under its own heading.
function breadcrumbSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: FOUNDER_NOTE.heading, item: `${SITE_URL}/why-hivra` },
    ],
  };
}

function actions(): ActionLink[] {
  const repository = PUBLIC_PROJECT_LINKS.repository;
  return [
    { label: "Explore Agent Computers", href: "/", kind: "secondary" },
    ...(repository.status === "published"
      ? [{ label: "Read the open-source code", href: repository.href, kind: "secondary" } satisfies ActionLink]
      : []),
    { label: "See the ecosystem", href: "/ecosystem", kind: "secondary" },
  ];
}

function Paragraph({ paragraph }: { paragraph: NoteParagraph }) {
  const className = paragraph.role === "pull" ? founder.pull : paragraph.role === "signoff" ? founder.signoff : undefined;
  return (
    <p className={className}>
      {paragraph.spans.map((span, index) =>
        typeof span === "string" ? (
          <Fragment key={index}>{span}</Fragment>
        ) : (
          <EditorialMarkdownLink key={index} href={span.href}>
            {span.text}
          </EditorialMarkdownLink>
        ),
      )}
    </p>
  );
}

export default function WhyHivraPage() {
  return (
    <PublicSite>
      <StructuredData schema={breadcrumbSchema()} />
      <main id="main-content" className={styles.main}>
        <div className={founder.column}>
          <Breadcrumbs items={[{ label: FOUNDER_NOTE.heading }]} />
          <article className={founder.article}>
            <h1 className={founder.title}>{FOUNDER_NOTE.heading}</h1>
            <div className={founder.opening}>
              {FOUNDER_NOTE.opening.map((paragraph, index) => (
                <Paragraph key={index} paragraph={paragraph} />
              ))}
            </div>
            {FOUNDER_NOTE.sections.map((section) => (
              <section key={section.id} className={founder.section} aria-labelledby={section.id}>
                <h2 id={section.id}>{section.heading}</h2>
                {section.paragraphs.map((paragraph, index) => (
                  <Paragraph key={index} paragraph={paragraph} />
                ))}
              </section>
            ))}
            <div className={founder.closing}>
              <ActionLinks items={actions()} label="More from Hivra" />
            </div>
          </article>
        </div>
      </main>
    </PublicSite>
  );
}
