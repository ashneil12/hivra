import PublicSite from "@/components/public-site/PublicSite";
import DownloadsSection from "@/components/landing/DownloadsSection";
import { buildWebsiteMetadata } from "@/lib/metadata";

export const metadata = buildWebsiteMetadata({ path: "/download", title: "Download Hivra", description: "The Hivra desktop app for macOS is coming soon. Open Hivra in your browser today." });
export default function DownloadPage() {
  return <PublicSite><main id="main-content"><DownloadsSection headingLevel={1} /></main></PublicSite>;
}
