/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import RoadmapPage, { metadata } from "../page";
import { LITEPAPER_HREF } from "@/components/public-site/PublicLink";
import { NEW_TOKEN_SURFACES_ENV } from "@/lib/token-surfaces";
import { ROADMAP_NEGATIONS } from "@/lib/roadmap-content";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const PAGE_TITLE = "Hivra Roadmap | What Exists, What's Next and What We're Exploring";
const PAGE_DESCRIPTION =
  "Follow Hivra's move from managed AI agent computers to safer, connected agent infrastructure. See what's live and what's planned. Not the Hermes Agent roadmap.";

const STAGE_HEADINGS = [
  "Available today",
  "Next: make the computer easier to trust and easier to use",
  "Then: the supporting pieces",
  "Research: where this could lead",
];
const NOTE_HEADINGS = ["What happened to the original 2026 plan?", "How to read progress", "Build with us"];

const savedSwitch = process.env[NEW_TOKEN_SURFACES_ENV];
afterEach(() => {
  if (savedSwitch === undefined) delete process.env[NEW_TOKEN_SURFACES_ENV];
  else process.env[NEW_TOKEN_SURFACES_ENV] = savedSwitch;
});

async function renderPage() {
  const result = render(await RoadmapPage());
  // The shared header and footer have their own headings and links; the plan is inside <main>.
  const main = within(result.container.querySelector("main") as HTMLElement);
  return { ...result, main };
}

describe("/roadmap metadata", () => {
  it("uses the approved browser title once, with no brand suffix added by the layout", () => {
    expect(metadata.title).toEqual({ absolute: PAGE_TITLE });
    expect(metadata.description).toBe(PAGE_DESCRIPTION);
    expect(PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    // "hermes agent roadmap" searches land here, so the description says whose roadmap this is not.
    expect(PAGE_DESCRIPTION).toContain("Not the Hermes Agent roadmap.");
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/roadmap");
    expect(metadata.openGraph).toMatchObject({ title: PAGE_TITLE, description: PAGE_DESCRIPTION, type: "website", siteName: "Hivra" });
    expect(metadata.twitter).toMatchObject({ title: PAGE_TITLE, description: PAGE_DESCRIPTION });
  });

  it("carries no dash, no token wording and no date", () => {
    const text = `${PAGE_TITLE} ${PAGE_DESCRIPTION}`;
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/token|\$HIVRA|\$HermesOS|Bankr|litepaper|migration|snapshot/i);
    expect(text).not.toMatch(/\b20\d\d\b/);
  });
});

