import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { glossify } from "@/components/gloss/glossify";
import { isExternalHref } from "@/components/public-editorial/ActionLinks";
import { parseInline } from "@/lib/inline-copy";
import styles from "../features.module.css";

interface InlineOptions {
  /**
   * For FAQ answers, like the shared FAQ: wrap the first use of each glossary term in a plain-text run in its tooltip, and
   * leave the spaces alone, because the FAQPage JSON-LD carries the same string and must read exactly like the page.
   */
  gloss?: boolean;
}

const SIZE = /(\d+ vCPU|\d+ GB(?: of RAM)?)/;

/**
 * Keeps a size together on one line, so "4 vCPU and 8 GB of RAM" never splits as "8 GB of / RAM" in a narrow column.
 * Each size goes in a span that does not wrap. The text is untouched (same characters, ordinary spaces), so what a
 * reader or a crawler reads is the sentence in the copy.
 */
function keepSizesTogether(text: string): ReactNode {
  if (!SIZE.test(text)) return text;
  return text.split(SIZE).map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className={styles.unbroken}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** A command or file name is short enough to keep on one line, so a chip never splits across two lines with its border cut. */
const MAX_UNBROKEN_CODE = 28;

export function staysOnOneLine(code: string): boolean {
  return code.length <= MAX_UNBROKEN_CODE;
}

function renderLink(label: ReactNode, href: string, key: number): ReactNode {
  if (isExternalHref(href)) {
    return (
      <a key={key} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  return (
    <Link key={key} href={href}>
      {label}
    </Link>
  );
}

/** A string with inline markup as nodes. */
export function renderInline(text: string, { gloss = false }: InlineOptions = {}): ReactNode {
  return parseInline(text).map((token, index): ReactNode => {
    if (token.kind === "strong") return <strong key={index}>{gloss ? token.text : keepSizesTogether(token.text)}</strong>;
    if (token.kind === "code") {
      return (
        <code key={index} className={staysOnOneLine(token.text) ? styles.unbroken : undefined}>
          {token.text}
        </code>
      );
    }
    // A link label may hold inline code, such as a command name.
    if (token.kind === "link") return renderLink(renderInline(token.label), token.href, index);
    return <Fragment key={index}>{gloss ? glossify(token.text) : keepSizesTogether(token.text)}</Fragment>;
  });
}

/** The same string without its markup: what a search engine reads in the FAQPage JSON-LD. */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
