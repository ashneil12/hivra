import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialArt, EditorialRelated } from "@/components/public-editorial/Editorial";
import styles from "../../components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { PUBLIC_START_HREF } from "@/lib/public-start";

// SCRIPTURE_ANCHOR: blog-proclaim | Psalm 96:3 | Verse: Declare his glory among the nations, his marvelous works among all the peoples.

export const metadata: Metadata = {
  title: "Blog: AI agent guides and deep dives",
  description:
    "Practical guides to running AI agents: how persistent memory works, self-hosting vs managed hosting, real automation examples, and more from the Hivra team.",
  ...buildWebsiteMetadata({
    path: "/blog",
    title: "Blog | Hivra",
    description:
      "Practical guides to running AI agents: persistent memory, self-hosting, automation examples, and cost breakdowns.",
  }),
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default function BlogIndexPage() {
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog` },
        ],
      },
      {
        "@type": "Blog",
        "@id": `${SITE_URL}/blog`,
        name: "Hivra Blog",
        description: "Practical guides to running AI agents",
        url: `${SITE_URL}/blog`,
        publisher: {
          "@type": "Organization",
          name: "Hivra",
          url: SITE_URL,
        },
        blogPost: BLOG_ARTICLES_LIST.map((a) => ({
          "@type": "BlogPosting",
          headline: a.title,
          url: `${SITE_URL}/blog/${a.slug}`,
          datePublished: a.publishedDate,
          author: { "@type": "Organization", name: a.author },
        })),
      },
    ],
  };

  const [featured, ...articles] = BLOG_ARTICLES_LIST;
  return (
    <PublicSite className={styles.page} data-page="blog">
      <StructuredData schema={schema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Blog" }]} />
        <header className={styles.masthead}>
          <span className={styles.eyebrow}>From the Hivra team</span>
          <h1>Guides for people who run AI agents.</h1>
          <p>Persistent memory, real automation examples, cost breakdowns, honest comparisons — written by the team that builds Hivra.</p>
        </header>
        {featured && <Link href={`/blog/${featured.slug}`} className={styles.featured}>
          <EditorialArt number="01" label={featured.tagline} />
          <div className={styles.featuredCopy}>
            <div className={styles.metadata}><time dateTime={featured.publishedDate}>{formatDate(featured.publishedDate)}</time><span>{featured.readingTimeMin} min read</span></div>
            <h2>{featured.title}</h2><p>{featured.intro}</p>
            <span className={styles.readLink}>Read the article <ArrowUpRight size={22} aria-hidden="true" /></span>
          </div>
        </Link>}
        <div className={styles.indexHead}><h2>All articles</h2><span>{BLOG_ARTICLES_LIST.length} articles</span></div>
        <div className={styles.rows}>
          {articles.map((article, index) => <Link key={article.slug} href={`/blog/${article.slug}`} className={styles.row}>
            <span className={styles.rowNumber}>{String(index + 2).padStart(2, "0")}</span>
            <article><h2>{article.title}</h2><p>{article.intro}</p></article>
            <div className={styles.metadata}><time dateTime={article.publishedDate}>{formatDate(article.publishedDate)}</time><span>{article.readingTimeMin} min read</span></div>
            <ArrowUpRight className={styles.rowArrow} size={24} aria-hidden="true" />
          </Link>)}
        </div>
        <EditorialRelated title="Explore Hivra" links={[{ label: "All Features", href: "/features" }, { label: "Compare Alternatives", href: "/compare" }, { label: "Deploy Now", href: PUBLIC_START_HREF }]} />
      </main>
    </PublicSite>
  );
}
