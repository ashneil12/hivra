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
        <span className={styles.eyebrow}>{AGENTS_SECTION.eyebrow}</span>
        <h2 id="agents-heading" className={styles.sectionTitle}>
          {AGENTS_SECTION.title} <em>{AGENTS_SECTION.titleTail}</em>
        </h2>
        <p className={styles.bodyText}>{AGENTS_SECTION.subhead}</p>
      </header>
      <AgentGrid agents={HOME_AGENTS} />
      <p className={styles.agentsFoot}>
        <span>{AGENTS_SECTION.screensNote}</span>
        <Link href="/agents" className={styles.textCta}>
          {AGENTS_SECTION.compare}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </p>
      <div id="computers" className={styles.computers}>
        <div className={styles.computersCopy}>
          <Monitor size={22} aria-hidden="true" />
          <h3>{COMPUTERS.title}</h3>
          <p>{COMPUTERS.body}</p>
        </div>
        <a href={COMPUTERS.ubuntu.href} className={styles.ubuntuCard} data-cta="computer-ubuntu">
          <span className={styles.ubuntuArt}>
            <Image src="/images/computers/ubuntu-workspace.webp" alt="" width={1536} height={1024} sizes="(max-width: 760px) 100vw, 420px" unoptimized loading="lazy" />
          </span>
          <span className={styles.ubuntuMeta}>
            <strong>Ubuntu</strong>
            <small>Available now</small>
          </span>
          <span className={styles.ubuntuCta}>
            {COMPUTERS.ubuntu.label}
            <ArrowUpRight size={16} aria-hidden="true" />
          </span>
        </a>
        <ul className={styles.previewChips} aria-label="Private preview computers">
          {COMPUTERS.previews.map(preview => (
            <li key={preview.name}>
              <a href={preview.href}>
                <strong>{preview.name}</strong>
                <small>Private preview</small>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
