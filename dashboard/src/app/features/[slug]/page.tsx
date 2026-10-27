import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialRelated } from "@/components/public-editorial/Editorial";
import ArticleNavigation from "@/components/public-editorial/ArticleNavigation.client";
import ActionLinks from "@/components/public-editorial/ActionLinks";
import StructuredData from "@/components/StructuredData";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildAbsoluteTitleMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { FEATURE_PAGES, featurePageContent } from "../_content";
import { FeatureBlocks } from "../_components/FeatureBlocks";
import { FeatureFaq } from "../_components/FeatureFaq";
import { plainText } from "../_components/Inline";
import styles from "../../../components/public-editorial/secondary-site.module.css";
import local from "../features.module.css";

interface FeaturePageParams {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: FeaturePageParams): Promise<Metadata> {
  const { slug } = await params;
  const feature = featurePageContent(slug);
  if (!feature) return {};

  // The copy supplies finished browser titles ("Persistent Memory for AI Agents | Hivra"), so the
  // root template must not add its own brand after them.
  return buildAbsoluteTitleMetadata({
    path: `/features/${slug}`,
    title: feature.seoTitle,
    description: feature.description,
  });
}

export function generateStaticParams() {
  return FEATURE_PAGES.map(({ slug }) => ({ slug }));
}

export default async function FeaturePage({ params }: FeaturePageParams) {
  const { slug } = await params;
  const feature = featurePageContent(slug);
  if (!feature) notFound();

  const featureUrl = `${SITE_URL}/features/${slug}`;

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "Hivra",
        applicationCategory: "DeveloperApplication",
        description: feature.description,
        url: SITE_URL,
        featureList: [feature.breadcrumb],
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Features", item: `${SITE_URL}/features` },
          { "@type": "ListItem", position: 3, name: feature.breadcrumb, item: featureUrl },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: feature.faqs.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: plainText(a) },
        })),
      },
    ],
  };

  // The opening statement is not listed: the contents start at the first named section.
  const contents = feature.sections.map((section, index) => ({ id: `section-${index + 1}`, label: section.heading }));

  return (
    <PublicSite className={styles.page} data-page="features-detail">
      <StructuredData schema={schema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Features", href: "/features" }, { label: feature.breadcrumb }]} />
        <header className={`${styles.masthead} ${local.masthead} ${feature.eyebrow ? "" : local.mastheadPlain}`}>
          {feature.eyebrow ? <span className={`${styles.eyebrow} ${local.eyebrow}`}>{feature.eyebrow}</span> : null}
          <h1>{feature.h1}</h1>
        </header>
        <div className={styles.articleLayout}>
          <ArticleNavigation items={contents} />
          <div className={`${styles.articleBody} ${local.article}`}>
            <section className={local.lead} aria-labelledby="lead-heading">
              <h2 id="lead-heading">{feature.lead.heading}</h2>
              <FeatureBlocks blocks={feature.lead.blocks} />
            </section>
            {feature.sections.map((section, index) => (
              <section key={section.heading} id={contents[index].id}>
                <h2>{section.heading}</h2>
                <FeatureBlocks blocks={section.blocks} />
              </section>
            ))}
            <FeatureFaq faqs={feature.faqs} />
            <section className={local.closing} aria-label="Next steps">
              <ActionLinks items={feature.actions} />
            </section>
          </div>
        </div>
        <div className={`${styles.articleLayout} ${local.relatedLayout}`}>
          <div className={local.relatedLinks}>
            <EditorialRelated title="Related" links={[...feature.related]} />
          </div>
        </div>
      </main>
    </PublicSite>
  );
}
