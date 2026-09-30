// Command-line flags in running prose, set in the monospace face.
//
// The site's body font turns a double hyphen into an en dash glyph (its `liga`
// feature), so "--what" would read as a typo, and a single-letter flag such as
// "-i" can wrap between the hyphen and the letter. A flag in <code> avoids both:
// monospace, no ligatures, never broken across lines. The text itself is not
// changed, so copying it gives the same characters.

import { Fragment, type ReactNode } from "react";

import styles from "@/app/tools/tools.module.css";

// A flag starts the text or follows a space or "(", begins with one or two
// hyphens and a letter, and may carry =, : or / (for example --what=sleep:handle-lid-switch).
const FLAG = /(^|[\s(])(--?[A-Za-z][\w=:/-]*)/g;

export function withInlineCode(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(FLAG)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <code key={start} className={styles.inlineCode}>
        {match[2]}
      </code>,
    );
    last = start + match[2].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function Prose({ text }: { text: string }) {
  return <>{withInlineCode(text)}</>;
}

/**
 * A command in a narrow cell. Each word is kept whole, so the line can wrap at
 * a space but never between a hyphen and the letter of a flag ("-t"). The text
 * and the spaces are unchanged, so selecting or copying it gives the command.
 */
export function Cmd({ command }: { command: string }) {
  return (
    <code className={styles.cmd}>
      {command.split(" ").map((word, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          <span className={styles.word}>{word}</span>
        </Fragment>
      ))}
    </code>
  );
}
