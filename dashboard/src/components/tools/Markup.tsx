// Renders catalog copy that carries the inline marks from lib/tools/markup.ts:
// **bold** becomes <strong>, *italic* becomes <em> and `code` becomes <code>,
// set in the monospace face with ligatures off so a command such as Ctrl-b d
// reads as typed and never wraps in the middle.

import { Fragment } from "react";

import styles from "@/app/tools/tools.module.css";
import { parseMarkup } from "@/lib/tools/markup";

export default function Markup({ text }: { text: string }) {
  return (
    <>
      {parseMarkup(text).map((token, index) => {
        if (token.kind === "strong") return <strong key={index}>{token.text}</strong>;
        if (token.kind === "em") return <em key={index}>{token.text}</em>;
        if (token.kind === "code") {
          return (
            <code key={index} className={styles.inlineCode}>
              {token.text}
            </code>
          );
        }
        return <Fragment key={index}>{token.text}</Fragment>;
      })}
    </>
  );
}
