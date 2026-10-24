// The inline markup the /agents copy is written in: **bold**, `code` and [label](href).
// Pure functions, no React, so the page renderer, the JSON-LD and the tests all read
// the same parse.

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "link"; label: string; href: string };

const TOKEN = /\*\*([\s\S]+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Parses one string of copy. Bold may hold code and links; nothing else nests. */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push({ type: "text", value: text.slice(cursor, start) });
    if (match[1] !== undefined) nodes.push({ type: "bold", children: parseInline(match[1]) });
    else if (match[2] !== undefined) nodes.push({ type: "code", value: match[2] });
    else nodes.push({ type: "link", label: match[3], href: match[4] });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) nodes.push({ type: "text", value: text.slice(cursor) });
  return nodes;
}

function plainOf(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.value;
        case "bold":
          return plainOf(node.children);
        case "link":
          return node.label;
      }
    })
    .join("");
}

/** The words a reader sees, without the markup. */
export function plainText(text: string): string {
  return plainOf(parseInline(text));
}

/** Every link href in a string of copy. */
export function linkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  const walk = (nodes: InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === "link") hrefs.push(node.href);
      else if (node.type === "bold") walk(node.children);
    }
  };
  walk(parseInline(text));
  return hrefs;
}

/** A heading as an element id: "What can you use it for?" becomes "what-can-you-use-it-for". */
export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
