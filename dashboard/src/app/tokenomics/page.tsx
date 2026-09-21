import PublicSite from "@/components/public-site/PublicSite";
import FullTokenomicsSection from "@/components/landing/FullTokenomicsSection";
import { buildWebsiteMetadata } from "@/lib/metadata";
export const metadata = buildWebsiteMetadata({ path: "/tokenomics", title: "$HIVRA tokenomics", description: "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect." });
export default function TokenomicsPage() {
  return <PublicSite><main id="main-content"><FullTokenomicsSection headingLevel={1} /></main></PublicSite>;
}
