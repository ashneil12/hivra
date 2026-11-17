import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialRelated } from "@/components/public-editorial/Editorial";
import styles from "../../components/public-editorial/secondary-site.module.css";
import docStyles from "./docs.module.css";
import StructuredData from "@/components/StructuredData";
import { DOCS, DOC_SECTIONS, DOC_STATUS_LABEL } from "@/lib/docs/registry";
import { BLOG_TOPICS, topicAnchor } from "@/lib/blog/topics";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { PUBLIC_START_HREF } from "@/lib/public-start";

const TITLE = "Docs: launch, run and update AI agents";
const DESCRIPTION =
  "How to use Hivra: launch an agent on a computer of its own, connect its model, open it, keep it updated, and a page for every supported agent.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/docs", title: "Docs | Hivra", description: DESCRIPTION }),
};

const START_HERE = ["getting-started", "models-and-credits", "connect-your-own-server"];

export default function DocsHubPage() {
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Docs", item: `${SITE_URL}/docs` },
        ],
      },
      {
        "@type": "CollectionPage",
        "@id": `${SITE_URL}/docs`,
        name: "Hivra docs",
        description: DESCRIPTION,
        url: `${SITE_URL}/docs`,
        hasPart: Object.values(DOCS).map((doc) => ({ "@type": "TechArticle", headline: doc.title, url: `${SITE_URL}/docs/${doc.slug}` })),
      },
    ],
  };

  return (
    <PublicSite className={styles.page} data-page="docs">
      <StructuredData schema={schema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Docs" }]} />
        <header className={styles.masthead}>
          <span className={styles.eyebrow}>Hivra docs</span>
          <h1>Everything you need to run an agent on a computer of its own.</h1>
          <p>Short pages that each do one job: launch an agent, connect its model, open it, keep it updated. Every supported agent and computer has a page of its own.</p>
        </header>

        <section aria-labelledby="start-here-heading">
          <h2 id="start-here-heading" className={styles.eyebrow}>Start here</h2>
          <div className={docStyles.start}>
            {START_HERE.map((slug, index) => {
              const doc = DOCS[slug];
              return doc ? <Link key={slug} href={`/docs/${slug}`} className={docStyles.startCard}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{doc.title}</strong>
                <p>{doc.summary}</p>
              </Link> : null;
            })}
          </div>
        </section>

        <nav className={styles.topicNav} aria-label="Docs sections">
          <span>Jump to</span>
          {DOC_SECTIONS.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
          <a href="#guides">Guides</a>
        </nav>

        {DOC_SECTIONS.map((section) => (
          <section key={section.id} id={section.id} className={styles.topicSection} aria-labelledby={`${section.id}-heading`}>
            <div className={styles.indexHead}><h2 id={`${section.id}-heading`}>{section.title}</h2><span>{section.docs.length} {section.docs.length === 1 ? "page" : "pages"}</span></div>
            <p className={styles.topicBlurb}>{section.blurb}</p>
            <div className={docStyles.grid}>
              {section.docs.map((slug) => {
                const doc = DOCS[slug];
                if (!doc) return null;
                return <Link key={slug} href={`/docs/${slug}`} className={docStyles.card}>
                  <h3>{doc.title}<ArrowUpRight size={18} aria-hidden="true" /></h3>
                  <p>{doc.summary}</p>
                  {doc.status && doc.status !== "available" ? <span className={`${docStyles.status} ${doc.status === "preview" ? docStyles.statusPreview : ""}`}>{DOC_STATUS_LABEL[doc.status]}</span> : null}
                </Link>;
              })}
            </div>
          </section>
        ))}

        <section id="guides" className={styles.topicSection} aria-labelledby="guides-heading">
          <div className={styles.indexHead}><h2 id="guides-heading">Guides</h2><span>On the blog</span></div>
          <p className={styles.topicBlurb}>Longer reads that explain and compare: keeping agents running, hosting and costs, and each agent in depth.</p>
          <div className={docStyles.guides}>
            {BLOG_TOPICS.map((topic) => <Link key={topic.slug} href={`/blog#${topicAnchor(topic)}`}><span>{topic.title}</span><span>{topic.articles.length} guides</span></Link>)}
          </div>
        </section>

        <EditorialRelated title="Elsewhere" links={[{ label: "Agents", href: "/agents" }, { label: "Pricing", href: "/pricing" }, { label: "Free tools", href: "/tools" }, { label: "Launch an agent", href: PUBLIC_START_HREF }]} />
      </main>
    </PublicSite>
  );
}
