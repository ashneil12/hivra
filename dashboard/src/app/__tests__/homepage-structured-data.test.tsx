/** @jest-environment jsdom */
import type { ReactElement, ReactNode } from "react";

jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }) }));
jest.mock("next/navigation", () => ({ redirect: jest.fn() }));
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: (name: string) => (name === "host" ? "hivra.cloud" : null) }),
}));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import LandingPage from "../page";
import StructuredData from "@/components/StructuredData";
import { HOMEPAGE_FAQ } from "@/components/landing/home/content";

type Graph = { "@graph": Array<Record<string, unknown>> };

function findSchema(node: ReactNode): Graph | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSchema(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as ReactElement<{ schema?: Graph; children?: ReactNode }>;
  if (element.type === StructuredData) return element.props.schema ?? null;
  return findSchema(element.props.children);
}

describe("homepage Organization structured data", () => {
  it("links the official X account and the public repository as sameAs profiles", async () => {
    const schema = findSchema(await LandingPage({}));
    const organization = schema?.["@graph"].find((entry) => entry["@type"] === "Organization");
    expect(organization?.sameAs).toEqual(["https://x.com/HivraOS", "https://github.com/ashneil12/hivra"]);
  });
});

describe("homepage FAQ and offers structured data", () => {
  it("publishes the same questions and answers the page shows", async () => {
    const schema = findSchema(await LandingPage({}));
    const faq = schema?.["@graph"].find((entry) => entry["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq.mainEntity.map((item) => [item.name, item.acceptedAnswer.text])).toEqual(HOMEPAGE_FAQ.map(({ q, a }) => [q, a]));
  });

  it("offers only what can be bought today: free self-hosting and the two hosted sizes", async () => {
    const schema = findSchema(await LandingPage({}));
    const app = schema?.["@graph"].find((entry) => entry["@type"] === "SoftwareApplication") as { offers: Array<{ name: string; price: string }> };
    expect(app.offers.map((offer) => [offer.name, offer.price])).toEqual([
      ["Self-host Hivra", "0"],
      ["Hivra Cloud, 2 vCPU and 4 GB", "9.99"],
      ["Hivra Cloud, 4 vCPU and 8 GB", "19.99"],
    ]);
  });
});
