import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { GitHubMark } from "@/components/public-site/SourceLink";
import RepoCard from "./RepoCard";
import { OPEN_SOURCE, SELF_HOST_SOURCE_URL } from "./content";
import styles from "./home.module.css";
import { glossify } from "@/components/gloss/glossify";

export default function OpenSource() {
  return (
    <section id="open-source" className={styles.open} aria-labelledby="open-source-heading">
      <div className={styles.openCopy}>
        <span className={styles.eyebrow} aria-hidden="true" />
        <h2 id="open-source-heading" className={`${styles.sectionTitle} ${styles.openTitle}`}>{OPEN_SOURCE.title}</h2>
        {OPEN_SOURCE.body.map(line => <p key={line} className={styles.bodyText}>{glossify(line)}</p>)}
        <div className={styles.openActions}>
          <a href={SELF_HOST_SOURCE_URL} className={styles.githubCta} target="_blank" rel="noopener noreferrer" data-cta="open-github">
            <GitHubMark />
            {OPEN_SOURCE.github}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <Link href={OPEN_SOURCE.security.href} className={styles.textCta} data-cta="open-security">
            {OPEN_SOURCE.security.label}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
      <RepoCard owner={OPEN_SOURCE.repoOwner} name={OPEN_SOURCE.repoName} clone={OPEN_SOURCE.clone} />
    </section>
  );
}
