import { Fragment, type ReactNode } from "react";
import Link from "next/link";

import { isExternalHref } from "@/components/public-editorial/ActionLinks";
import { glossify } from "@/components/gloss/glossify";

export interface TextLink {
  /** The words, inside the text, that become the link. */
  text: string;
  href: string;
}

function TextAnchor({ href, children }: { href: string; children: ReactNode }) {
  if (isExternalHref(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  // Routes go through next/link; mailto and other schemes are plain anchors.
  if (href.startsWith("/") && !href.startsWith("//")) return <Link href={href}>{children}</Link>;
  return <a href={href}>{children}</a>;
}

/**
 * Plain text with some of its words shown as links. The text is never changed,
 * so what a reader sees stays identical to the plain string that FAQPage JSON-LD
 * carries. Each link wraps the first occurrence of its words; a link whose words
 * are not in the text is dropped (the tests fail on that). The first use of each
 * glossary term in the plain stretches gets its tooltip, as in the shared
 * question list.
 */
export function renderLinkedText(text: string, links: readonly TextLink[] = []): ReactNode {
  const found = links
    .map((link) => ({ ...link, start: text.indexOf(link.text) }))
    .filter((link) => link.start >= 0)
    .sort((a, b) => a.start - b.start);
  if (!found.length) return glossify(text);

  const nodes: ReactNode[] = [];
  let cursor = 0;
  found.forEach((link, index) => {
    if (link.start < cursor) return;
    if (link.start > cursor) nodes.push(<Fragment key={`text-${index}`}>{glossify(text.slice(cursor, link.start))}</Fragment>);
    nodes.push(
      <TextAnchor key={`link-${index}`} href={link.href}>
        {link.text}
      </TextAnchor>,
    );
    cursor = link.start + link.text.length;
  });
  if (cursor < text.length) nodes.push(<Fragment key="text-end">{glossify(text.slice(cursor))}</Fragment>);
  return nodes;
}
