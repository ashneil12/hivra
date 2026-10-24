/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { ECOSYSTEM_STAGES } from "@/lib/ecosystem-map";
import { LITEPAPER_HREF } from "@/components/public-site/PublicLink";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import type { TokenSurfaceView } from "@/lib/compliance/token-surface-view";

// The view module reaches the server-only geo modules; only its pure helper is used here.
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: jest.fn() }));
const mockView = jest.fn();
jest.mock("@/lib/compliance/token-surface-view", () => ({
  ...jest.requireActual("@/lib/compliance/token-surface-view"),
  getTokenSurfaceView: () => mockView(),
}));
// The header and footer are covered by their own suites; this file is about the page body.
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

import EcosystemPage, { metadata } from "../page";
import { INTRO, LAUNCHPAD_SECTION, TOKEN_SECTION } from "../ecosystem-content";

const TITLE = "Hivra Ecosystem | What exists, what's next and what's being explored";
const DESCRIPTION =
  "A clear view of Hivra Agent Computers and the planned ecosystem, from permissions and security testing to tools, agent identity and coordinated work.";

const ON: TokenSurfaceView = { tokenSurfaces: true, geoBlocked: false };
const OFF: TokenSurfaceView = { tokenSurfaces: false, geoBlocked: false };
const BLOCKED: TokenSurfaceView = { tokenSurfaces: true, geoBlocked: true };

async function renderPage(view: TokenSurfaceView) {
  mockView.mockResolvedValue(view);
  return render(await EcosystemPage());
}

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')];
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].textContent ?? "{}")["@graph"];
}

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Words that name a token, the migration, the litepaper or the launchpad concept (brief rule C8). */
const TOKEN_WORDS = /token|\$HIVRA|\$HermesOS|tokenomics|litepaper|launchpad|accelerator|bankr|airdrop|snapshot|migration/i;

describe("/ecosystem metadata", () => {
  it("uses the pack's browser title exactly, without the layout's second ' | Hivra'", () => {
    expect(metadata.title).toEqual({ absolute: TITLE });
    expect(TITLE).not.toMatch(/\| Hivra$/);
    expect(metadata.description).toBe(DESCRIPTION);
    expect(DESCRIPTION.length).toBeLessThanOrEqual(160);
  });

  it("is indexable on its own URL and shares one title and description with Open Graph and Twitter", () => {
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/ecosystem");
    expect(metadata.openGraph).toMatchObject({ url: "https://hivra.cloud/ecosystem", title: TITLE, description: DESCRIPTION });
    expect(metadata.twitter).toMatchObject({ title: TITLE, description: DESCRIPTION });
  });

  it("has no dash, no banned claim and no token word in the head", () => {
    const head = [TITLE, DESCRIPTION, JSON.stringify(metadata.openGraph), JSON.stringify(metadata.twitter)].join("\n");
    expect(head).not.toMatch(/[–—]/);
    expect(findBannedClaims(head)).toEqual([]);
    expect(head).not.toMatch(TOKEN_WORDS);
  });

  it("starts the Then intro where the right-hand column of the grid under it starts", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "ecosystem.module.css"), "utf8");
    const head = css.match(/\.thenHead\s*\{([^}]*)\}/)?.[1] ?? "";
    const grid = css.match(/\n\.grid\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(head).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(head.match(/gap:\s*([^;]+);/)?.[1]).toBe(grid.match(/column-gap:\s*([^;]+);/)?.[1]);
  });

  it("writes the title as a literal the site-wide title scanners can read", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).toContain(`const TITLE = "${TITLE}";`);
    expect(source).toContain("title: absoluteTitle(TITLE)");
    expect(source).not.toMatch(/metadata\s*=\s*buildWebsiteMetadata\(/);
  });
});

