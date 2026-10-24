// The words on the /status social card. The page runs four live checks of public pages from the visitor's browser,
// so the card says that and not "platform health" (copy audit, status-overclaims-platform-health).

import type { ReactElement, ReactNode } from "react";

const rendered: ReactElement[] = [];

jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement) {
      rendered.push(element);
    }
  },
}));

import StatusOpengraphImage from "../opengraph-image";

const DASH = /[\u2013\u2014]/;

function textOf(node: ReactNode): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("/status social card", () => {
  it("describes live checks of public pages, not the health of the platform", async () => {
    rendered.length = 0;
    await StatusOpengraphImage();
    expect(rendered).toHaveLength(1);
    const words = textOf(rendered[0]).join(" ");
    expect(words).toContain("Public page status");
    expect(words).toContain("Live checks of Hivra's public pages, run from your browser.");
    expect(words).not.toMatch(/platform health|operational status|all systems/i);
    expect(words).not.toMatch(DASH);
  });
});
