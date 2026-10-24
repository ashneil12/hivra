// One FAQ answer with its quoted commands set in code (see lib/tools/faq-code.ts). It is a server
// component and the text is the catalog's own string, so the page and the FAQPage structured data read
// the same. Each word of a command is kept whole, so a flag such as "-t" never breaks after its hyphen,
// but a long command can still wrap at a space on a phone.

import { Fragment } from "react";

import styles from "@/app/tools/tools.module.css";
import { splitFaqCode } from "@/lib/tools/faq-code";

export default function FaqAnswer({ text, phrases }: { text: string; phrases: readonly string[] }) {
  return (
    <p>
      {splitFaqCode(text, phrases).map((part, index) =>
        part.code ? (
          <code key={index} className={styles.faqCode}>
            {part.text.split(" ").map((word, wordIndex) => (
              <Fragment key={wordIndex}>
                {wordIndex > 0 && " "}
                <span className={styles.word}>{word}</span>
              </Fragment>
            ))}
          </code>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </p>
  );
}
