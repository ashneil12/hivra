import type { Metadata } from "next";

import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import RoadmapPageClient from "@/components/roadmap/RoadmapPageClient";
import { roadmapContent } from "@/lib/roadmap-content";

const ROADMAP_URL = `${SITE_URL}${roadmapContent.metadata.canonicalPath}`;

export const metadata: Metadata = {
  title: roadmapContent.metadata.title,
  description: roadmapContent.metadata.description,
  ...buildWebsiteMetadata({
    path: roadmapContent.metadata.canonicalPath,
    title: roadmapContent.metadata.title,
    description: roadmapContent.metadata.description,
  }),
};

const roadmapSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Roadmap", item: ROADMAP_URL },
      ],
    },
    {
      "@type": "WebPage",
      "@id": `${ROADMAP_URL}#webpage`,
      url: ROADMAP_URL,
      name: roadmapContent.metadata.title,
      description: roadmapContent.metadata.description,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      about: { "@type": "SoftwareApplication", name: "Hivra" },
    },
  ],
};

export default function RoadmapPage() {
  return (
    <>
      <StructuredData schema={roadmapSchema} />
      <RoadmapPageClient />
    </>
  );
}
