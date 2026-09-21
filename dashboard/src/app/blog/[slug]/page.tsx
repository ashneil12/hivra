import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialArt, EditorialCTA, EditorialMarkdownLink, EditorialQuestions, EditorialRelated } from "@/components/public-editorial/Editorial";
import ArticleNavigation from "@/components/public-editorial/ArticleNavigation.client";
import styles from "../../../components/public-editorial/secondary-site.module.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import StructuredData from "@/components/StructuredData";
import { BLOG_ARTICLES } from "@/lib/blog-data";
import { buildBlogArticleMetadata } from "@/lib/blog/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { CodeBlock } from "@/components/markdown/CodeBlock";

// SCRIPTURE_ANCHOR: blog-scroll | Habakkuk 2:2 | Verse: Write the vision, and make it plain on tablets, that he who runs may read it.

interface BlogPageParams {
  params: Promise<{ slug: string }>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export async function generateMetadata({ params }: BlogPageParams): Promise<Metadata> {
  const { slug } = await params;
  return buildBlogArticleMetadata(slug);
}

export function generateStaticParams() {
  return Object.keys(BLOG_ARTICLES).map((slug) => ({ slug }));
}

export default async function BlogArticlePage({ params }: BlogPageParams) {
  const { slug } = await params;
  const article = BLOG_ARTICLES[slug];
  if (!article) notFound();

  const articleUrl = `${SITE_URL}/blog/${slug}`;

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": articleUrl,
        headline: article.title,
        description: article.metaDescription,
        url: articleUrl,
        datePublished: article.publishedDate,
        dateModified: article.lastModified,
        author: {
          "@type": "Organization",
          name: article.author,
          url: SITE_URL,
        },
        publisher: {
          "@type": "Organization",
          name: "Hivra",
          url: SITE_URL,
        },
        mainEntityOfPage: { "@type": "WebPage", "@id": articleUrl },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog` },
          { "@type": "ListItem", position: 3, name: article.title, item: articleUrl },
        ],
      },
      ...(article.faqs.length > 0
        ? [
            {
              "@type": "FAQPage",
              mainEntity: article.faqs.map(({ q, a }) => ({
                "@type": "Question",
                name: q,
                acceptedAnswer: { "@type": "Answer", text: a },
              })),
            },
          ]
        : []),
    ],
  };

  const contents = article.sections.map((section, index) => ({ id: `section-${index + 1}`, label: section.heading }));
  return (
    <PublicSite className={styles.page} data-page="article">
      <StructuredData schema={schema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Blog", href: "/blog" }, { label: article.title }]} />
        <header className={styles.articleHeader}>
          <div><span className={styles.eyebrow}>{article.tagline}</span><h1>{article.title}</h1><p>{article.intro}</p>
            <div className={styles.metadata}><span>{article.author}</span><time dateTime={article.publishedDate}>{formatDate(article.publishedDate)}</time><span>{article.readingTimeMin} min read</span></div>
          </div>
          <EditorialArt number={String(article.readingTimeMin).padStart(2, "0")} label="Minutes to read" />
        </header>
        <div className={styles.articleLayout}>
          <ArticleNavigation items={contents} />
          <div className={styles.articleBody}>
            <article>
              {article.sections.map((section, index) => <section key={section.heading} id={contents[index].id} className={styles.bodySection}>
                <h2>{section.heading}</h2>
                {section.paragraphs.map((paragraph, paragraphIndex) => <ReactMarkdown key={paragraphIndex} remarkPlugins={[remarkGfm]} components={{
                  a: ({ node, ...props }) => { void node; return <EditorialMarkdownLink {...props} />; },
                  code({ children, className, node, ...rest }) {
                    void node;
                    const match = /language-(\w+)/.exec(className || "");
                    return match ? <div className={styles.code}><CodeBlock language={match[1]} value={String(children).replace(/\n$/, "")} /></div> : <code {...rest}>{children}</code>;
                  },
                  pre: ({ children }) => <div className={styles.code}>{children}</div>,
                  table: ({ children }) => <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Scrollable table"><table>{children}</table></div>,
                }}>{paragraph}</ReactMarkdown>)}
              </section>)}
            </article>
            <EditorialQuestions questions={article.faqs} />
          </div>
        </div>
        <EditorialCTA />
        <EditorialRelated title="Related reading" links={[
          ...article.relatedArticles.map(({ slug, title }) => ({ label: title, href: `/blog/${slug}` })),
          ...(article.relatedFeatures ?? []).map(({ slug, title }) => ({ label: `Feature: ${title}`, href: `/features/${slug}` })),
          ...(article.relatedComparisons ?? []).map(({ slug, title }) => ({ label: `Compare: ${title}`, href: `/compare/${slug}` })),
        ]} />
      </main>
    </PublicSite>
  );
}
