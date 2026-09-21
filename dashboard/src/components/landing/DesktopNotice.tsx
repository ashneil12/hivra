import { ArrowRight, Monitor } from "lucide-react";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
import styles from "./relaunch.module.css";

export default function DesktopNotice() {
  return <aside id="downloads" className={styles.desktop} aria-label="Desktop apps">
    <Monitor size={24} strokeWidth={1.5} aria-hidden="true" />
    <p>Desktop apps are on the way. Hivra works in your browser today.</p>
    <a href={PUBLIC_PROJECT_LINKS.browser}>Open Hivra in your browser<ArrowRight size={17} aria-hidden="true" /></a>
  </aside>;
}
