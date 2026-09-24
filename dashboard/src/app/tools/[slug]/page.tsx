import type { Metadata } from "next";
import type { ComponentType } from "react";
import { notFound } from "next/navigation";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialQuestions, EditorialRelated } from "@/components/public-editorial/Editorial";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import AgentSurvivalCheckTool from "@/components/tools/AgentSurvivalCheckTool";
import HostingCostCalculatorTool from "@/components/tools/HostingCostCalculatorTool";
import LimitResetCalculatorTool from "@/components/tools/LimitResetCalculatorTool";
import PlanCalculatorTool from "@/components/tools/PlanCalculatorTool";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import {
  TOOL_ENTRIES,
  TOOLS_HUB,
  getToolEntry,
  nonAffiliationLine,
  toolOgImage,
  toolPath,
  type ToolComponentKey,
} from "@/lib/tools/tool-catalog";
import ToolsCta from "../ToolsCta";
import styles from "../tools.module.css";

// Static map from catalog componentKey to the client component that renders
// the interactive tool.
const TOOL_COMPONENTS: Record<ToolComponentKey, ComponentType> = {
  "plan-calculator": PlanCalculatorTool,
  "agent-survival-check": AgentSurvivalCheckTool,
  "hosting-cost-calculator": HostingCostCalculatorTool,
  "limit-reset-calculator": LimitResetCalculatorTool,
};

interface ToolPageParams {
  params: Promise<{ slug: string }>;
}

// Only the catalog's slugs exist; anything else is a real 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return TOOL_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: ToolPageParams): Promise<Metadata> {
  const { slug } = await params;
  const entry = getToolEntry(slug);
  if (!entry) return {};

  return {
    title: entry.metaTitle,
    description: entry.metaDescription,
    ...buildWebsiteMetadata({
      path: toolPath(entry.slug),
      title: entry.metaTitle,
      description: entry.metaDescription,
      images: [toolOgImage(entry.slug)],
    }),
  };
}

export default async function ToolPage({ params }: ToolPageParams) {
  const { slug } = await params;
  const entry = getToolEntry(slug);
  if (!entry) notFound();

  const ToolComponent = TOOL_COMPONENTS[entry.componentKey];
  const pageUrl = `${SITE_URL}${toolPath(entry.slug)}`;

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        "@id": pageUrl,
        name: entry.name,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        description: entry.metaDescription,
        url: pageUrl,
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@type": "Organization", name: "Hivra", url: SITE_URL },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Tools", item: `${SITE_URL}${TOOLS_HUB.path}` },
          { "@type": "ListItem", position: 3, name: entry.name, item: pageUrl },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: entry.faqs.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };

  // The entry's own links first, then the other tools; one link per destination.
  const related = [
    ...entry.relatedLinks,
    ...TOOL_ENTRIES.filter((other) => other.slug !== entry.slug).map((other) => ({ label: other.name, href: toolPath(other.slug) })),
  ].filter((link, index, all) => all.findIndex((candidate) => candidate.href === link.href) === index);

  return (
    <PublicSite className={editorial.page} data-page="tools-detail">
      <StructuredData schema={schema} />
      <main className={editorial.main} id="main-content">
        <Breadcrumbs items={[{ label: "Tools", href: TOOLS_HUB.path }, { label: entry.name }]} />
        <header className={editorial.masthead}>
          <span className={editorial.eyebrow}>Free tool. No signup.</span>
          <h1>{entry.h1}</h1>
          <p>{entry.subhead}</p>
        </header>

        <div className={styles.intro}>
          {entry.longIntro.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        <section className={styles.toolSection} aria-label={entry.name} id="tool">
          <ToolComponent />
        </section>

        <div className={styles.narrow}>
          <EditorialQuestions questions={entry.faqs} />
        </div>

        <ToolsCta
          title={
            <>
              Put your agent on a box that <strong>stays on.</strong>
            </>
          }
        />
        <p className={styles.disclaimer}>{nonAffiliationLine(entry.vendors)}</p>

        <EditorialRelated links={related} />
      </main>
    </PublicSite>
  );
}
