// tmux cheat sheet (/tools/tmux-cheat-sheet).
//
// HTML first: this is a server component, so the whole sheet (every key,
// command and explanation) is in the page source without any script. Only the
// copy buttons and the command builder are client islands. The data lives in
// lib/tools/tmux-sheet.ts with its source and verified date.
//
// Copy discipline: "windows" is tmux vocabulary and is never capitalised here,
// because the public-copy rules ban the capitalised operating-system name.

import Image from "next/image";
import Link from "next/link";

import styles from "@/app/tools/tools.module.css";
import CopyButton from "./CopyButton";
import Prose, { Cmd } from "./InlineCode";
import TmuxAgentBuilder from "./TmuxAgentBuilder";
import {
  TMUX_AGENT_SECTION,
  TMUX_DIAGRAM,
  TMUX_FACTS,
  TMUX_HIERARCHY_ALT,
  TMUX_HIERARCHY_TEXT,
  TMUX_KEYS_NOTE,
  TMUX_SECTIONS,
  TMUX_SLEEP_NOTE,
  TMUX_TARGET_NOTE,
  type AgentRow,
  type CheatRow,
} from "@/lib/tools/tmux-sheet";
import { toolPath } from "@/lib/tools/tool-catalog";
import { monthYear } from "@/lib/tools/month-year";

function Row({ row }: { row: CheatRow | AgentRow }) {
  const keys = "keys" in row ? row.keys : undefined;
  const command = "command" in row ? row.command : undefined;
  return (
    <li className={styles.sheetRow}>
      <div className={styles.sheetKeys}>
        {keys && <kbd className={styles.kbd}>{keys}</kbd>}
        {command && <Cmd command={command} />}
      </div>
      <p className={styles.sheetDoes}>
        <Prose text={row.does} />
      </p>
      {command && <CopyButton text={command} compact ariaLabel={`Copy: ${command}`} />}
    </li>
  );
}

export default function TmuxCheatSheetTool() {
  const jumpLinks = [
    { id: "parts", label: "How the parts fit" },
    ...TMUX_SECTIONS.map((section) => ({ id: section.id, label: section.title.replace(/ \(.*\)$/, "") })),
    { id: TMUX_AGENT_SECTION.id, label: "AI coding agents" },
    { id: "builder", label: "Command builder" },
  ];

  return (
    <div className={styles.tool}>
      <p className={styles.note} style={{ marginBottom: 16 }}>
        {TMUX_KEYS_NOTE}
      </p>
      <nav aria-label="Sections of the cheat sheet" className={styles.jumpNav}>
        <ul>
          {jumpLinks.map((link) => (
            <li key={link.id}>
              <a href={`#${link.id}`}>{link.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <section id="parts" className={styles.sheetSection} aria-labelledby="parts-heading">
        <h2 className={styles.h3} id="parts-heading">
          How the parts fit together
        </h2>
        <p className={styles.sheetIntro}>{TMUX_HIERARCHY_TEXT}</p>
        <figure className={styles.diagram}>
          <Image src={TMUX_DIAGRAM.src} width={TMUX_DIAGRAM.width} height={TMUX_DIAGRAM.height} alt={TMUX_HIERARCHY_ALT} className={styles.diagramImg} />
          <figcaption>
            <a href={TMUX_DIAGRAM.src} target="_blank" rel="noopener">
              Open the diagram on its own
            </a>{" "}
            to print it or save it as an SVG.
          </figcaption>
        </figure>
      </section>

      {TMUX_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className={styles.sheetSection} aria-labelledby={`${section.id}-heading`}>
          <h2 className={styles.h3} id={`${section.id}-heading`}>
            {section.title}
          </h2>
          <p className={styles.sheetIntro}>{section.intro}</p>
          <ul className={styles.sheetRows}>
            {section.rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
        </section>
      ))}

      <section id={TMUX_AGENT_SECTION.id} className={styles.sheetSection} aria-labelledby={`${TMUX_AGENT_SECTION.id}-heading`}>
        <h2 className={styles.h3} id={`${TMUX_AGENT_SECTION.id}-heading`}>
          {TMUX_AGENT_SECTION.title}
        </h2>
        <p className={styles.sheetIntro}>{TMUX_AGENT_SECTION.intro}</p>
        <ul className={styles.sheetRows}>
          {TMUX_AGENT_SECTION.rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
        <p className={styles.verdict} style={{ marginTop: 24 }}>
          {TMUX_SLEEP_NOTE}
        </p>
        <p className={styles.note}>
          To keep the laptop awake while a session runs, see the <Link href={toolPath("keep-mac-awake")}>keep-awake command builder</Link>. To
          check your whole setup, use the <Link href={toolPath("agent-survival-check")}>agent survival check</Link>.
        </p>
      </section>

      <p className={styles.note}>
        {`${TMUX_TARGET_NOTE} Keys and commands last checked ${monthYear(TMUX_FACTS.lastVerified)} against the tmux manual. The method section below links it.`}
      </p>

      <TmuxAgentBuilder />
    </div>
  );
}
