import { AppWindow, ArrowRight, Command, Download, Laptop } from "lucide-react";
import { getDesktopDownloads, PUBLIC_PROJECT_LINKS, type DesktopDownloads } from "@/lib/public-project-links";
import styles from "./downloads.module.css";

const PLATFORMS = [
  { id: "macos", name: "macOS", downloadName: "Mac", icon: Command },
  { id: "windows", name: "Windows", downloadName: "Windows", icon: AppWindow },
  { id: "linux", name: "Linux", downloadName: "Linux", icon: Laptop },
] as const;

export default function DownloadsSection({ downloads = getDesktopDownloads(), headingLevel = 2 }: { downloads?: DesktopDownloads; headingLevel?: 1 | 2 }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const hasRelease = PLATFORMS.some(platform => downloads[platform.id].status === "published");

  return <section id="downloads" className={styles.section} aria-labelledby="downloads-heading">
    <div className={styles.intro}>
      <span className={styles.eyebrow}>Desktop apps</span>
      <Heading id="downloads-heading">Hivra on<br /><em>your desktop.</em></Heading>
      <p>{hasRelease ? "Choose the app for your computer, or open Hivra in your browser." : "Desktop downloads are on the way. You can use Hivra in your browser today."}</p>
      <a className={styles.browserLink} href={PUBLIC_PROJECT_LINKS.browser}>Open Hivra in your browser<ArrowRight size={17} aria-hidden="true" /></a>
    </div>
    <div className={styles.downloads}>
      {PLATFORMS.map(({ id, name, downloadName, icon: Icon }) => {
        const release = downloads[id];
        return <article key={id} className={styles.platform}>
          <div className={styles.platformHeading}><Icon size={29} strokeWidth={1.4} aria-hidden="true" /><h3>For {name}</h3></div>
          <p id={`download-${id}-status`}>{release.status === "published" ? release.label : "Public download coming soon."}</p>
          {release.status === "published"
            ? <a href={release.href} target="_blank" rel="noopener noreferrer" aria-describedby={`download-${id}-status`} className={styles.downloadButton}>Download for {downloadName}<Download size={17} aria-hidden="true" /></a>
            : <button type="button" disabled aria-describedby={`download-${id}-status`} className={styles.downloadButton}>Download for {name}<span>Coming soon</span></button>}
        </article>;
      })}
    </div>
  </section>;
}