describe("/ecosystem structure", () => {
  it("has one h1 that holds both lines of the title", async () => {
    await renderPage(OFF);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(squash(h1.textContent)).toBe("Hivra starts with a computer. It doesn't end there.");
    expect(h1.querySelector("em")?.textContent).toBe("It doesn't end there.");
    // The second line is the tail of the h1, never a stray h2 under it.
    expect(screen.queryByRole("heading", { level: 2, name: "It doesn't end there." })).toBeNull();
  });

  it("opens with the breadcrumb and the four intro paragraphs, word for word", async () => {
    const { container } = await renderPage(OFF);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Home/Ecosystem");
    const text = squash(container.textContent);
    for (const paragraph of INTRO.paragraphs) expect(text).toContain(paragraph);
    expect(text).toContain(
      "This page separates what you can use now, what we intend to build next, and ideas still being researched. Being on the map is not the same as being launched.",
    );
    const guide = screen.getByRole("navigation", { name: "The four groups on this map" });
    expect(within(guide).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Available now", "#available-now"],
      ["Next", "#next"],
      ["Then", "#then"],
      ["Research", "#research"],
    ]);
  });

  it("orders the h2s as the pack does, and drops the two token sections while token surfaces are off", async () => {
    await renderPage(OFF);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => squash(heading.textContent))).toEqual([
      "Available now",
      "Next: Make individual agents more useful and accountable",
      "Then: Identity, recovery and shared knowledge",
      "Research: Things worth exploring, not yet promises",
      "The Agent Computers roadmap continues too",
      "How the pieces fit together",
      "Follow the work, not just the plan",
    ]);
  });

  it("adds the token and launchpad sections, in the pack's place, while token surfaces are on", async () => {
    await renderPage(ON);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => squash(heading.textContent))).toEqual([
      "Available now",
      "Next: Make individual agents more useful and accountable",
      "Then: Identity, recovery and shared knowledge",
      "Research: Things worth exploring, not yet promises",
      "The Agent Computers roadmap continues too",
      "How the pieces fit together",
      "What about the token?",
      "What about launching agents with their own tokens?",
      "Follow the work, not just the plan",
    ]);
  });

  it("puts each product under the stage the map gives it, as an h3 named for the product with no colon", async () => {
    const { container } = await renderPage(OFF);
    const names: string[] = [];
    for (const stage of ECOSYSTEM_STAGES) {
      const section = container.querySelector(`section#${stage.id}`) as HTMLElement;
      expect(section).not.toBeNull();
      expect(section).toHaveAttribute("aria-labelledby", `${stage.id}-heading`);
      const inSection = within(section).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
      expect(inSection).toEqual(stage.products.map((product) => product.name));
      names.push(...(inSection as string[]));
      for (const product of stage.products) {
        expect(within(section).getByRole("heading", { level: 3, name: product.name })).toBeVisible();
      }
    }
    expect(names).toHaveLength(16);
    // No other h3 on the page, and no product name written as "Name:".
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(16);
    expect(container.textContent).not.toMatch(/\b(Gate|Exchange|Arena|Signal|Vault|Passport|Seal|Rescue|Challenges|Experience|Missions|Foundry|Colony|Interchange|Ports):/);
  });

  it("keeps every status hedge sentence", async () => {
    const { container } = await renderPage(OFF);
    const text = squash(container.textContent);
    for (const sentence of [
      "Being on the map is not the same as being launched.",
      "These products are planned. They are not currently available simply because they're named here.",
      "These ideas follow the first planned products in the intended sequence. The order may change; none comes with a promised release date.",
      "Publisher checks and security labels are plans, not guarantees for third-party software today.",
      "Rescue is a proposal for a more coordinated response rather than a claim that every mistake can be undone.",
      "These are planned additions, not presently supported configurations unless they appear as options in the live product.",
      "Not that every product needs to exist before Hivra is useful, and not that building every one of them is inevitable.",
    ]) {
      expect(text).toContain(sentence);
    }
  });

  it("links Agent Computers to the home page, the agents and pricing, with the first as the one button", async () => {
    await renderPage(OFF);
    const section = screen.getByRole("region", { name: "Available now" });
    const links = within(section).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("data-kind")])).toEqual([
      ["Explore Agent Computers", "/", "primary"],
      ["See the agents", "/agents", "secondary"],
      ["Pricing", "/pricing", "secondary"],
    ]);
  });

  it("keeps the numbered list as an ordered list of seven, with the product names linked to their sections", async () => {
    const { container } = await renderPage(OFF);
    const list = container.querySelector("ol");
    expect(list?.tagName).toBe("OL");
    expect(list).toHaveAttribute("role", "list");
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    const items = [...(list as HTMLElement).querySelectorAll(":scope > li")];
    expect(items).toHaveLength(7);
    expect(squash(items[0].textContent)).toBe("Agent Computers gives it somewhere separate to run.");
    expect(squash(items[3].textContent)).toBe("Arena and Seal could provide evidence about what has been tested and under which conditions.");
    expect(squash(items[6].textContent)).toBe(
      "Experience, Missions and the longer-term work could make agents more useful together, with clearer boundaries and accountability.",
    );
    const anchors = [...(list as HTMLElement).querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(anchors).toEqual(["#agent-computers", "#exchange", "#gate", "#arena", "#seal", "#signal", "#rescue", "#experience", "#missions"]);
    for (const href of anchors) expect(container.querySelector(href as string)).not.toBeNull();
  });

  it("keeps the glossary tooltips, never inside a heading or a link", async () => {
    const { container } = await renderPage(OFF);
    const terms = [...container.querySelectorAll("[data-gloss]")].map((node) => node.textContent);
    expect(terms).toEqual(expect.arrayContaining(["AI agent", "API key", "macOS", "custom images"]));
    expect(container.querySelectorAll("h1 [data-gloss], h2 [data-gloss], h3 [data-gloss], a [data-gloss]")).toHaveLength(0);
  });

  it("emits breadcrumb and page structured data only, never a product", async () => {
    const { container } = await renderPage(OFF);
    const graph = jsonLd(container);
    expect(graph.map((node) => node["@type"])).toEqual(["BreadcrumbList", "WebPage"]);
    expect(graph[1]).toMatchObject({ url: "https://hivra.cloud/ecosystem", name: TITLE, description: DESCRIPTION });
    expect(JSON.stringify(graph)).not.toMatch(/Product|SoftwareApplication|ItemList|FAQPage/);
  });
});

