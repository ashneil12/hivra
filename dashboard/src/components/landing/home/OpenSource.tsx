import { ArrowUpRight } from "lucide-react";
import { GitHubMark } from "@/components/public-site/SourceLink";
import RepoCard from "./RepoCard";
import { OPEN_SOURCE, SELF_HOST_SOURCE_URL } from "./content";
import styles from "./home.module.css";

export default function OpenSource() {
  return (
    <section id="open-source" className={styles.open} aria-labelledby="open-source-heading">
      <div className={styles.openCopy}>
        <span className={styles.eyebrow}>{OPEN_SOURCE.eyebrow}</span>
        <h2 id="open-source-heading" className={styles.sectionTitle}>
          {OPEN_SOURCE.title} <em>{OPEN_SOURCE.titleTail}</em>
        </h2>
        {OPEN_SOURCE.body.map(line => <p key={line} className={styles.bodyText}>{line}</p>)}
        <div className={styles.openActions}>
          <a href={SELF_HOST_SOURCE_URL} className={styles.githubCta} target="_blank" rel="noopener noreferrer" data-cta="open-github">
            <GitHubMark />
            {OPEN_SOURCE.github}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <a href={OPEN_SOURCE.commitmentHref} className={styles.textCta}>
            {OPEN_SOURCE.commitment}
          </a>
        </div>
      </div>
      <RepoCard owner={OPEN_SOURCE.repoOwner} name={OPEN_SOURCE.repoName} clone={OPEN_SOURCE.clone} />
    </section>
  );
}
