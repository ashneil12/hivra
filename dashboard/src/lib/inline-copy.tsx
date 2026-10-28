import Link from "next/link";
import type { ReactNode } from "react";

import { isStaticDocument } from "@/components/public-site/PublicLink";

// Page copy kept as data (security-content.ts, roadmap-content.ts) holds a few
// inline marks: **bold**, `code` and [label](href). This is the whole grammar, so a
// paragraph can be written the way the approved Markdown writes it and rendered
// without a Markdown dependency. `hrefs` maps a {name} placeholder to a real
// address, so the data never holds an address that is built elsewhere
// (the litepaper's own link, the start link).

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; label: string; href: string };

const TOKEN = /\*\*([^*]+)\*\*|`([^`]+)`|\[((?:[^\]`]|`[^`]*`)+)\]\(([^)\s]+)\)/g;

export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of source.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > cursor) tokens.push({ kind: "text", text: source.slice(cursor, at) });
    if (match[1] !== undefined) tokens.push({ kind: "strong", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "code", text: match[2] });
    else tokens.push({ kind: "link", label: match[3], href: match[4] });
    cursor = at + match[0].length;
  }
  if (cursor < source.length) tokens.push({ kind: "text", text: source.slice(cursor) });
  return tokens;
}

/** The text a reader sees: marks removed, link labels kept. Used by JSON-LD, aria labels and tests. */
export function plainInline(source: string): string {
  return parseInline(source)
    .map((token) => {
      if (token.kind === "link") return plainInline(token.label);
      return token.text;
    })
    .join("");
}

/** Every link address a piece of copy holds, placeholders unresolved. */
export function inlineHrefs(source: string): string[] {
  return parseInline(source).flatMap((token) => (token.kind === "link" ? [token.href] : []));
}

function isExternal(href: string): boolean {
  try {
    const url = new URL(href, "https://hivra.cloud");
    return /^https?:$/.test(url.protocol) && url.origin !== "https://hivra.cloud";
  } catch {
    return false;
  }
}

function renderLink(label: ReactNode, href: string, key: number) {
  if (isExternal(href)) {
    return (
      <a key={key} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  if (href.startsWith("/") && !href.startsWith("//") && !isStaticDocument(href) && !href.startsWith("/.well-known/")) {
    return (
      <Link key={key} href={href}>
        {label}
      </Link>
    );
  }
  return (
    <a key={key} href={href}>
      {label}
    </a>
  );
}

function renderTokens(tokens: InlineToken[], hrefs: Record<string, string>): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.kind) {
      case "text":
        return token.text;
      case "strong":
        return <strong key={index}>{token.text}</strong>;
      case "code":
        return <code key={index}>{token.text}</code>;
      case "link": {
        const resolved = token.href.replace(/^\{(\w+)\}$/, (whole, name: string) => hrefs[name] ?? whole);
        return renderLink(renderTokens(parseInline(token.label), hrefs), resolved, index);
      }
    }
  });
}

/** Renders one piece of inline copy. Placeholders in `hrefs` that are missing are left as written so a test can catch them. */
export function Inline({ text, hrefs = {} }: { text: string; hrefs?: Record<string, string> }) {
  return <>{renderTokens(parseInline(text), hrefs)}</>;
}

export default Inline;
