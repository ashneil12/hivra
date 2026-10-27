/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { findBannedClaims as findBannedPublicClaims, sentences } from "@/app/features/__tests__/public-claims";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { findBannedClaims } from "@/lib/tools/copy-rules";

import WhyHivraEvolutionPage from "../evolution/page";
import { FOUNDER_NOTE, NOTE_SOURCES, allParagraphs, paragraphText } from "../founder-note";
import WhyHivraPage, { metadata as whyHivraMetadata } from "../page";

// The proposal-labelling contract below is the dormant evolution copy, so pin a dormant launch block
// (the committed one is filled in). The launched lines are covered in src/lib/__tests__/token-phase-pages.test.tsx.
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" },
}));

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("@/components/StructuredData", () => function MockStructuredData({ schema }: { schema: unknown }) {
  // The schema rides on an attribute, so the page's text stays exactly the note.
  return <script type="application/ld+json" data-testid="structured-data" data-schema={JSON.stringify(schema)} />;
});

jest.mock("@/components/layout/LandingHeader", () => function MockLandingHeader() {
  return <header data-testid="landing-header">Hivra</header>;
});

jest.mock("@/components/landing/Footer", () => function MockFooter() {
  return <footer data-testid="landing-footer">Footer</footer>;
});

const BROWSER_TITLE = "Why I'm building Hivra | A note from the founder";
const SEARCH_DESCRIPTION =
  "Why Hivra's founder believes AI agents need separate computers, meaningful limits and infrastructure people can inspect.";
const SECTION_HEADINGS = [
  "A computer full of things an agent doesn't need",
  "Better agents make boundaries more important",
  "A model passing a test is not a guarantee",
  "There's also a personal reason",
  "The practical answer I'm trying to build",
];

