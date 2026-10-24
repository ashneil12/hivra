import { Fragment, type ReactNode } from "react";
import Link from "next/link";

import { glossify } from "@/components/gloss/glossify";
import { isExternalHref } from "@/components/public-editorial/ActionLinks";
import { EditorialMarkdownLink } from "@/components/public-editorial/Editorial";
import { isStaticDocument } from "@/components/public-site/PublicLink";

// The About copy is written with two inline marks, **bold** and [label](href),
// so it reads like the owner's text in about-content.ts. This renders them.
// A mark never nests except a link inside bold, which is how the contact list
// and the repository line are written.
const MARKS = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/;
const BOLD = /^\*\*([^*]+)\*\*$/;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  // Off-site addresses open in a new tab. Static documents (the litepaper) and
  // mailto links are plain anchors: next/link would prefetch a page that is a file.
  if (isExternalHref(href)) return <EditorialMarkdownLink href={href}>{children}</EditorialMarkdownLink>;
  if (href.startsWith("/") && !href.startsWith("//") && !isStaticDocument(href)) return <Link href={href}>{children}</Link>;
  return <a href={href}>{children}</a>;
}

function parts(text: string, gloss: boolean): ReactNode[] {
  return text
    .split(MARKS)
    .filter((part) => part !== "")
    .map((part, index) => {
      const bold = BOLD.exec(part);
      if (bold) return <strong key={index}>{parts(bold[1], false)}</strong>;
      const link = LINK.exec(part);
      if (link) {
        return (
          <InlineLink key={index} href={link[2]}>
            {link[1]}
          </InlineLink>
        );
      }
      // The glossary tooltip is added to plain words only, never inside a link or bold run.
      return <Fragment key={index}>{gloss ? glossify(part) : part}</Fragment>;
    });
}

/** Renders a string written with the About inline marks. `gloss` adds glossary tooltips to its plain words. */
export function Inline({ text, gloss = false }: { text: string; gloss?: boolean }) {
  return <>{parts(text, gloss)}</>;
}
