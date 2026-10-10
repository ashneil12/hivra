// The public OG card must show the approved Hivra mark (the exported app icon),
// not the retired lime "H" tile. next/og is replaced with a recorder so the card's
// element tree can be inspected; the real rasterisation is covered on the served route.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";

const rendered: ReactElement[] = [];

jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement) {
      rendered.push(element);
    }
  },
}));

import { renderOgCard } from "@/lib/og-card";

type Props = { style?: Record<string, unknown>; children?: ReactNode; src?: string };

function walk(node: ReactNode, visit: (element: ReactElement<Props>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const element = node as ReactElement<Props>;
  visit(element);
  walk(element.props.children, visit);
}

describe("renderOgCard brand mark", () => {
  it("embeds the exported approved mark and no lime accent", async () => {
    rendered.length = 0;
    await renderOgCard({ eyebrow: "Status", title: "Title", subtitle: "Subtitle" });
    expect(rendered).toHaveLength(1);

    const images: ReactElement<Props>[] = [];
    const colours: unknown[] = [];
    walk(rendered[0], (element) => {
      if (element.type === "img") images.push(element);
      colours.push(element.props.style?.color, element.props.style?.background);
    });

    const icon = readFileSync(join(process.cwd(), "public/brand/hivra-icon-192.png"));
    expect(images).toHaveLength(1);
    expect(images[0].props.src).toBe(`data:image/png;base64,${icon.toString("base64")}`);
    expect(colours.filter(Boolean).map((c) => String(c).toLowerCase())).not.toContain("#ccff00");
  });
});
