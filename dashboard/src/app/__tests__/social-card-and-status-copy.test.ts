// The words on the public social cards, their alt text and the /status
// description. The owner's copy rule is no em or en dashes, and the homepage
// card once named a "control plane" while the homepage says "a computer for you
// and your agents" (2026-09-30 copy audit, F-19 and F-21).

import type { ReactElement, ReactNode } from "react";

const rendered: ReactElement[] = [];

jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement) {
      rendered.push(element);
    }
  },
}));
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

import OpengraphImage, { alt as homeCardAlt } from "../opengraph-image";
import { metadata as statusMetadata } from "../status/page";
import { OG_IMAGE } from "@/lib/og-meta";

const DASH = /[–—]/;

function textOf(node: ReactNode): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("social cards and the status page description", () => {
  it("writes every card's alt text without dashes and in plain words", () => {
    const alts = Object.values(OG_IMAGE).map((image) => image.alt);
    expect(alts.length).toBeGreaterThanOrEqual(5);
    expect(alts.filter((text) => DASH.test(text))).toEqual([]);
    expect(OG_IMAGE.home.alt).toBe("Hivra: a computer for you and your agents");
    expect(homeCardAlt).toBe(OG_IMAGE.home.alt);
  });

  it("puts the same plain words on the homepage card, with no dashes and no control plane", async () => {
    rendered.length = 0;
    await OpengraphImage();
    expect(rendered).toHaveLength(1);
    const words = textOf(rendered[0]).join(" ");
    expect(words).toContain("A computer for you and your agents");
    expect(words).not.toMatch(/control plane/i);
    expect(words).not.toMatch(DASH);
  });

  it("describes /status without dashes", () => {
    const description = String(statusMetadata.description);
    expect(description).toContain("Live status of Hivra's public pages");
    expect(description).not.toMatch(DASH);
  });
});
