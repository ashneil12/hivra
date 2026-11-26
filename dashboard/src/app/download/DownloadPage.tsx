import type { ReactNode } from "react";
import { Download } from "lucide-react";

import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import {
  PUBLIC_PROJECT_LINKS,
  type DesktopDownloads,
} from "@/lib/public-project-links";
import editorial from "../../components/public-editorial/secondary-site.module.css";
import styles from "./download.module.css";

const SUPPORT_EMAIL = "info@hivra.cloud";
const DESKTOP_SECTIONS = [
  { id: "macos", name: "macOS" },
  { id: "windows", name: "Windows" },
] as const;

/**
 * /download, in Ash's words (08-download.md). What each desktop section says comes from one record,
 * PUBLIC_PROJECT_LINKS.desktop: while it is "pending" there is no installer and the page says
 * so; when it becomes "published" the page links that release and shows its label. No address, version
 * or waitlist is written here.
 */
export default function DownloadPage({
  downloads = PUBLIC_PROJECT_LINKS.desktop,
  browserHref = PUBLIC_PROJECT_LINKS.browser,
}: {
  downloads?: DesktopDownloads;
  browserHref?: string;
}): ReactNode {
  return (
    <main className={editorial.main} id="main-content">
      <header className={editorial.masthead}>
        <h1>Hivra on your computer.</h1>
        <p>
          Some work is easier when you can reach your agents without keeping
          another browser tab open. This page is where you&rsquo;ll find
          supported desktop downloads and installation guidance.
        </p>
      </header>

      <div className={styles.sections}>
        {DESKTOP_SECTIONS.map((platform) => {
          const release = downloads[platform.id];
          const statusId = `download-${platform.id}-status`;
          return (
            <section
              key={platform.id}
              className={styles.section}
              aria-labelledby={`download-${platform.id}-heading`}
            >
              <h2 id={`download-${platform.id}-heading`}>{platform.name}</h2>
              <div className={styles.body}>
                <div className={styles.state} data-state={release.status}>
                  <p id={statusId}>
                    {release.status === "published"
                      ? release.label
                      : "Public download coming soon."}
                  </p>
                  {release.status === "published" ? (
                    <a
                      className={styles.stateButton}
                      href={release.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-describedby={statusId}
                    >
                      Download for {platform.name}
                      <Download size={17} aria-hidden="true" />
                    </a>
                  ) : (
                    <button
                      type="button"
                      className={styles.stateButton}
                      disabled
                      aria-describedby={statusId}
                    >
                      Download for {platform.name}
                      <Download size={17} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {release.status === "published" ? (
                  <p>
                    Before installing, check that your computer meets the
                    supported system requirements and that the release comes
                    from an official Hivra distribution channel.
                  </p>
                ) : null}
                <p>
                  If the desktop app is not available for this computer yet, you
                  can still use Hivra in your browser.
                </p>
                <ActionLinks
                  items={[
                    { label: "Open Hivra", href: browserHref, kind: "primary" },
                  ]}
                />
              </div>
            </section>
          );
        })}

        <section
          className={styles.section}
          aria-labelledby="download-where-heading"
        >
          <h2 id="download-where-heading">Keep the work where it belongs</h2>
          <div className={styles.body}>
            <p>
              Your Hivra-hosted computers run remotely. A paid Hivra Cloud
              computer stays on and is not paused for inactivity. Closing the
              desktop app doesn&rsquo;t turn it into a local process, although
              individual agent workflows can still stop, fail or reach their own
              usage limits.
            </p>
            <p>
              Need help installing or signing in? Reach us at{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
