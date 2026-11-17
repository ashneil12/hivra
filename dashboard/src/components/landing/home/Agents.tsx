import Link from "next/link";
import { ArrowRight, Monitor } from "lucide-react";
import AgentGrid from "./AgentGrid";
import { AGENTS_SECTION, COMPUTERS, HOME_AGENTS } from "./content";
import styles from "./home.module.css";

/** The agents, one click each into Launch, then a single line for people who only want a computer. Anchors #launch, #agents and #computers stay. */
export default function Agents() {
  return (
    <section id="launch" className={styles.agents} aria-labelledby="agents-heading">
      <span id="agents" className={styles.anchor} aria-hidden="true" />
      <header className={styles.sectionHead}>
        <h2 id="agents-heading" className={styles.sectionTitle}>
          {AGENTS_SECTION.title} <em>{AGENTS_SECTION.titleTail}</em>
        </h2>
        <p className={styles.bodyText}>{AGENTS_SECTION.intro}</p>
      </header>
      <AgentGrid agents={HOME_AGENTS} />
      <div className={styles.agentsFoot}>
        <Link href="/agents" className={styles.inlineLink} data-cta="agents-compare">
          {AGENTS_SECTION.compare}
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>
      <p id="computers" className={styles.computerLine}>
        <Monitor size={18} aria-hidden="true" />
        <span>{COMPUTERS.lead}</span>
        <a href={COMPUTERS.href} className={styles.inlineLink} data-cta="computer-ubuntu">
          {COMPUTERS.label}
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      </p>
      <p className={styles.srOnly}>{AGENTS_SECTION.screensNote}</p>
    </section>
  );
}
