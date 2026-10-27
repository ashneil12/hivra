import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialRelated } from "@/components/public-editorial/Editorial";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import Markup from "@/components/tools/Markup";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { TOOLS_HUB, TOOL_ENTRIES, nonAffiliationLine, toolOgImage, toolPath } from "@/lib/tools/tool-catalog";
import ToolsCta from "./ToolsCta";
import styles from "./tools.module.css";

// /tools was an indexed page on the retired site. Rebuilt on the public
// editorial shell; the catalog in lib/tools/tool-catalog.ts owns the copy.
// The browser title is the finished one from the copy, so it skips the layout's
// " | Hivra" template (absoluteTitle).

export const metadata: Metadata = {
  title: absoluteTitle(TOOLS_HUB.browserTitle),
  description: TOOLS_HUB.metaDescription,
  ...buildWebsiteMetadata({
    path: TOOLS_HUB.path,
    title: TOOLS_HUB.browserTitle,
    description: TOOLS_HUB.metaDescription,
    images: [toolOgImage()],
  }),
};

const schema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": `${SITE_URL}${TOOLS_HUB.path}`,
      name: TOOLS_HUB.metaTitle,
      description: TOOLS_HUB.metaDescription,
      url: `${SITE_URL}${TOOLS_HUB.path}`,
      mainEntity: {
        "@type": "ItemList",
        name: "Free tools from Hivra",
        itemListElement: TOOL_ENTRIES.map((entry, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: entry.name,
          url: `${SITE_URL}${toolPath(entry.slug)}`,
        })),
      },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Tools", item: `${SITE_URL}${TOOLS_HUB.path}` },
      ],
    },
  ],
};

export default function ToolsIndexPage() {
  return (
    <PublicSite className={editorial.page} data-page="tools">
      <StructuredData schema={schema} />
      <main className={editorial.main} id="main-content">
        <div className={styles.crumbs}>
          <Breadcrumbs items={[{ label: "Tools" }]} />
        </div>
        <header className={editorial.masthead}>
          <span className={editorial.eyebrow}>{TOOLS_HUB.eyebrow}</span>
          <h1>
            Free tools for people <strong>building with AI agents</strong>
          </h1>
          <div className={styles.hubIntro}>
            {TOOLS_HUB.intro.map((paragraph) => (
              <p key={paragraph}>
                <Markup text={paragraph} />
              </p>
            ))}
          </div>
        </header>

        <h2 className={styles.directoryHeading}>{TOOLS_HUB.directoryHeading}</h2>
        <div className={[editorial.directory, styles.directoryBalanced].filter(Boolean).join(" ")}>
          {TOOL_ENTRIES.map((entry, index) => (
            <Link key={entry.slug} href={toolPath(entry.slug)}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{entry.name}</h3>
              <div>
                <p>{entry.subhead}</p>
                <span className={editorial.readLink}>
                  Open the tool
                  <ArrowUpRight size={20} aria-hidden="true" />
                </span>
              </div>
            </Link>
          ))}
        </div>

        <ToolsCta
          title={
            <>
              Computers that <strong>stay on.</strong>
            </>
          }
        />
        <p className={styles.disclaimer}>{nonAffiliationLine(TOOLS_HUB.vendors)}</p>

        <EditorialRelated
          title="See also:"
          links={[
            { label: "Hivra pricing", href: "/pricing" },
            { label: "Run Claude Code on Hivra", href: "/agents/claude-code" },
          ]}
        />
      </main>
    </PublicSite>
  );
}
