import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialCTA, EditorialRelated } from "@/components/public-editorial/Editorial";
import ArticleNavigation from "@/components/public-editorial/ArticleNavigation.client";
import { articleMarkdownComponents } from "@/components/public-editorial/article-markdown";
import styles from "../../../components/public-editorial/secondary-site.module.css";
import docStyles from "../docs.module.css";
import StructuredData from "@/components/StructuredData";
import { BLOG_ARTICLES } from "@/lib/blog-data";
import { DOCS, DOCS_IN_ORDER, DOC_STATUS_LABEL, getDoc, sectionForDoc } from "@/lib/docs/registry";
import { buildArticleMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";

interface DocPageParams {
  params: Promise<{ slug: string }>;
}

// Only registered docs exist; anything else is a real 404. /docs/litepaper is its own static route.
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(DOCS).map((slug) => ({ slug }));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export async function generateMetadata({ params }: DocPageParams): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return {};
  return {
    title: doc.metaTitle ?? doc.title,
    description: doc.metaDescription,
    ...buildArticleMetadata({
      path: `/docs/${slug}`,
      title: doc.title,
      description: doc.metaDescription,
      publishedTime: doc.lastReviewed,
      modifiedTime: doc.lastReviewed,
      authors: ["Hivra"],
    }),
  };
}

export default async function DocPage({ params }: DocPageParams) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();

  const section = sectionForDoc(slug);
  const index = DOCS_IN_ORDER.findIndex((other) => other.slug === slug);
  const previous = index > 0 ? DOCS_IN_ORDER[index - 1] : undefined;
  const next = index >= 0 && index < DOCS_IN_ORDER.length - 1 ? DOCS_IN_ORDER[index + 1] : undefined;
  const url = `${SITE_URL}/docs/${slug}`;
  const contents = doc.blocks.map((block, blockIndex) => ({ id: `step-${blockIndex + 1}`, label: block.heading }));

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "@id": url,
        headline: doc.title,
        description: doc.metaDescription,
        url,
        dateModified: doc.lastReviewed,
        publisher: { "@type": "Organization", name: "Hivra", url: SITE_URL },
        mainEntityOfPage: { "@type": "WebPage", "@id": url },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Docs", item: `${SITE_URL}/docs` },
          { "@type": "ListItem", position: 3, name: doc.title, item: url },
        ],
      },
    ],
  };

  const related = [
    ...(doc.next ?? []).map((other) => DOCS[other]).filter(Boolean).map((other) => ({ label: other.title, href: `/docs/${other.slug}` })),
    ...(doc.articles ?? []).map((other) => BLOG_ARTICLES[other]).filter(Boolean).map((article) => ({ label: `Guide: ${article.title}`, href: `/blog/${article.slug}` })),
  ];

  return (
    <PublicSite className={styles.page} data-page="doc">
      <StructuredData schema={schema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, ...(section ? [{ label: section.title, href: `/docs#${section.id}` }] : []), { label: doc.title }]} />
        <header className={docStyles.docHeader}>
          <span className={styles.eyebrow}>{section?.title ?? "Docs"}</span>
          <h1>{doc.title}</h1>
          <p>{doc.summary}</p>
          <div className={docStyles.docMeta}>
            {doc.status ? <span className={`${docStyles.status} ${doc.status === "preview" ? docStyles.statusPreview : ""}`}>{DOC_STATUS_LABEL[doc.status]}</span> : null}
            <time dateTime={doc.lastReviewed}>Checked {formatDate(doc.lastReviewed)}</time>
          </div>
        </header>
        <div className={styles.articleLayout}>
          <ArticleNavigation items={contents} />
          <div className={styles.articleBody}>
            <article>
              {doc.blocks.map((block, blockIndex) => (
                <section key={block.heading} id={contents[blockIndex].id} className={styles.bodySection}>
                  <h2>{block.heading}</h2>
                  {block.paragraphs.map((paragraph, paragraphIndex) => (
                    <ReactMarkdown key={paragraphIndex} remarkPlugins={[remarkGfm]} components={articleMarkdownComponents}>{paragraph}</ReactMarkdown>
                  ))}
                </section>
              ))}
            </article>
            <nav className={docStyles.pager} aria-label="More docs">
              {previous ? <Link href={`/docs/${previous.slug}`}><span>Previous</span><strong>{previous.title}</strong></Link> : null}
              {next ? <Link href={`/docs/${next.slug}`} className={docStyles.pagerNext}><span>Next</span><strong>{next.title}</strong></Link> : null}
            </nav>
          </div>
        </div>
        <EditorialCTA title={<>Give your agent a computer <strong>of its own.</strong></>} />
        {related.length ? <EditorialRelated title="Read next" links={related} /> : null}
      </main>
    </PublicSite>
  );
}
