"use client";

import { useMemo, useRef } from "react";
import { m, useScroll } from "framer-motion";
import { File, Folder, Scale } from "lucide-react";
import { GitHubMark } from "@/components/public-site/SourceLink";
import { CODE_WALL } from "./code-wall";
import { useMotionPref, useRange, useTypedLines, useVisible } from "./motion";
import styles from "./home.module.css";

const FILES: { name: string; dir?: boolean; note?: string }[] = [
  { name: "apps", dir: true },
  { name: "dashboard", dir: true },
  { name: "services", dir: true },
  { name: "docs", dir: true },
  { name: "LICENSE", note: "Apache-2.0" },
  { name: "README.md" },
];

const KEYWORD = /^(import|export|from|const|type|function|return|if|as|readonly|null)$/;

function CodeLine({ text }: { text: string }) {
  const parts = text.split(/(\s+|[{}()[\];,.:=<>!|?]|"[^"]*")/).filter(Boolean);
  return (
    <p>
      {parts.map((part, index) => (
        <span key={index} className={part.startsWith("\"") ? styles.codeStr : KEYWORD.test(part) ? styles.codeKw : undefined}>
          {part}
        </span>
      ))}
    </p>
  );
}

/** The public repository, with its real code scrolling behind it. */
export default function RepoCard({ owner, name, clone }: { owner: string; name: string; clone: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { off } = useMotionPref();
  const inView = useVisible(ref, { amount: 0.4, once: true });
  const lines = useMemo(() => [clone, "Cloning into 'hivra'... done."], [clone]);
  const typed = useTypedLines(lines, inView, { cps: 70, pause: 700, startDelay: 700 });
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const wallY = useRange(scrollYProgress, [0, 1], off ? [0, 0] : [60, -160]);
  const cardY = useRange(scrollYProgress, [0, 1], off ? [0, 0] : [40, -40]);
  const scan = useRange(scrollYProgress, [0.2, 0.8], ["-10%", "110%"]);

  return (
    <div ref={ref} className={styles.repo}>
      <m.div className={styles.codeWall} style={{ y: wallY }} aria-hidden="true">
        {[...CODE_WALL, ...CODE_WALL].map((line, index) => <CodeLine key={index} text={line} />)}
      </m.div>
      {!off ? <m.span className={styles.codeScan} style={{ top: scan }} aria-hidden="true" /> : null}
      <m.div className={styles.repoCard} style={{ y: cardY }}>
        <div className={styles.repoHead}>
          <GitHubMark />
          <span className={styles.repoPath}>
            {owner} / <b>{name}</b>
          </span>
          <span className={styles.repoPublic}>Public</span>
        </div>
        <p className={styles.repoLicense}>
          <Scale size={15} aria-hidden="true" />
          Apache-2.0 license
        </p>
        <ul className={styles.repoFiles} aria-label="Top of the repository">
          {FILES.map(file => (
            <li key={file.name} data-license={file.name === "LICENSE" ? "" : undefined}>
              {file.dir ? <Folder size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}
              <span>{file.name}</span>
              {file.note ? <small>{file.note}</small> : null}
            </li>
          ))}
        </ul>
        <p className={styles.srOnly}>{clone}</p>
        <div className={styles.repoTerm} aria-hidden="true">
          <p>
            <span className={styles.repoPrompt}>$</span> {typed.done > 0 ? clone : typed.partial}
            {typed.done === 0 ? <span className={styles.caret} /> : null}
          </p>
          <p className={styles.repoDone} data-shown={typed.done >= 1 ? "" : undefined}>
            {typed.done >= 1 ? (typed.done >= 2 ? "Cloning into 'hivra'... done." : typed.partial) : " "}
          </p>
        </div>
      </m.div>
    </div>
  );
}
