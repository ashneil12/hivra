import type { Metadata } from "next";
import PublicSite from "@/components/public-site/PublicSite";
import DownloadsSection from "@/components/landing/DownloadsSection";
import { buildWebsiteMetadata } from "@/lib/metadata";

const TITLE = "Download Hivra";
const DESCRIPTION = "The Hivra desktop app for macOS is coming soon. Open Hivra in your browser today.";

// buildWebsiteMetadata sets only canonical, Open Graph and Twitter fields, so the
// page title and description must be set here or the site defaults show instead.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/download", title: TITLE, description: DESCRIPTION }),
};
export default function DownloadPage() {
  return <PublicSite><main id="main-content"><DownloadsSection headingLevel={1} /></main></PublicSite>;
}
