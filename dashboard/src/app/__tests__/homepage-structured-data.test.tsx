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

import LandingPage, { metadata as homeMetadata } from "../page";
import StructuredData from "@/components/StructuredData";
import { officialProfileLinks } from "@/lib/public-project-links";
import { HOMEPAGE_FAQ } from "@/components/landing/home/content";
import { SITE_DESCRIPTION } from "@/lib/brand-description";
import { buildLlmsTxt } from "@/lib/llms-txt";
import { findBannedClaims } from "@/lib/tools/copy-rules";

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

function nodeOf(schema: Graph | null, type: string): Record<string, unknown> {
  const node = schema?.["@graph"].find((entry) => entry["@type"] === type);
  if (!node) throw new Error(`homepage JSON-LD has no ${type} node`);
  return node;
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

describe("homepage identity structured data", () => {
  it("names Hivra, with the former names only on Organization and the domain as the site-name fallback", async () => {
    const schema = findSchema(await LandingPage({}));
    const organization = nodeOf(schema, "Organization");
    const website = nodeOf(schema, "WebSite");
    const app = nodeOf(schema, "SoftwareApplication");

    expect(organization.name).toBe("Hivra");
    expect(organization.alternateName).toEqual(["HermesOS", "Hermes OS"]);
    expect(organization.description).toBe(SITE_DESCRIPTION);
    expect(organization.description).toBe(
      "Hivra (hivra.cloud, formerly HermesOS) is an open-source computer for you and your AI agents, on Hivra Cloud or your own server.",
    );
    // Google will not give two global sites the same name, and hivra.ai, hivra.app
    // and hivra.space already call themselves Hivra, so the domain is the fallback.
    expect(website.name).toBe("Hivra");
    expect(website.alternateName).toEqual(["hivra.cloud"]);
    expect(app.name).toBe("Hivra");
    expect(app).not.toHaveProperty("alternateName");
  });

  it("uses a square brand mark for the logo and the official profile links for sameAs", async () => {
    const schema = findSchema(await LandingPage({}));
    const organization = nodeOf(schema, "Organization") as { logo: { url: string; width: number; height: number }; sameAs: string[] };
    expect(organization.logo.url).toBe("https://hivra.cloud/brand/hivra-icon-512.png");
    expect(organization.logo.width).toBe(organization.logo.height);
    expect(organization.logo.width).toBeGreaterThanOrEqual(112);
    // Not the 1200x630 social banner, and not the token-named file.
    expect(organization.logo.url).not.toMatch(/og-image|opengraph|token/i);
    expect(organization.sameAs).toEqual(officialProfileLinks());
    expect(organization.sameAs.join(" ")).not.toMatch(/hivra\.ai|hivra\.app|hivra\.space|nousresearch/i);
  });

  it("links the website and application back to the one Organization node", async () => {
    const schema = findSchema(await LandingPage({}));
    const organization = nodeOf(schema, "Organization");
    expect(nodeOf(schema, "WebSite").publisher).toEqual({ "@id": organization["@id"] });
  });

  it("contains no other company's product name and none of the retired claims anywhere in the markup", async () => {
    const schema = findSchema(await LandingPage({}));
    const markup = allStrings(schema);
    expect(markup.length).toBeGreaterThan(20);

    const FORBIDDEN: Array<[RegExp, string]> = [
      [/hermes cloud/i, "Hermes Cloud is Nous Research's hosted product"],
      [/hermes agent os/i, "Hermes Agent is Nous Research's product name"],
      [/nous research|nousresearch/i, "no Nous Research names in Hivra's own markup"],
      [/free trial|free tier|free plan|\$0 free|\bfree hosting\b/i, "Hivra has no trial and no hosted free plan"],
      [/one[- ]click/i, "no unmeasured speed claims"],
      [/licen[sc]e|apache|mit license|public domain/i, "marketing markup never names the licence or says public domain"],
    ];
    for (const text of markup) {
      for (const [pattern, why] of FORBIDDEN) {
        expect({ text, pattern: String(pattern), why, hit: pattern.test(text) }).toEqual({ text, pattern: String(pattern), why, hit: false });
      }
    }

    // The shared public-copy rules (price and size wording, dashes, guarantees)
    // also apply to structured data. The homepage is the one page where Ash
    // treats Windows computers as live (2026-09-28), as in home-copy.test.ts.
    const hits = markup.flatMap((text) =>
      findBannedClaims(text)
        .filter((hit) => !/Windows computers are not generally available/.test(hit.why))
        .map((hit) => `${hit.match} in "${text}": ${hit.why}`),
    );
    expect(hits).toEqual([]);
  });
});

describe("availability of Windows and Omarchy computers across surfaces", () => {
  // The owner's homepage copy (2026-09-28) and the roadmap say a person can launch
  // an Ubuntu, Windows or Omarchy computer. The JSON-LD feature list, the meta
  // description and llms.txt are read by crawlers and answer engines, so they
  // must say the same thing; one surface calling them "private preview" while the
  // others list them as available is exactly the drift this test stops.
  it("lists Windows and Omarchy in the JSON-LD feature list, the meta description and llms.txt alike", async () => {
    const schema = findSchema(await LandingPage({}));
    const app = nodeOf(schema, "SoftwareApplication") as { featureList: string[] };
    expect(app.featureList).toContain("Ubuntu, Windows or Omarchy");
    expect(String(homeMetadata.description)).toContain("launch Ubuntu, Windows or Omarchy for yourself");

    const llmsTxt = buildLlmsTxt({ siteUrl: "https://hivra.cloud", phase: "dormant" });
    expect(llmsTxt).toMatch(/Also available: Windows[^.]*and Omarchy\./);
    expect(llmsTxt).not.toMatch(/private preview/i);
  });
});

describe("homepage FAQ and offers structured data", () => {
  it("publishes the same questions and answers the page shows", async () => {
    const schema = findSchema(await LandingPage({}));
    const faq = schema?.["@graph"].find((entry) => entry["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq.mainEntity.map((item) => [item.name, item.acceptedAnswer.text])).toEqual(HOMEPAGE_FAQ.map(({ q, a }) => [q, a]));
  });

  it("says AI key and AI usage in the markup, as the visible page does", async () => {
    const schema = findSchema(await LandingPage({}));
    const markup = allStrings(schema).join("\n");
    expect(markup).toContain("Bring your own AI key");
    expect(markup).toContain("pay for it and for your AI usage");
    expect(markup).not.toMatch(/\bmodel (?:key|usage|provider|API key)\b/i);
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
