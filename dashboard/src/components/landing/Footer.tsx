import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
import PublicLink, { LITEPAPER_HREF } from "../public-site/PublicLink";
import styles from "../public-site/public-site.module.css";

const COLUMNS = [
  { title: "Product", links: [
    { label: "Agents", href: "/agents" },
    { label: "Computers", href: "/#computers" },
    { label: "Hosting & self-hosting", href: "/#hosting" },
    { label: "Pricing", href: "/pricing" },
    { label: "Roadmap", href: "/roadmap" },
    { label: "Changelog", href: "/changelog" },
    { label: "Status", href: "/status" },
  ] },
  { title: "Explore", links: [
    { label: "Open source", href: "/#open-source" },
    { label: "GitHub", href: "https://github.com/ashneil12/hivra" },
    { label: "X (@HivraOS)", href: PUBLIC_PROJECT_LINKS.x },
    { label: "Litepaper", href: LITEPAPER_HREF, tokenSurface: true },
    { label: "Blog", href: "/blog" },
    { label: "Free tools", href: "/tools" },
    { label: "Download the app", href: "/download" },
    { label: "Ecosystem", href: "/ecosystem" },
    { label: "Token", href: "/token", tokenSurface: true },
  ] },
  { title: "Company", links: [
    { label: "About", href: "/about" },
    { label: "Why I’m building Hivra", href: "/why-hivra" },
    { label: "Stats", href: "/stats" },
    { label: "Contact", href: "mailto:info@hivra.cloud" },
    { label: "Security", href: "/security" },
    { label: "Terms", href: "/terms" },
    { label: "Privacy", href: "/privacy" },
  ] },
];

export default function Footer({ tokenSurfaces = false }: { tokenSurfaces?: boolean } = {}) {
  return (
    <footer className={styles.footer} data-public-footer>
      <div className={`${styles.footerTop} ${styles.footerCompact}`}>
        <div className={styles.footerColumns}>
          {COLUMNS.map((column) => ({ ...column, links: column.links.filter((link) => tokenSurfaces || !("tokenSurface" in link)) })).map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <h2>{column.title}</h2>
              {column.links.map(({ label, href }) => (
                <PublicLink key={href} href={href} {...(href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                  {label}{href.startsWith("https://") && <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" />}
                </PublicLink>
              ))}
            </nav>
          ))}
        </div>
      </div>
      <Link href="/" className={styles.footerWordmark} aria-label="Hivra, back to homepage">Hivra<span aria-hidden="true">.</span></Link>
      <div className={styles.footerBottom}>
        <p>Powered by Hivra</p>
        {tokenSurfaces ? <Link href="/why-hivra/evolution">Formerly HermesOS<ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" /></Link> : <p>Formerly HermesOS</p>}
        <p>© Hivra</p>
      </div>
    </footer>
  );
}
