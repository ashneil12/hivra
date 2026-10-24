import type { Metadata } from "next";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { Inline } from "@/lib/inline-copy";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import local from "./security.module.css";
import { SECURITY_COPY } from "./security-content";

const TITLE = "Hivra Security | Vulnerability Reporting and Security Boundaries";
const DESCRIPTION =
  "Report a Hivra vulnerability privately, learn which versions receive fixes and understand the limits of our agent security model.";

// A trust page: who to tell, how, and what Hivra does and does not claim. The contacts
// are the ones in the public repository's SECURITY.md (lib/security-contact.ts), and
// /.well-known/security.txt reads the same constants.
export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/security", title: TITLE, description: DESCRIPTION }),
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
      name: TITLE,
      description: DESCRIPTION,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
  ],
};

export default function SecurityPage() {
  const { masthead, position, report, versions, model, implementation, questions } = SECURITY_COPY;
  return (
    <PublicSite className={styles.page} data-page="security">
      <StructuredData schema={securitySchema} />
      <main className={`${styles.main} ${local.end}`} id="main-content">
        <Breadcrumbs items={[{ label: "Security" }]} />
        <header className={styles.masthead}>
          <h1>{masthead.heading}</h1>
          <p>{masthead.lede}</p>
        </header>
        <div className={local.position}>
          {position.map((paragraph) => (
            <p key={paragraph}>
              <Inline text={paragraph} />
            </p>
          ))}
        </div>
        <div className={styles.articleBody}>
          <section className={local.row} aria-labelledby="security-report">
            <h2 id="security-report" className={local.rowTitle}>
              {report.heading}
            </h2>
            <div className={local.rowBody}>
              <p>{report.intro}</p>
              <ul className={local.channels}>
                {report.channels.map((channel) => (
                  <li key={channel.label}>
                    <strong className={local.channelLabel}>{channel.label}</strong>
                    <span className={local.channelBody}>
                      <Inline text={channel.body} />
                    </span>
                  </li>
                ))}
              </ul>
              <p>{report.notPolished}</p>
              <p>{report.includeLead}</p>
              <ol className={local.steps}>
                {report.include.map((item) => (
                  <li key={item}>
                    <Inline text={item} />
                  </li>
                ))}
              </ol>
              <p>{report.credentials}</p>
              <h3 className={local.subhead}>{report.testing.heading}</h3>
              {report.testing.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <p className={local.note}>
                <Inline text={report.testing.responseTimes} />
              </p>
            </div>
          </section>
          <section className={local.row} aria-labelledby="security-versions">
            <h2 id="security-versions" className={local.rowTitle}>
              {versions.heading}
            </h2>
            <div className={local.rowBody}>
              {versions.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </section>
          <section className={local.row} aria-labelledby="security-model">
            <h2 id="security-model" className={local.rowTitle}>
              {model.heading}
            </h2>
            <div className={local.rowBody}>
              {model.paragraphs.map((paragraph) => (
                <p key={paragraph}>
                  <Inline text={paragraph} />
                </p>
              ))}
              <p>{model.limitsLead}</p>
              <ul className={local.limits}>
                {model.limits.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
              <p>{model.goals}</p>
            </div>
          </section>
          <section className={local.row} aria-labelledby="security-implementation">
            <h2 id="security-implementation" className={local.rowTitle}>
              {implementation.heading}
            </h2>
            <div className={local.rowBody}>
              <p>{implementation.intro}</p>
              <ul className={local.sources}>
                {implementation.links.map((link) => (
                  <li key={link}>
                    <Inline text={link} />
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <section className={local.row} aria-labelledby="security-questions">
            <h2 id="security-questions" className={local.rowTitle}>
              {questions.heading}
            </h2>
            <div className={local.rowBody}>
              <p>
                <Inline text={questions.body} />
              </p>
            </div>
          </section>
        </div>
      </main>
    </PublicSite>
  );
}
