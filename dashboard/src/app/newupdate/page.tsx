import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import PublicSite from "@/components/public-site/PublicSite";
import { EditorialArt } from "@/components/public-editorial/Editorial";
import styles from "../../components/public-editorial/secondary-site.module.css";
import { PUBLIC_START_HREF } from "@/lib/public-start";
export const metadata: Metadata = {
  title: "Venice Multimodal Agents | Hivra",
  robots: {
    index: false,
    follow: false,
  },
};

export default function NewUpdatePage() {
 return <PublicSite className={styles.page} data-page="newupdate"><main className={styles.announcement} id="main-content"><div><span className={styles.eyebrow}>Hivra</span><h1><span>Venice</span><span>Multimodal</span><span>Agents Live</span></h1><p>One Venice key. Persistent multimodal Hermes agents.</p><Link className={styles.button} href={PUBLIC_START_HREF}>Deploy your agent<ArrowUpRight size={20} aria-hidden="true" /></Link></div><EditorialArt label="Venice · Multimodal" number="AI" /></main></PublicSite>;
}
