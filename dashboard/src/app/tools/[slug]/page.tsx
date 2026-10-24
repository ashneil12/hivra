import type { Metadata } from "next";
import type { ComponentType } from "react";
import { notFound } from "next/navigation";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialQuestions, EditorialRelated } from "@/components/public-editorial/Editorial";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import AgentSurvivalCheckTool from "@/components/tools/AgentSurvivalCheckTool";
import FaqAnswer from "@/components/tools/FaqAnswer";
import HostingCostCalculatorTool from "@/components/tools/HostingCostCalculatorTool";
import KeepMacAwakeTool from "@/components/tools/KeepMacAwakeTool";
import LimitResetCalculatorTool from "@/components/tools/LimitResetCalculatorTool";
import Markup from "@/components/tools/Markup";
import PlanCalculatorTool from "@/components/tools/PlanCalculatorTool";
import TmuxCheatSheetTool from "@/components/tools/TmuxCheatSheetTool";
import { buildAbsoluteTitleMetadata } from "@/lib/metadata";
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
import ToolMethodSection from "../ToolMethodSection";
import ToolsCta from "../ToolsCta";
import styles from "../tools.module.css";

// Static map from catalog componentKey to the client component that renders
// the interactive tool.
const TOOL_COMPONENTS: Record<ToolComponentKey, ComponentType> = {
  "plan-calculator": PlanCalculatorTool,
  "agent-survival-check": AgentSurvivalCheckTool,
  "hosting-cost-calculator": HostingCostCalculatorTool,
  "limit-reset-calculator": LimitResetCalculatorTool,
  "keep-mac-awake": KeepMacAwakeTool,
  "tmux-cheat-sheet": TmuxCheatSheetTool,
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

  // The finished browser title from the copy, so the layout's " | Hivra" template is not added a second time.
  return buildAbsoluteTitleMetadata({
    path: toolPath(entry.slug),
    title: entry.browserTitle,
    description: entry.metaDescription,
    images: [toolOgImage(entry.slug)],
  });
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

  // The pages that quote commands set them in code. The answer text is unchanged, so the structured data above
  // and the page read the same.
  const faqCode = entry.faqCode;
  const questions = faqCode ? entry.faqs.map(({ q, a }) => ({ q, a, node: <FaqAnswer text={a} phrases={faqCode} /> })) : entry.faqs;

  // The entry's own links first, then the other tools; one link per destination.
  const related = [
    ...entry.relatedLinks,
    ...TOOL_ENTRIES.filter((other) => other.slug !== entry.slug).map((other) => ({ label: other.name, href: toolPath(other.slug) })),
  ].filter((link, index, all) => all.findIndex((candidate) => candidate.href === link.href) === index);

  return (
    <PublicSite className={editorial.page} data-page="tools-detail">
      <StructuredData schema={schema} />
      <main className={editorial.main} id="main-content">
        <div className={styles.crumbs}>
          <Breadcrumbs items={[{ label: "Tools", href: TOOLS_HUB.path }, { label: entry.name }]} />
        </div>
        <header className={[editorial.masthead, styles.toolMasthead].join(" ")}>
          <span className={editorial.eyebrow}>Free tool. No signup.</span>
          <h1>{entry.h1}</h1>
          <p>
            <Markup text={entry.intro.lede} />
          </p>
        </header>

        <div className={[styles.intro, entry.intro.note ? styles.introWithNote : null].filter(Boolean).join(" ")}>
          <div className={styles.introBody}>
            {entry.intro.body.map((paragraph) => (
              <p key={paragraph}>
                <Markup text={paragraph} />
              </p>
            ))}
          </div>
          {entry.intro.note && (
            <aside className={styles.introNote} role="note">
              <p>
                <Markup text={entry.intro.note} />
              </p>
            </aside>
          )}
        </div>

        <section className={styles.toolSection} aria-label={entry.name} id="tool">
          <ToolComponent />
        </section>

        <ToolMethodSection entry={entry} />

        {/* Tools that quote commands keep ligatures off in the FAQ, where flags are plain text. */}
        <div className={[styles.narrow, entry.method ? styles.noLigatures : null].filter(Boolean).join(" ")}>
          <EditorialQuestions questions={questions} />
        </div>

        <ToolsCta
          title={
            <>
              When you need a computer that <strong>stays on</strong>
            </>
          }
        />
        <p className={styles.disclaimer}>{nonAffiliationLine(entry.vendors)}</p>

        <EditorialRelated links={related} />
      </main>
    </PublicSite>
  );
}
