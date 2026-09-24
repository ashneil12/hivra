import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialRelated } from "@/components/public-editorial/Editorial";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { TOOLS_HUB, TOOL_ENTRIES, nonAffiliationLine, toolOgImage, toolPath } from "@/lib/tools/tool-catalog";
import ToolsCta from "./ToolsCta";
import styles from "./tools.module.css";

// /tools was an indexed page on the retired site. Rebuilt on the public
// editorial shell; the catalog in lib/tools/tool-catalog.ts owns the copy.

export const metadata: Metadata = {
  title: TOOLS_HUB.metaTitle,
  description: TOOLS_HUB.metaDescription,
  ...buildWebsiteMetadata({
    path: TOOLS_HUB.path,
    title: TOOLS_HUB.metaTitle,
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
        <Breadcrumbs items={[{ label: "Tools" }]} />
        <header className={editorial.masthead}>
          <span className={editorial.eyebrow}>{TOOLS_HUB.eyebrow}</span>
          <h1>
            Tools for people who <strong>run agents.</strong>
          </h1>
          <p>{TOOLS_HUB.intro}</p>
        </header>

        <div className={[editorial.directory, styles.directoryBalanced].filter(Boolean).join(" ")}>
          {TOOL_ENTRIES.map((entry, index) => (
            <Link key={entry.slug} href={toolPath(entry.slug)}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h2>{entry.name}</h2>
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
              Agents that <strong>stay on.</strong>
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
