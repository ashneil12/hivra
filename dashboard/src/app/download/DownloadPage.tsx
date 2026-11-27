import type { ReactNode } from "react";
import { Download } from "lucide-react";

import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import { getDesktopDownloads, PUBLIC_PROJECT_LINKS, type DesktopDownloads } from "@/lib/public-project-links";
import { paidKvmSleepAvailable } from "@/lib/hivra/paid-kvm-sleep-availability";
import editorial from "../../components/public-editorial/secondary-site.module.css";
import styles from "./download.module.css";

const SUPPORT_EMAIL = "info@hivra.cloud";

/**
 * The macOS section does not advertise the installer when desktop sign-in is unavailable.
 */
export default function DownloadPage({
  downloads = getDesktopDownloads(),
  browserHref = PUBLIC_PROJECT_LINKS.browser,
}: {
  downloads?: DesktopDownloads;
  browserHref?: string;
}): ReactNode {
  const mac = downloads.macos;

  return (
    <main className={editorial.main} id="main-content">
      <header className={editorial.masthead}>
        <h1>Hivra on your computer.</h1>
        <p>
          Some work is easier when you can reach your agents without keeping another browser tab open.
          {" Use Hivra in your browser or install the Mac app where available."}
        </p>
      </header>

      <div className={styles.sections}>
        <section className={styles.section} aria-labelledby="download-macos-heading">
          <h2 id="download-macos-heading">macOS</h2>
          <div className={styles.body}>
            {mac.status === "published" && (
              <div className={styles.state} data-state={mac.status}>
                <p id="download-macos-status">{mac.label}</p>
                <a
                  className={styles.stateButton}
                  href={mac.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-describedby="download-macos-status"
                >
                  Download for Mac
                  <Download size={17} aria-hidden="true" />
                </a>
              </div>
            )}
            {mac.status === "published" ? (
              <p>
                Hivra for Mac is a desktop client for your remote computers. It does not launch a hosted macOS computer.
              </p>
            ) : null}
            <p>You can also use Hivra in your browser.</p>
            <ActionLinks items={[{ label: "Open Hivra", href: browserHref, kind: "primary" }]} />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="download-where-heading">
          <h2 id="download-where-heading">Keep the work where it belongs</h2>
          <div className={styles.body}>
            <p>
              Your Hivra-hosted computers run remotely. Closing the Mac app doesn&rsquo;t stop them.
              {paidKvmSleepAvailable() && " Computers with idle sleep enabled can sleep when idle. Open one again to wake it."}
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