describe("/ecosystem token surfaces", () => {
  it.each([
    ["the switch is off", OFF],
    ["the viewer is geo-blocked", BLOCKED],
  ])("names no token, migration, litepaper or launchpad concept when %s", async (_label, view) => {
    const { container } = await renderPage(view);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(TOKEN_WORDS);
    expect(JSON.stringify(jsonLd(container))).not.toMatch(TOKEN_WORDS);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((href) => /token|litepaper/i.test(href))).toEqual([]);
    expect(screen.queryByRole("link", { name: "Current token information" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Read the litepaper" })).toBeNull();
    // The closing links that need no token page stay.
    expect(screen.getByRole("link", { name: "Launch a computer" })).toHaveAttribute("href", PUBLIC_START_HREF);
    expect(screen.getByRole("link", { name: "See the roadmap" })).toHaveAttribute("href", "/roadmap");
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  });

  it("shows the token section, the launchpad note and the litepaper link when the switch is on and the viewer is not blocked", async () => {
    const { container } = await renderPage(ON);
    const token = screen.getByRole("region", { name: "What about the token?" });
    expect(token).toHaveTextContent(TOKEN_SECTION.paragraphs[0]);
    expect(within(token).getByRole("link", { name: "Current token information" })).toHaveAttribute("href", "/token");
    expect(within(token).getByRole("link", { name: "Tokenomics and proposals" })).toHaveAttribute("href", "/tokenomics");
    const closing = screen.getByRole("region", { name: "Follow the work, not just the plan" });
    const litepaper = within(closing).getByRole("link", { name: "Read the litepaper" });
    expect(litepaper).toHaveAttribute("href", LITEPAPER_HREF);
    expect(litepaper).not.toHaveAttribute("target");
    // /litepaper is not a route, so no link may point at it.
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).not.toContain("/litepaper");
    expect(within(closing).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Launch a computer",
      "See the roadmap",
      "Read the litepaper",
      "GitHub",
    ]);
  });

  it("corrects the pack's inaccurate sentence about the token, and says so only inside the token section", async () => {
    const { container } = await renderPage(ON);
    const text = squash(container.textContent);
    expect(text).not.toContain("Those mechanisms are not the same as features already available in Hivra Cloud.");
    expect(text).toContain(
      "Eligible $HermesOS holdings are one way to qualify for compute access. The other mechanisms are proposals, not features already available in Hivra Cloud.",
    );
    expect(text).toContain("You can use self-hosted Hivra without a token, and card-paid hosting remains available separately.");
    expect(TOKEN_SECTION.paragraphs[1]).toContain("$HermesOS");
  });

  it("keeps the launchpad disclaimer bold, word for word", async () => {
    const section = (await renderPage(ON)).container.querySelector("#launchpad-heading")?.closest("section") as HTMLElement;
    expect(section).not.toBeNull();
    expect(within(section).getByText("not an available product, announced launch or committed funding programme").tagName).toBe("STRONG");
    expect(section).toHaveTextContent(LAUNCHPAD_SECTION.paragraphs[0]);
    expect(section).not.toHaveTextContent(/available now|launching soon|coming soon|apply/i);
  });
});

