import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import styles from "../public-site/public-site.module.css";

const COLUMNS = [
  { title: "Product", links: [
    { label: "Agents", href: "/#agents" },
    { label: "Computers", href: "/#computers" },
    { label: "Hosting & self-hosting", href: "/#hosting" },
    { label: "Pricing", href: "/#pricing" },
    { label: "Roadmap", href: "/roadmap" },
    { label: "Changelog", href: "/changelog" },
    { label: "Status", href: "/status" },
  ] },
  { title: "Explore", links: [
    { label: "Open source", href: "/#open-source" },
    { label: "GitHub", href: "https://github.com/ashneil12/hivra" },
    { label: "Litepaper", href: "/docs/litepaper/" },
    { label: "Blog", href: "/blog" },
    { label: "Download the app", href: "/download" },
    { label: "Ecosystem", href: "/ecosystem" },
    { label: "Token", href: "/token" },
    { label: "Nibbii", href: "https://nibbii.pet/" },
  ] },
  { title: "Company", links: [
    { label: "Why I’m building Hivra", href: "/why-hivra" },
    { label: "Stats", href: "/stats" },
    { label: "Contact", href: "mailto:info@hermesos.cloud" },
    { label: "Terms", href: "/terms" },
    { label: "Privacy", href: "/privacy" },
  ] },
];

export default function Footer() {
  return (
    <footer className={styles.footer} data-public-footer>
      <div className={`${styles.footerTop} ${styles.footerCompact}`}>
        <div className={styles.footerColumns}>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <h2>{column.title}</h2>
              {column.links.map(({ label, href }) => (
                <Link key={href} href={href} {...(href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                  {label}{href.startsWith("https://") && <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" />}
                </Link>
              ))}
            </nav>
          ))}
        </div>
      </div>
      <Link href="/" className={styles.footerWordmark} aria-label="Hivra, back to homepage">Hivra<span aria-hidden="true">.</span></Link>
      <div className={styles.footerBottom}>
        <p>Powered by Hivra</p>
        <Link href="/why-hivra/evolution">Formerly HermesOS<ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" /></Link>
        <p>© Hivra</p>
      </div>
    </footer>
  );
}
