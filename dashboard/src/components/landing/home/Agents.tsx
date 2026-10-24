import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Monitor } from "lucide-react";
import AgentGrid from "./AgentGrid";
import { AGENTS_SECTION, COMPUTERS, HOME_AGENTS } from "./content";
import styles from "./home.module.css";

/** Agents first, by name, then the computer on its own. Anchors #launch, #agents and #computers stay. */
export default function Agents() {
  return (
    <section id="launch" className={styles.agents} aria-labelledby="agents-heading">
      <span id="agents" className={styles.anchor} aria-hidden="true" />
      <header className={styles.sectionHead}>
        <span className={styles.eyebrow} aria-hidden="true" />
        <h2 id="agents-heading" className={styles.sectionTitle}>{AGENTS_SECTION.title}</h2>
        <p className={styles.bodyText}>{AGENTS_SECTION.paid}</p>
      </header>
      <AgentGrid agents={HOME_AGENTS} />
      <p className={styles.agentsFoot}>
        <span>{AGENTS_SECTION.screensNote}</span>
        <Link href="/agents" className={styles.textCta} data-cta="agents-compare">
          {AGENTS_SECTION.compare}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </p>
      <div id="computers" className={styles.computers}>
        <div className={styles.computersCopy}>
          <Monitor size={22} aria-hidden="true" />
          <h3>{COMPUTERS.title}</h3>
          {COMPUTERS.body.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
          <div className={styles.computersActions}>
            <a href={COMPUTERS.ubuntu.href} className={styles.primaryCta} data-cta="computer-ubuntu">
              <span>{COMPUTERS.ubuntu.label}</span>
              <ArrowUpRight size={18} aria-hidden="true" />
            </a>
            <a href={COMPUTERS.explore.href} className={styles.textCta} data-cta="computers-explore">
              {COMPUTERS.explore.label}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className={styles.computersVisual}>
          <figure className={styles.ubuntuArt}>
            <Image src="/images/computers/ubuntu-workspace.webp" alt="" width={1536} height={1024} sizes="(max-width: 760px) 100vw, 520px" unoptimized loading="lazy" />
            <figcaption>{COMPUTERS.ubuntu.name}</figcaption>
          </figure>
          <ul className={styles.previewChips} aria-label="More computers">
            {COMPUTERS.others.map(other => (
              <li key={other.name}>
                <a href={other.href} data-cta={`computer-${other.name.toLowerCase()}`}>
                  <span className={styles.chipText}>
                    <strong>{other.name}</strong> <small>{other.note}</small>
                  </span>
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
