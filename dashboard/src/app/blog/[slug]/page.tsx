import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialArt, EditorialCTA, EditorialQuestions, EditorialRelated } from "@/components/public-editorial/Editorial";
import ArticleNavigation from "@/components/public-editorial/ArticleNavigation.client";
import styles from "../../../components/public-editorial/secondary-site.module.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import StructuredData from "@/components/StructuredData";
import { BLOG_ARTICLES } from "@/lib/blog-data";
import { blogArticleOgImagePath, buildBlogArticleMetadata } from "@/lib/blog/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { articleMarkdownComponents } from "@/components/public-editorial/article-markdown";

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
        image: `${SITE_URL}${blogArticleOgImagePath(slug)}`,
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
            <div className={styles.metadata}><span>{article.author}</span><time dateTime={article.publishedDate}>{formatDate(article.publishedDate)}</time>{article.lastModified !== article.publishedDate && <time dateTime={article.lastModified}>Updated {formatDate(article.lastModified)}</time>}<span>{article.readingTimeMin} min read</span></div>
          </div>
          <EditorialArt number={String(article.readingTimeMin).padStart(2, "0")} label="Minutes to read" />
        </header>
        <div className={styles.articleLayout}>
          <ArticleNavigation items={contents} />
          <div className={styles.articleBody}>
            <article>
              {article.shortAnswer ? <section id="short-answer" className={styles.shortAnswer} aria-labelledby="short-answer-heading">
                <h2 id="short-answer-heading">Short answer</h2>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={articleMarkdownComponents}>{article.shortAnswer}</ReactMarkdown>
              </section> : null}
              {article.sections.map((section, index) => <section key={section.heading} id={contents[index].id} className={styles.bodySection}>
                <h2>{section.heading}</h2>
                {section.paragraphs.map((paragraph, paragraphIndex) => <ReactMarkdown key={paragraphIndex} remarkPlugins={[remarkGfm]} components={articleMarkdownComponents}>{paragraph}</ReactMarkdown>)}
              </section>)}
            </article>
            <EditorialQuestions questions={article.faqs} />
          </div>
        </div>
        {/* The shared CTA's default headline promises a deploy time nobody has measured. */}
        <EditorialCTA title={<>Give your agent a computer <strong>that stays on.</strong></>} />
        <EditorialRelated title="Related reading" links={[
          ...article.relatedArticles.map(({ slug, title }) => ({ label: title, href: `/blog/${slug}` })),
          ...(article.relatedFeatures ?? []).map(({ slug, title }) => ({ label: `Feature: ${title}`, href: `/features/${slug}` })),
          ...(article.relatedComparisons ?? []).map(({ slug, title }) => ({ label: `Compare: ${title}`, href: `/compare/${slug}` })),
        ]} />
      </main>
    </PublicSite>
  );
}
