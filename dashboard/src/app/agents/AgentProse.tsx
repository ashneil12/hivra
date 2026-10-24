import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { isExternalHref } from "@/components/public-editorial/ActionLinks";
import agentStyles from "./agents.module.css";
import { parseInline, type InlineNode } from "./content/markup";

function renderNodes(nodes: InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "code":
        return <code key={key}>{node.value}</code>;
      case "bold":
        return <strong key={key}>{renderNodes(node.children, key)}</strong>;
      case "link": {
        if (isExternalHref(node.href)) {
          return (
            <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
              {node.label}
            </a>
          );
        }
        if (node.href.startsWith("/") && !node.href.startsWith("//")) {
          return (
            <Link key={key} href={node.href}>
              {node.label}
            </Link>
          );
        }
        return (
          <a key={key} href={node.href}>
            {node.label}
          </a>
        );
      }
    }
  });
}

/**
 * A heading's words with each sentence on its own line. A two-sentence heading such as "Pick your agent. We'll give
 * it a computer." would otherwise be balanced across the sentence break and leave the first word or two of the
 * second sentence hanging at the end of line one. The words, and the space between the sentences, are unchanged, so
 * the heading reads and is indexed exactly as written. A one-sentence heading comes back as plain text.
 */
export function HeadingLines({ text }: { text: string }) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  if (sentences.length < 2) return <>{text}</>;
  return (
    <>
      {sentences.map((sentence, index) => (
        <Fragment key={sentence}>
          {index > 0 ? " " : null}
          <span className={agentStyles.sentence}>{sentence}</span>
        </Fragment>
      ))}
    </>
  );
}

/** One string of page copy with its **bold**, `code` and [link](href) markup rendered. */
export function Inline({ text }: { text: string }) {
  return <>{renderNodes(parseInline(text), "inline")}</>;
}