describe("/ecosystem copy rules", () => {
  it("has no dash, no plan name, no price, no trial and no American spelling in the page", async () => {
    const { container } = await renderPage(ON);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\bHivra (?:Starter|Pro|Power)\b|\bStarter plan\b|\bPro plan\b|\bPower plan\b/);
    expect(text).not.toMatch(/\$\d|\/mo\b|\/month\b|free trial|\btrial\b|no card required|public domain/i);
    expect(text).not.toMatch(/\b(authorize|authorized|artifacts?|catalog|program|behavior|color|center|license)\b/i);
    expect(text).toMatch(/authorise useful work/);
    expect(text).toMatch(/artefacts/);
    expect(text).toMatch(/catalogue/);
    expect(text).toMatch(/programme/);
  });

  it("makes no banned public claim (the planned Orchestrator is the one narrow exemption)", async () => {
    const { container } = await renderPage(ON);
    // copy-rules bans /orchestrat/ because built-in multi-agent coordination is not shipped. The pack names
    // the Orchestrator only as a planned addition ("we intend to explore"), which the sentence says in terms.
    const text = [container.textContent ?? "", DESCRIPTION, TITLE].join("\n");
    expect(text).toContain("we intend to explore an Orchestrator");
    expect(findBannedClaims(text.replace(/\bOrchestrator\b/g, "planned addition"))).toEqual([]);
  });

  it("names no operating system, agent provider or model, so no qualifier is owed", async () => {
    const { container } = await renderPage(ON);
    expect(container.textContent).not.toMatch(/\b(Windows|Ubuntu|Omarchy|Claude|Codex|ChatGPT|OpenAI|Anthropic|OpenClaw|Zero|Hermes)\b/);
  });

  it("links only to routes the app serves, the litepaper document or GitHub", async () => {
    const { container } = await renderPage(ON);
    const appRoot = path.join(__dirname, "..", "..");
    const hrefs = [...new Set([...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? ""))];
    for (const href of hrefs) {
      if (href.startsWith("#")) continue;
      if (href === LITEPAPER_HREF) continue;
      if (href.startsWith("https://")) {
        expect(href).toBe("https://github.com/ashneil12/hivra");
        continue;
      }
      const segment = href.split("/")[1];
      const directory = segment ? path.join(appRoot, segment) : appRoot;
      const hasPage = fs.existsSync(path.join(directory, "page.tsx")) || fs.readdirSync(directory).some((entry) => entry.startsWith("[[...") && fs.existsSync(path.join(directory, entry, "page.tsx")));
      expect({ href, hasPage }).toEqual({ href, hasPage: true });
    }
    // GitHub opens in a new tab with the noopener pair.
    const github = screen.getByRole("link", { name: "GitHub" });
    expect(github).toHaveAttribute("target", "_blank");
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
  });
});
