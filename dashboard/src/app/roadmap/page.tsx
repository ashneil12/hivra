import type { Metadata } from "next";

import { getTokenSurfaceView, tokenSurfacesVisible } from "@/lib/compliance/token-surface-view";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { resolveRoadmap } from "@/lib/roadmap-content";
import RoadmapView from "./RoadmapView";

const TITLE = "Hivra Roadmap | What Exists, What's Next and What We're Exploring";
// People searching "hermes agent roadmap" land here (Search Console), so the description says whose
// roadmap this is not. 160 characters at most.
const DESCRIPTION =
  "Follow Hivra's move from managed AI agent computers to safer, connected agent infrastructure. See what's live and what's planned. Not the Hermes Agent roadmap.";

// Metadata carries no token wording, so it is the same for every viewer.
export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/roadmap", title: TITLE, description: DESCRIPTION }),
};

// The plan is the same for everyone except its token sentences. They show only while the
// token surfaces are on and the viewer is not in a listed country (lib/compliance). With the
// switch off, or no country listed, nothing reads the request and the page stays static; once
// a country is listed (GB today) the page is rendered per request.
export default async function RoadmapPage() {
  const view = await getTokenSurfaceView();
  return (
    <RoadmapView
      roadmap={resolveRoadmap(tokenSurfacesVisible(view))}
      tokenSurfaces={view.tokenSurfaces}
      title={TITLE}
      description={DESCRIPTION}
    />
  );
}
