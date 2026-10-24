import type { Metadata } from "next";
import PublicSite from "@/components/public-site/PublicSite";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import editorial from "../../components/public-editorial/secondary-site.module.css";
import DownloadPage from "./DownloadPage";

// The finished browser title from the website pack, so it skips the layout's " | Hivra" suffix (absoluteTitle).
const TITLE = "Download Hivra | Desktop Availability";
const DESCRIPTION = "The Hivra desktop app for macOS is coming soon. Open Hivra in your browser today.";

// buildWebsiteMetadata sets only canonical, Open Graph and Twitter fields, so the
// page title and description must be set here or the site defaults show instead.
export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/download", title: TITLE, description: DESCRIPTION }),
};

export default function DownloadRoute() {
  return (
    <PublicSite className={editorial.page} data-page="download">
      <DownloadPage />
    </PublicSite>
  );
}