describe("/why-hivra page metadata", () => {
  it("uses the founder's browser title as written, so the layout does not add a second brand", () => {
    expect(whyHivraMetadata.title).toEqual({ absolute: BROWSER_TITLE });
    expect(whyHivraMetadata.description).toBe(SEARCH_DESCRIPTION);
    expect(whyHivraMetadata.alternates?.canonical).toBe("https://hivra.cloud/why-hivra");
    expect(whyHivraMetadata.openGraph).toMatchObject({ title: BROWSER_TITLE, description: SEARCH_DESCRIPTION });
    expect(whyHivraMetadata.twitter).toMatchObject({ title: BROWSER_TITLE, description: SEARCH_DESCRIPTION });
    for (const text of [BROWSER_TITLE, SEARCH_DESCRIPTION]) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("/why-hivra page", () => {
  it("renders the note inside the public site frame with a Home breadcrumb", () => {
    render(<WhyHivraPage />);

    expect(screen.getByTestId("landing-header")).toBeInTheDocument();
    expect(screen.getByTestId("landing-footer")).toBeInTheDocument();
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(breadcrumb).toHaveTextContent("Why I'm building Hivra");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("mirrors the visible breadcrumb as BreadcrumbList structured data", () => {
    render(<WhyHivraPage />);

    const schema = JSON.parse(screen.getByTestId("structured-data").getAttribute("data-schema") ?? "{}");
    expect(schema["@type"]).toBe("BreadcrumbList");
    expect(schema.itemListElement.map((item: { name: string }) => item.name)).toEqual(["Home", "Why I'm building Hivra"]);
    expect(schema.itemListElement[1].item).toBe("https://hivra.cloud/why-hivra");
  });

  it("has one h1 and the five headings in the founder's order, each naming its section", () => {
    render(<WhyHivraPage />);

    expect(screen.getAllByRole("heading", { level: 1 }).map((node) => node.textContent)).toEqual(["Why I'm building Hivra"]);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((node) => node.textContent)).toEqual(SECTION_HEADINGS);
    for (const heading of headings) {
      expect(screen.getByRole("region", { name: heading.textContent ?? "" })).toBeInTheDocument();
    }
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });

  it("publishes the whole note, paragraph by paragraph, with no cards, lists or bullets", () => {
    const { container } = render(<WhyHivraPage />);
    const article = container.querySelector("article") as HTMLElement;

    const rendered = Array.from(article.querySelectorAll("p")).map((node) => node.textContent);
    expect(rendered).toEqual(allParagraphs().map(paragraphText));
    expect(rendered).toHaveLength(4 + 6 + 5 + 5 + 5 + 6);
    expect(article.querySelectorAll("ul, ol, li, table, blockquote, img, svg:not([aria-hidden])")).toHaveLength(0);

    // Spot checks on the sentences the page turns on.
    expect(article).toHaveTextContent("I use AI agents almost every day.");
    expect(article).toHaveTextContent("I just don't want to give them my entire computer to make it happen.");
    expect(article).toHaveTextContent("The agent shouldn't be the only thing responsible for policing the agent.");
    expect(article).toHaveTextContent("I want AI to be powerful enough to do real work, with boundaries that remain meaningful when it gets more powerful.");
    expect(article.lastElementChild).toContainElement(screen.getByRole("link", { name: /See the ecosystem/ }));
  });

  it("keeps the founder's faith section word for word", () => {
    const { container } = render(<WhyHivraPage />);
    const section = within(container.querySelector("article") as HTMLElement).getByRole("region", { name: "There's also a personal reason" });

    expect(Array.from(section.querySelectorAll("p")).map((node) => node.textContent)).toEqual([
      "I'm a Christian, and my faith shapes how I think about power, responsibility and the future we're building.",
      "I believe there's a genuine danger in a world where access to money, work and everyday services becomes concentrated in systems that can decide who is allowed to take part. Scripture's warnings about control over buying and selling are part of how I think about that future. I can see AI making such control far easier to administer at scale.",
      "That's my interpretation and my concern. I'm not claiming that every AI system is part of a biblical prophecy, or asking people to share my beliefs to use Hivra.",
      "You don't have to agree with me at all.",
      "But it helps explain why I care so much about accountability, user control and infrastructure people can operate for themselves. I don't want every meaningful decision about access to live inside a system no one can inspect or question.",
    ]);
  });

  it("sets apart one pull line and one sign-off, and no other paragraph", () => {
    const roles = allParagraphs().filter((paragraph) => paragraph.role);
    expect(roles.map((paragraph) => [paragraph.role, paragraphText(paragraph)])).toEqual([
      ["pull", "The agent shouldn't be the only thing responsible for policing the agent."],
      ["signoff", "That's why I'm building Hivra."],
    ]);
    const lastSection = FOUNDER_NOTE.sections[FOUNDER_NOTE.sections.length - 1];
    expect(lastSection.paragraphs[lastSection.paragraphs.length - 1].role).toBe("signoff");
    expect(FOUNDER_NOTE.sections[2].paragraphs[FOUNDER_NOTE.sections[2].paragraphs.length - 1].role).toBe("pull");
  });

  it("links the four research claims to their sources, in a new tab, on phrases already in the sentence", () => {
    const { container } = render(<WhyHivraPage />);
    const article = container.querySelector("article") as HTMLElement;
    const sourceLinks = Array.from(article.querySelectorAll("p a"));

    expect(sourceLinks.map((node) => [node.textContent, node.getAttribute("href")])).toEqual([
      ["Big Sleep", "https://projectzero.google/2024/10/from-naptime-to-big-sleep.html"],
      ["XBOW", "https://xbow.com/blog/top-1-how-xbow-did-it"],
      ["prompt injection", "https://openai.com/index/prompt-injections/"],
      [
        "Anthropic",
        "https://www.anthropic.com/research/sleeper-agents-training-deceptive-llms-that-persist-through-safety-training",
      ],
    ]);
    for (const node of sourceLinks) {
      expect(node).toHaveAttribute("target", "_blank");
      expect(node).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(Object.values(NOTE_SOURCES)).toHaveLength(4);
    // The OpenAI Astra report is not linked, and no link carries wording the note does not have.
    expect(article.innerHTML).not.toMatch(/path-to-astra|Astra|ExploitBench/i);
  });

  it("claims only what the Big Sleep and XBOW sources support: AI systems discovering vulnerabilities", () => {
    const { container } = render(<WhyHivraPage />);
    const text = (container.querySelector("article") as HTMLElement).textContent ?? "";

    expect(text).toContain("Researchers and security teams have shown AI systems discovering vulnerabilities. Google's Big Sleep uncovered");
    expect(text).toContain("XBOW reported topping HackerOne's US leaderboard in 2025.");
    // The next paragraph points back at two results, so it says "those things", not "all of those things".
    expect(text).toContain("The point isn't that every model can do those things in normal use.");
    expect(text).not.toContain("all of those things");
    // Neither phrase is in the four linked sources, so neither is on the page.
    expect(text).not.toMatch(/exploit chains|sophisticated security tasks|frontier labs|controlled testing/i);
  });

  it("ends with three real links: the home page, the public repository and the ecosystem", () => {
    render(<WhyHivraPage />);

    const row = screen.getByRole("group", { name: "More from Hivra" });
    const links = within(row).getAllByRole("link");
    expect(links.map((node) => [node.textContent, node.getAttribute("href")])).toEqual([
      ["Explore Agent Computers", "/"],
      ["Read the open-source code", "https://github.com/ashneil12/hivra"],
      ["See the ecosystem", "/ecosystem"],
    ]);
    expect(links[1]).toHaveAttribute("target", "_blank");
    expect(links[1]).toHaveAttribute("rel", "noopener noreferrer");
    expect(links[0]).not.toHaveAttribute("target");
    expect(links[2]).not.toHaveAttribute("target");
  });

  it("no longer reads THOUGHTS.md or injects the old access paragraph", () => {
    const source = readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).not.toMatch(/THOUGHTS|readFileSync|react-markdown/);

    render(<WhyHivraPage />);
    expect(screen.queryByText(/Self-hosting needs no token and no account/)).not.toBeInTheDocument();
    expect(screen.queryByText(/card payment works everywhere/)).not.toBeInTheDocument();
  });

  it("carries only the note: no editor notes, placeholders, token ticker or banned claim", () => {
    const { container } = render(<WhyHivraPage />);
    const text = container.textContent ?? "";
    const metadataText = [BROWSER_TITLE, SEARCH_DESCRIPTION].join(" ");

    // Editor notes and implementer directions from the source document never reach the page.
    expect(text).not.toMatch(/Browser title|Search description|Research links|not public copy|Editorial|Implementation notes|Publication checks|\[[^\]]*\]\(/i);
    expect(text).not.toMatch(/\[|\]|\{|\}/);
    // The only token sentence is the short "no token needed" negation, with no ticker.
    expect(text).not.toMatch(/\$HIVRA|\$HermesOS|airdrop|snapshot|litepaper|tokenomics|launchpad|Bankr/i);
    expect(text.match(/\btokens?\b/gi)).toEqual(["token"]);
    expect(text).toContain("Don't make a token a condition of using it.");
    // Product facts the note must not state: plan names, prices, trials, licence, public domain.
    expect(text).not.toMatch(/\b(?:Starter|Pro|Power)\b/);
    expect(text).not.toMatch(/\$\d|free trial|public domain|Apache|MIT licen[cs]e/i);
    // The note says what Hivra is trying to build; it never claims the activity record is complete.
    expect(text).not.toMatch(/records everything/i);
    // The owner's copy rules: no dashes, British spelling.
    expect(`${text} ${metadataText}`).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/\b(?:behaviors?|recogniz\w*|organiz\w*|favorite|center|color|license)\b/i);
    expect(text).toMatch(/behaviours/);

    for (const [label, copy] of [["page text", text], ["metadata", metadataText]] as const) {
      expect(findBannedClaims(copy).map((hit) => `${label}: ${hit.match} (${hit.why})`)).toEqual([]);
    }
    const paragraphs = allParagraphs().map(paragraphText);
    expect(findBannedPublicClaims("why-hivra", [...paragraphs, BROWSER_TITLE, SEARCH_DESCRIPTION])).toEqual([]);
    for (const paragraph of paragraphs) {
      for (const sentence of sentences(paragraph)) expect(findBannedClaims(sentence)).toEqual([]);
    }
  });

  it("keeps the HermesOS transition details on the evolution page", () => {
    render(<WhyHivraEvolutionPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Why Hivra?" })).toBeInTheDocument();
    expect(screen.getByText("HermesOS started as a platform for deploying Hermes Agent.")).toBeInTheDocument();
    expect(screen.getByText("Existing deployments continue working.")).toBeInTheDocument();
    expect(screen.getByText("Existing accounts continue working.")).toBeInTheDocument();
    expect(screen.getByText("No action is required from current users.")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "What happens to $HermesOS?" })).toBeInTheDocument();
    expect(screen.getByText("Existing $HermesOS holders are grandfathered.")).toBeInTheDocument();
    expect(screen.getByText("You keep your access, and you can keep using $HermesOS.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "token page" })).toHaveAttribute("href", "/token");

    expect(screen.getAllByText("Hermes Agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("OpenClaw").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Aeon").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Make launching and operating AI agents as easy as launching a website.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /launch your first agent/i })).toHaveAttribute(
      "href",
      "/sign-up",
    );
  });

  it("describes the token migration as grandfathered $HermesOS plus a proposed $HIVRA, with no same-token claim, while $HIVRA is dormant", () => {
    const { container } = render(<WhyHivraEvolutionPage />);

    // The old copy said the token would never change, which contradicts the proposed migration.
    for (const stale of [/Same token\./, /Same contract\./, /The token is not\./, /A discount mechanism/, /settlement layer/]) {
      expect(container).not.toHaveTextContent(stale);
    }

    // Every statement about $HIVRA is labelled as a proposal.
    const hivraStatements = Array.from(container.querySelectorAll("p, li")).filter((node) =>
      node.textContent?.includes("$HIVRA"),
    );
    expect(hivraStatements.length).toBeGreaterThanOrEqual(4);
    for (const statement of hivraStatements) {
      expect(statement.textContent).toMatch(/propos|plan|does not exist|not open/i);
    }

    // No price, return, scarcity or urgency language on the token.
    expect(container).not.toHaveTextContent(/price|return|profit|scarce|limited time|before it'?s too late|don'?t miss/i);
  });

  it("lists agents by their agent catalog availability", () => {
    render(<WhyHivraEvolutionPage />);
    const availableCard = screen.getByRole("heading", { level: 3, name: "Available now" }).closest("div")!;
    const previewCard = screen.getByRole("heading", { level: 3, name: "In preview" }).closest("div")!;
    for (const [id, label] of [
      ["hermes", "Hermes Agent"],
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["agent-zero", "Agent Zero"],
      ["openclaw", "OpenClaw"],
      ["aeon", "Aeon"],
      ["deepseek-harness", "DeepSeek"],
    ] as const) {
      const card = getAgent(id)?.available ? availableCard : previewCard;
      expect(within(card as HTMLElement).getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { level: 3, name: "Coming soon" })).not.toBeInTheDocument();
  });
});