describe("/roadmap with the token surfaces visible", () => {
  it("has one H1 and the four stages, then the three notes, in order", async () => {
    const { container, main } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The Hivra roadmap.");
    const h2 = main.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(h2).toEqual([...STAGE_HEADINGS, ...NOTE_HEADINGS]);
    const stages = [...container.querySelectorAll("[data-stage]")].map((node) => node.getAttribute("data-stage"));
    expect(stages).toEqual(["today", "next", "then", "research"]);
  });

  it("gives each stage its topics as H3 headings, with the launchpad last in Research", async () => {
    const { main } = await renderPage();
    const h3 = main.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(h3).toEqual([
      "Agent Computers",
      "Choose where it runs",
      "The tools around the computer",
      "A straightforward way to pay",
      "Gate: clearer authority for agents",
      "Exchange: find and share what works",
      "Arena: test before you trust",
      "Signal: security warnings you can act on",
      "A possible launchpad and builder programme",
    ]);
  });

  it("lists the six supporting pieces under Then, each with its name in bold", async () => {
    const { main } = await renderPage();
    const then = main.getByRole("region", { name: STAGE_HEADINGS[2] });
    const items = within(then).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "Vault:",
      "Passport:",
      "Seal:",
      "Rescue:",
      "Challenges:",
      "Experience:",
    ]);
    expect(items[1]).toHaveTextContent("Passport: portable identity and provenance for agents and their work.");
  });

  it("separates what exists from what is planned, in the words of the approved copy", async () => {
    const { container } = await renderPage();
    const text = container.querySelector("main")?.textContent ?? "";
    expect(text).toContain("It isn't a release calendar.");
    expect(text).toContain("This is a product direction, not a claim that every agent action is already governed by Gate.");
    expect(text).toContain("These concepts are connected, but they do not all have to launch together.");
    expect(text).toContain("It is not a live product or committed launch.");
    expect(text).toContain("A feature belongs in the 'available' category only when people can actually use it.");
  });

  it("says Hivra Cloud is paid, that a free account is enough to connect a server you already have, and that self-hosting is a preview", async () => {
    const { container } = await renderPage();
    const topic = container.querySelector('[data-topic="choose-where-it-runs"]');
    expect(topic?.textContent).toContain(
      "Hivra Cloud is where Hivra runs computers for you, on a paid plan. You can also connect a server you already have, and a free account is enough for that. Self-hosting the whole platform is a preview. Self-hosting does not require a Hivra account or a token.",
    );
    // The topic sits under "Available today", so it does not use the word for the preview it still has.
    expect(topic?.textContent).not.toMatch(/\bavailable\b/i);
    // Free is defined as bringing your own computer: the page never says the free account includes one of ours.
    expect(topic?.textContent).not.toMatch(/free (?:computer|plan|tier)/i);
  });

  it("links the hero, the notes and the close to real destinations", async () => {
    const { main } = await renderPage();
    expect(main.getByRole("link", { name: /^get started/i })).toHaveAttribute("href", "/sign-up");
    expect(main.getByRole("link", { name: /^explore the ecosystem/i })).toHaveAttribute("href", "/ecosystem");
    const litepaper = main.getAllByRole("link", { name: /litepaper/i });
    expect(litepaper).toHaveLength(2);
    for (const link of litepaper) expect(link).toHaveAttribute("href", LITEPAPER_HREF);
    expect(main.getByRole("link", { name: "agent page" })).toHaveAttribute("href", "/agents");
    expect(main.getByRole("link", { name: "changelog" })).toHaveAttribute("href", "/changelog");
    expect(main.getByRole("link", { name: "status" })).toHaveAttribute("href", "/status");
    expect(main.getByRole("link", { name: /^explore hivra/i })).toHaveAttribute("href", "/about");
    expect(main.getByRole("link", { name: /^start a computer/i })).toHaveAttribute("href", "/sign-up");
    const source = main.getByRole("link", { name: "open source" });
    expect(source).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
    expect(source).toHaveAttribute("target", "_blank");
  });

  it("shows no implementer placeholder and links to no route that does not exist", async () => {
    const { container } = await renderPage();
    const main = container.querySelector("main");
    expect(main?.textContent).not.toMatch(/[{}[\]]/);
    const hrefs = [...(main?.querySelectorAll("a") ?? [])].map((anchor) => anchor.getAttribute("href") ?? "");
    for (const href of hrefs) {
      expect(href).not.toMatch(/^\/litepaper|archive|april-2026|\{/);
      expect(href).not.toBe("");
    }
    expect(screen.queryByRole("link", { name: /april 2026 roadmap archive/i })).not.toBeInTheDocument();
  });

  it("describes the page in JSON-LD with the approved title and no token wording", async () => {
    const { container } = await renderPage();
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.textContent).not.toMatch(/token|\$HIVRA|\$HermesOS/i);
    const graph = JSON.parse(script?.textContent ?? "{}")["@graph"] as Array<Record<string, unknown>>;
    const page = graph.find((node) => node["@type"] === "WebPage");
    expect(page?.url).toBe("https://hivra.cloud/roadmap");
    expect(page?.name).toBe(PAGE_TITLE);
    expect(page?.description).toBe(PAGE_DESCRIPTION);
  });
});

describe("/roadmap with the token surfaces off", () => {
  beforeEach(() => {
    delete process.env[NEW_TOKEN_SURFACES_ENV];
  });

  it("drops the launchpad, the migration, the litepaper and every token word apart from the three negations", async () => {
    const { container } = await renderPage();
    const main = container.querySelector("main");
    let text = main?.textContent ?? "";
    for (const negation of ROADMAP_NEGATIONS) {
      expect(text).toContain(negation);
      text = text.split(negation).join("");
    }
    expect(text).not.toMatch(/\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b|wallets?|launchpad|litepaper|snapshot|airdrop|Sablier|migration/i);
    expect(within(main as HTMLElement).queryByRole("link", { name: /litepaper/i })).not.toBeInTheDocument();
    expect(within(main as HTMLElement).queryByRole("heading", { level: 3, name: /launchpad/i })).not.toBeInTheDocument();
    const hrefs = [...(main?.querySelectorAll("a") ?? [])].map((anchor) => anchor.getAttribute("href") ?? "");
    for (const href of hrefs) expect(href).not.toMatch(/token|litepaper|bankr/i);
  });

  it("still gives the whole plan that is not about the tokens", async () => {
    const { main } = await renderPage();
    expect(main.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([...STAGE_HEADINGS, ...NOTE_HEADINGS]);
    expect(main.getAllByRole("heading", { level: 3 })).toHaveLength(8);
    expect(screen.getByText("Hivra Cloud has ordinary subscription pricing. Neither using a card nor trying the self-host preview requires you to participate in a token.")).toBeInTheDocument();
  });
});
