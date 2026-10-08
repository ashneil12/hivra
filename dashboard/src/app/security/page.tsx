import type { Metadata } from "next";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs, EditorialMarkdownLink } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { REPORT_INCLUDES, SECURITY_DESCRIPTION, SECURITY_SECTIONS, SECURITY_TITLE } from "./security-content";

// A trust page: who to tell, how, and what Hivra does and does not claim. The
// contact and the wording come from the public repository's SECURITY.md
// (security-content.ts), and /.well-known/security.txt reads the same constants.
export const metadata: Metadata = {
  title: SECURITY_TITLE,
  description: SECURITY_DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/security", title: SECURITY_TITLE, description: SECURITY_DESCRIPTION }),
};

const securitySchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Security", item: `${SITE_URL}/security` },
      ],
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_URL}/security#webpage`,
      url: `${SITE_URL}/security`,
      name: SECURITY_TITLE,
      description: SECURITY_DESCRIPTION,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
  ],
};

export default function SecurityPage() {
  const { report, versions, claims, links } = SECURITY_SECTIONS;
  return (
    <PublicSite className={styles.page} data-page="security">
      <StructuredData schema={securitySchema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "Security" }]} />
        <header className={styles.masthead}>
          <span className={styles.eyebrow}>Security</span>
          <h1>
            Report a <strong>security problem.</strong>
          </h1>
          <p>Tell Hivra privately, and read what Hivra does and does not claim about its own security.</p>
        </header>
        <div className={styles.articleBody}>
          <section aria-labelledby="security-report">
            <h2 id="security-report">{report.heading}</h2>
            <p>{report.intro}</p>
            <ul>
              {report.channels.map((channel) => (
                <li key={channel.href}>
                  <EditorialMarkdownLink href={channel.href}>{channel.label}</EditorialMarkdownLink>
                </li>
              ))}
            </ul>
            <p>{report.includeLead}</p>
            <ul>
              {REPORT_INCLUDES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>{report.keys}</p>
            <p>{report.care}</p>
            <p>{report.response}</p>
          </section>
          <section aria-labelledby="security-versions">
            <h2 id="security-versions">{versions.heading}</h2>
            <p>{versions.body}</p>
          </section>
          <section aria-labelledby="security-claims">
            <h2 id="security-claims">{claims.heading}</h2>
            {claims.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
          <section aria-labelledby="security-links">
            <h2 id="security-links">{links.heading}</h2>
            <ul>
              {links.items.map((item) => (
                <li key={item.href}>
                  {item.href.startsWith("https://") ? (
                    <EditorialMarkdownLink href={item.href}>{item.label}</EditorialMarkdownLink>
                  ) : (
                    <a href={item.href}>{item.label}</a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </PublicSite>
  );
}
