import type { Metadata } from "next";
import PublicSite from "@/components/public-site/PublicSite";
import FullTokenomicsSection from "@/components/landing/FullTokenomicsSection";
import { buildWebsiteMetadata } from "@/lib/metadata";
const TITLE = "Proposed $HIVRA tokenomics";
const DESCRIPTION = "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect.";
// buildWebsiteMetadata sets only canonical, Open Graph and Twitter fields.
export const metadata: Metadata = { title: TITLE, description: DESCRIPTION, ...buildWebsiteMetadata({ path: "/tokenomics", title: TITLE, description: DESCRIPTION }) };
export default function TokenomicsPage() {
  return <PublicSite><main id="main-content"><FullTokenomicsSection headingLevel={1} /></main></PublicSite>;
}
