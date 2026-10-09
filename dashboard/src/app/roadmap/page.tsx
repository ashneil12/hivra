import type { Metadata } from "next";

import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import RoadmapPageClient from "@/components/roadmap/RoadmapPageClient";
import { resolveTokenGeoBlockForPage } from "@/lib/compliance/token-geo-page";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";
import { restrictedRoadmapContent, roadmapContent, type RoadmapPageContent } from "@/lib/roadmap-content";

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
  // No country is listed (the list is empty, so the policy is dormant): render
  // the whole roadmap, without reading the request country.
  // Switch off: the roadmap without the token section and token links, for everyone.
  if (!newTokenSurfacesEnabled()) return <RoadmapView content={restrictedRoadmapContent()} tokenSurfaces={false} />;
  if (!isTokenGeoPolicyActive()) return <RoadmapView content={roadmapContent} tokenSurfaces />;
  // A country is listed (GB today): render per request. A blocked viewer gets
  // the same plan without the token section, the token-access lines and the
  // token links. The page is already rendered per request, so nothing is lost.
  return renderForViewer();
}

async function renderForViewer() {
  const geo = await resolveTokenGeoBlockForPage();
  return <RoadmapView content={geo.blocked ? restrictedRoadmapContent() : roadmapContent} tokenSurfaces />;
}

function RoadmapView({ content, tokenSurfaces }: { content: RoadmapPageContent; tokenSurfaces: boolean }) {
  return (
    <>
      <StructuredData schema={roadmapSchema} />
      <RoadmapPageClient content={content} tokenSurfaces={tokenSurfaces} />
    </>
  );
}
