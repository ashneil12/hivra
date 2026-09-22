import PublicSite from "@/components/public-site/PublicSite";
import DownloadsSection from "@/components/landing/DownloadsSection";
import { buildWebsiteMetadata } from "@/lib/metadata";

export const metadata = buildWebsiteMetadata({ path: "/download", title: "Download Hivra", description: "Hivra desktop apps for macOS and Windows. Check download availability or open Hivra in your browser." });
export default function DownloadPage() {
  return <PublicSite><main id="main-content"><DownloadsSection headingLevel={1} /></main></PublicSite>;
}
