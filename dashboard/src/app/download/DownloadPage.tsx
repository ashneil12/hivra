import type { ReactNode } from "react";
import { Download } from "lucide-react";

import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import { getDesktopDownloads, PUBLIC_PROJECT_LINKS, type DesktopDownloads } from "@/lib/public-project-links";
import editorial from "../../components/public-editorial/secondary-site.module.css";
import styles from "./download.module.css";

const SUPPORT_EMAIL = "info@hivra.cloud";

const PLATFORMS = [
  { id: "macos", name: "macOS", downloadName: "Mac" },
  { id: "windows", name: "Windows", downloadName: "Windows" },
  { id: "linux", name: "Linux", downloadName: "Linux" },
] as const;

/**
 * Published installers are shown only when desktop sign-in is available; pending
 * platforms say so plainly rather than inventing a release.
 */
export default function DownloadPage({
  downloads = getDesktopDownloads(),
  browserHref = PUBLIC_PROJECT_LINKS.browser,
  paidSleep = false,
}: {
  downloads?: DesktopDownloads;
  browserHref?: string;
  paidSleep?: boolean;
}): ReactNode {
  return (
    <main className={editorial.main} id="main-content">
      <header className={editorial.masthead}>
        <h1>Hivra on your computer.</h1>
        <p>
          Some work is easier when you can reach your agents without keeping another browser tab open.
          {" Use Hivra in your browser or install an app where available."}
        </p>
      </header>

      <div className={styles.sections}>
        {PLATFORMS.map(({ id, name, downloadName }) => {
          const release = downloads[id];
          return (
            <section key={id} className={styles.section} aria-labelledby={`download-${id}-heading`}>
              <h2 id={`download-${id}-heading`}>{name}</h2>
              <div className={styles.body}>
                {release.status === "published" ? (
                  <div className={styles.state} data-state={release.status}>
                    <p id={`download-${id}-status`}>{release.label}</p>
                    <a
                      className={styles.stateButton}
                      href={release.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-describedby={`download-${id}-status`}
                    >
                      Download for {downloadName}
                      <Download size={17} aria-hidden="true" />
                    </a>
                  </div>
                ) : (
                  <p>Public download coming soon.</p>
                )}
                {id === "macos" && release.status === "published" ? (
                  <p>
                    Hivra for Mac is a desktop client for your remote computers. It does not launch a hosted macOS computer.
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}

        <section className={styles.section} aria-labelledby="download-browser-heading">
          <h2 id="download-browser-heading">Browser</h2>
          <div className={styles.body}>
            <p>You can also use Hivra in your browser.</p>
            <ActionLinks items={[{ label: "Open Hivra", href: browserHref, kind: "primary" }]} />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="download-where-heading">
          <h2 id="download-where-heading">Keep the work where it belongs</h2>
          <div className={styles.body}>
            <p>
              Your Hivra-hosted computers run remotely. Closing the app doesn&rsquo;t stop them.
              {paidSleep && " Computers with idle sleep enabled can sleep when idle. Open one again to wake it."}
              {" Individual agent workflows can still stop, fail or reach their own usage limits."}
            </p>
            <p>
              Need help installing or signing in? Reach us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
