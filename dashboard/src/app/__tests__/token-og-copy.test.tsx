// The /token and /tokenomics share cards are token-facing copy. They must stay
// factual: the facts, a pointer to the official addresses and the "information,
// not an offer" line, and nothing that reads as a financial promotion. next/og
// is replaced with a recorder so the rendered text can be read back.

import type { ReactElement, ReactNode } from "react";

const rendered: ReactElement[] = [];

jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement) {
      rendered.push(element);
    }
  },
}));

import TokenOg from "../token/opengraph-image";
import TokenomicsOg from "../tokenomics/opengraph-image";
import { OG_IMAGE } from "@/lib/og-meta";

type Props = { children?: ReactNode };

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return text((node as ReactElement<Props>).props.children);
}

async function cardText(render: () => Promise<unknown>): Promise<string> {
  rendered.length = 0;
  await render();
  expect(rendered).toHaveLength(1);
  return text(rendered[0]).replace(/\s+/g, " ").trim();
}

// Words and figures the launch kit bars from token posts.
const PROMOTIONAL =
  /\b(buy|grab|early|price|prices|profit|returns?|gains?|moon|pump|discount|bonus|presale|airdrop|market cap|don't miss|limited|hurry|now or never)\b|[$€£]\s?\d|\d+\s?%|\b\d+x\b/i;
const DASHES = /[\u2013\u2014]/;

describe("token share cards", () => {
  it.each([
    ["/token", TokenOg, /Hivra token contracts/, /Official contract addresses are listed here\./],
    ["/tokenomics", TokenomicsOg, /Proposed \$HIVRA tokenomics/, /proposed migration and treasury/],
  ] as const)("%s card is factual and says it is not an offer", async (_path, handler, title, fact) => {
    const copy = await cardText(handler);
    expect(copy).toMatch(title);
    expect(copy).toMatch(fact);
    expect(copy).toContain("This is information, not an offer.");
    expect(copy).not.toMatch(PROMOTIONAL);
    expect(copy).not.toMatch(DASHES);
    // No contract address is baked into a card; /token itself lists them.
    expect(copy).not.toMatch(/0x[0-9a-f]{6,}/i);
  });

  it("describes both cards factually in their alt text", () => {
    for (const image of [OG_IMAGE.token, OG_IMAGE.tokenomics]) {
      expect(image.alt).not.toMatch(PROMOTIONAL);
      expect(image.alt).not.toMatch(DASHES);
    }
  });
});
