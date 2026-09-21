import { ArrowRight, Command, Download, Monitor } from "lucide-react";
import { PUBLIC_PROJECT_LINKS, type DesktopDownloads } from "@/lib/public-project-links";
import styles from "./downloads.module.css";

const PLATFORMS = [
  { id: "macos", name: "macOS", icon: Command },
  { id: "windows", name: "Windows", icon: Monitor },
] as const;

export default function DownloadsSection({ downloads = PUBLIC_PROJECT_LINKS.desktop }: { downloads?: DesktopDownloads }) {
  const hasRelease = PLATFORMS.some(platform => downloads[platform.id].status === "published");

  return <section id="downloads" className={styles.section} aria-labelledby="downloads-heading">
    <div className={styles.intro}>
      <span className={styles.eyebrow}>Desktop apps</span>
      <h2 id="downloads-heading">Hivra on<br /><em>your desktop.</em></h2>
      <p>{hasRelease ? "Choose the app for your computer, or open Hivra in your browser." : "Desktop downloads are on the way. You can use Hivra in your browser today."}</p>
      <a className={styles.browserLink} href={PUBLIC_PROJECT_LINKS.browser}>Open Hivra in your browser<ArrowRight size={17} aria-hidden="true" /></a>
    </div>
    <div className={styles.downloads}>
      {PLATFORMS.map(({ id, name, icon: Icon }) => {
        const release = downloads[id];
        return <article key={id} className={styles.platform}>
          <div className={styles.platformHeading}><Icon size={29} strokeWidth={1.4} aria-hidden="true" /><h3>For {name}</h3></div>
          <p id={`download-${id}-status`}>{release.status === "published" ? release.label : "Public download coming soon."}</p>
          {release.status === "published"
            ? <a href={release.href} target="_blank" rel="noopener noreferrer" aria-describedby={`download-${id}-status`} className={styles.downloadButton}>Download for {name}<Download size={17} aria-hidden="true" /></a>
            : <button type="button" disabled aria-describedby={`download-${id}-status`} className={styles.downloadButton}>Download for {name}<span>Coming soon</span></button>}
        </article>;
      })}
    </div>
  </section>;
}
