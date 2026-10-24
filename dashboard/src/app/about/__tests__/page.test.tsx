/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import AboutPage, { metadata } from "../page";
import {
  ABOUT_DESCRIPTION,
  ABOUT_HEADINGS,
  ABOUT_TITLE,
  buildAboutContent,
  DISAMBIGUATION,
  plainText,
  REPOSITORY_LABEL,
} from "../about-content";
import { LITEPAPER_HREF } from "@/components/public-site/PublicLink";
import { ENTRY_PLAN_PRICE, HOSTED_COMPUTE_NEEDS_PLAN_SHORT, LARGER_PLAN_PRICE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { NON_AFFILIATION_LINE } from "@/lib/brand-description";
import { NEW_TOKEN_SURFACES_ENV } from "@/lib/token-surfaces";
import { findBannedClaims } from "@/lib/tools/copy-rules";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// The owner's title and description for the page (the md header lines).
const MD_TITLE = "About Hivra | Open-source computers for AI agents";
const MD_DESCRIPTION =
  "Hivra, formerly HermesOS, gives AI agents their own computers. Learn what Hivra does, how it works, what it costs and how to reach us.";

// Shows only the offending words on failure instead of the whole page text.
function hits(text: string, pattern: RegExp): string[] {
  return text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? [];
}

/** The words of the page itself: the shared header and footer are not this lane's copy. */
function pageText(container: HTMLElement): string {
  return container.querySelector("main")?.textContent ?? "";
}

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')];
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].textContent ?? "{}")["@graph"];
}

const savedSwitch = process.env[NEW_TOKEN_SURFACES_ENV];
afterEach(() => {
  if (savedSwitch === undefined) delete process.env[NEW_TOKEN_SURFACES_ENV];
  else process.env[NEW_TOKEN_SURFACES_ENV] = savedSwitch;
});

/** jest.setup turns the token surfaces ON; the production default is off. */
async function renderAbout(tokenSurfaces: boolean) {
  process.env[NEW_TOKEN_SURFACES_ENV] = tokenSurfaces ? "true" : "false";
  return render(await AboutPage());
}

/** The Windows rule in copy-rules.ts bans the word everywhere; this page names it only with its condition, never as plainly available (owner decision 2026-09-28). */
function bannedClaims(text: string) {
  return findBannedClaims(text).filter((hit) => !/Windows computers are not generally available/.test(hit.why));
}

// Every paragraph of the owner's md that the page carries word for word. Kept here, apart from
// about-content.ts, so a change to the content module that drifts from the md fails.
const VERBATIM = [
  "Hivra makes it easier to give an AI agent a computer of its own.",
  "Not a window on your laptop. Not a model being asked to stay inside a folder. A separate environment where an agent can run commands, browse, use tools and get work done, without starting out next to your personal files and signed-in accounts.",
  "You can let us host that computer or run the open-source platform yourself.",
  "Hivra started as HermesOS, a straightforward way to deploy Hermes Agent. The more we built, the clearer something became: this shouldn't be tied to one agent or one model.",
  "People were already using Claude Code, Codex and other tools to do serious work. What they needed wasn't another assistant telling them what it could do. They needed a reliable computer to run it on, one they could see, access and control.",
  "So HermesOS became Hivra. The name changed to make room for the wider project. Existing Hivra/HermesOS users, accounts and deployments carried across the rebrand.",
  // The owner's md also said "and paid-plan restrictions" here and "OpenClaw and Agent Zero need a paid size" after it.
  // On 21 October 2026 the owner ruled that Hivra runs no free computer, so no agent is singled out as the paid one.
  "Deploy Claude Code, Codex, Hermes, OpenClaw, Agent Zero and Aeon through their supported workflows. Different agents have different requirements, including cloud-only restrictions.",
  "Agent Computers aren't only for agents.",
  "Connect through a browser, inspect what happened and take over when necessary.",
  "Pay for Hivra Cloud, connect infrastructure you already have or run the open-source platform yourself. The options aren't identical, and we'll tell you where a particular agent needs Hivra Cloud.",
  "Hivra runs the computers and supports the agents. It doesn't replace the underlying models or their providers.",
  "Hermes Agent comes from Nous Research, Claude Code from Anthropic, and Codex from OpenAI. We support those tools without claiming to have created them or to represent their companies.",
  "A separate computer reduces what is available by default, but the limits depend on the accounts, permissions and network access you connect. You should still review what your agents can do.",
  "Hivra's software can be self-hosted without buying or holding a token. Card-paid cloud hosting is available separately.",
  "When software stands between an agent and the things it can access, people should be able to inspect that software.",
  "You can check it, work on it and deploy the platform yourself rather than being dependent on a private hosted service.",
  "That doesn't mean every deployment is automatically secure, or that public code has been audited. It means you can verify how Hivra works and choose who operates it.",
  "Agent Computers are the starting point. The longer-term work is about helping people use increasingly capable agents without handing them everything at once.",
  "We're planning tools for tightly scoped account access (Gate), discovering and distributing agent software (Exchange), testing agents against real failures in controlled environments (Arena), and sharing actionable security warnings (Signal).",
  "Other ideas in the wider ecosystem are further away. They are described as plans or research, not products you can buy today.",
  "Hivra is an independent project founded by Ash, who builds with AI agents himself. The motivation is both practical and personal: capable agents are useful, but their access shouldn't depend entirely on how well they follow instructions.",
  "Our official website is hivra.cloud. We're not affiliated with unrelated projects using similar names, including sites at hivra.ai or hivra.app.",
];

describe("/about metadata", () => {
  it("is indexable on its own URL with the owner's title and description, and the title is not given a second brand", () => {
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/about");
    expect(ABOUT_TITLE).toBe(MD_TITLE);
    expect(ABOUT_DESCRIPTION).toBe(MD_DESCRIPTION);
    // absoluteTitle() skips the layout's "%s | Hivra" template, so the finished title is not "... | Hivra | Hivra".
    expect(metadata.title).toEqual({ absolute: MD_TITLE });
    expect(metadata.description).toBe(MD_DESCRIPTION);
    expect(MD_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect((metadata.openGraph as { title?: string }).title).toBe(MD_TITLE);
    expect((metadata.twitter as { title?: string }).title).toBe(MD_TITLE);
    expect((metadata.openGraph as { description?: string }).description).toBe(MD_DESCRIPTION);
  });

  it("makes no banned claim and uses no dash in the title or description, and names no token", () => {
    // app/__tests__/absolute-title-metadata.test.ts cannot read a title imported from the content module, so it is scanned here.
    const text = `${MD_TITLE}\n${MD_DESCRIPTION}`;
    expect(bannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\$HIVRA|\$HermesOS|token|airdrop|litepaper|snapshot|Bankr/i);
  });

  it("keeps the question answers at a reading measure, as the pricing and home questions do", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "about.module.css"), "utf8");
    expect(css).toMatch(/\.faq section details > p,\s*\.faq section details > div\s*\{\s*max-width:\s*68ch;/);
  });

  it("is written with absoluteTitle and a title the shared scanners can read", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).toMatch(/title:\s*absoluteTitle\(ABOUT_TITLE\)/);
    expect(source).toMatch(/\.\.\.buildWebsiteMetadata\(\{ path: "\/about", title: ABOUT_TITLE, description: ABOUT_DESCRIPTION \}\)/);
    expect(source).not.toMatch(/metadata\s*=\s*buildWebsiteMetadata\(/);
  });
});

describe("/about copy (token surfaces off, the production default)", () => {
  it("opens with the owner's lead under a single H1 and breadcrumbs", async () => {
    const { container } = await renderAbout(false);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^About Hivra$/);
    const [lead, second, third] = [...container.querySelectorAll("header p")].map((node) => node.textContent);
    expect(lead).toBe(VERBATIM[0]);
    expect(second).toBe(VERBATIM[1]);
    expect(third).toBe(VERBATIM[2]);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(crumbs).toHaveTextContent("About");
  });

  it("carries every paragraph of the owner's text that the repo rules leave alone", async () => {
    const { container } = await renderAbout(false);
    // One line per element with a space where a block ends, like reading the page.
    const text = pageText(container).replace(/\s+/g, " ");
    for (const line of VERBATIM) {
      expect({ line, found: text.includes(line) }).toEqual({ line, found: true });
    }
  });

  it("shows the sections in the owner's order, each as a named region, with 'What Hivra costs' instead of 'How Hivra is funded'", async () => {
    await renderAbout(false);
    const order = Object.values(ABOUT_HEADINGS);
    const headings = within(screen.getByRole("main"))
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent);
    expect(headings).toEqual([...order, "Common questions"]);
    for (const name of order) expect(screen.getByRole("region", { name })).toBeInTheDocument();
    expect(screen.queryByText(/How Hivra is funded/)).toBeNull();
  });

  it("lists what you can do today as a definition list with the repo-approved wording", async () => {
    await renderAbout(false);
    const today = screen.getByRole("region", { name: ABOUT_HEADINGS.today });
    const terms = [...today.querySelectorAll("dt")].map((node) => node.textContent);
    expect(terms).toEqual([
      "Run supported AI agents.",
      "Launch a computer for yourself.",
      "Come back to the same machine.",
      "Choose where it runs.",
      "Bring your own AI access.",
    ]);
    // Concrete restrictions: Hermes is cloud only, and every computer Hivra Cloud runs is paid, whichever agent it carries
    // (owner decision, 21 October 2026). No agent is singled out as the paid one.
    expect(today).toHaveTextContent("Hermes runs on Hivra Cloud only. Every Hivra Cloud computer needs a paid plan.");
    expect(HOSTED_COMPUTE_NEEDS_PLAN_SHORT).toBe("Every Hivra Cloud computer needs a paid plan.");
    expect(today.textContent).not.toMatch(/paid size|OpenClaw and Agent Zero need/i);
    // Omarchy and Windows are never called plainly available: the code runs Omarchy as a prepared
    // computer (it refuses a launch when no prepared slot exists) and Windows on the visitor's own
    // server from their own licensed image. Nothing is called a preview.
    expect(today).toHaveTextContent(
      "You can use one yourself, with a desktop or terminal as supported by that environment. Choose Ubuntu, Omarchy (prepared computer) or Windows on your own server with your licensed image.",
    );
    expect(hits(today.textContent ?? "", /\bWindows\b/)).toHaveLength(1);
    expect(hits(today.textContent ?? "", /\bOmarchy\b/)).toHaveLength(1);
    expect(today.textContent).not.toMatch(/\bavailable\b/i);
    // C5: the approved keep-running sentence, not "remain on when you shut your own laptop".
    expect(today).toHaveTextContent("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
    expect(today.textContent).not.toMatch(/shut your own laptop|close your laptop|keeps? (?:going|working|running)/i);
    // C6: AI usage is not included; accounts or keys where the agent supports it, or Hivra credits.
    expect(today).toHaveTextContent(
      "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
    );
  });

  it("says what Hivra is not, with the token negation in the words 'a token' and nothing more", async () => {
    await renderAbout(false);
    const isNot = screen.getByRole("region", { name: ABOUT_HEADINGS.isNot });
    const leads = [...isNot.querySelectorAll("strong")].map((node) => node.textContent);
    expect(leads).toEqual([
      "It isn't an AI model.",
      "It isn't affiliated with the makers of the agents.",
      "It isn't a promise that agents can never cause harm.",
      "It isn't a token-only service.",
    ]);
    expect(isNot).toHaveTextContent("Hivra's software can be self-hosted without buying or holding a token.");
    expect(isNot.textContent).not.toMatch(/economic plans|prerequisites/);
  });

  it("states the two sizes with the shared price words, the guarantee and links to pricing and terms", async () => {
    await renderAbout(false);
    const costs = screen.getByRole("region", { name: ABOUT_HEADINGS.costs });
    expect(costs).toHaveTextContent(
      "Hivra Cloud is a paid hosting service. The entry size is $9.99 a month for 2 vCPU and 4 GB of RAM. A larger size is $19.99 a month for 4 vCPU and 8 GB of RAM. Self-hosting the software costs nothing, but you provide your own server and cover any AI usage.",
    );
    expect(ENTRY_PLAN_PRICE).toBe("$9.99");
    expect(LARGER_PLAN_PRICE).toBe("$19.99");
    // The prices are bold in the owner's text; the page keeps that.
    expect([...costs.querySelectorAll("strong")].map((node) => node.textContent)).toEqual([
      "$9.99 a month for 2 vCPU and 4 GB of RAM",
      "$19.99 a month for 4 vCPU and 8 GB of RAM",
      MONEY_BACK_GUARANTEE,
    ]);
    expect(MONEY_BACK_GUARANTEE).toBe("7-day money-back guarantee on card payments");
    // The rule in the canonical words, without the price a second time (it is in the paragraph above): every Hivra
    // Cloud computer is paid, and a free account works with your own.
    expect(costs).toHaveTextContent(
      "Every Hivra Cloud computer needs a paid plan. A free account works with a computer or server you connect yourself.",
    );
    expect((costs.textContent ?? "").match(/\$9\.99/g)).toHaveLength(1);
    expect(costs).toHaveTextContent(`Paid Hivra Cloud plans come with a ${MONEY_BACK_GUARANTEE}. Check the pricing and terms pages for the details before buying.`);
    expect(within(costs).getByRole("link", { name: "pricing" })).toHaveAttribute("href", "/pricing");
    expect(within(costs).getByRole("link", { name: "terms" })).toHaveAttribute("href", "/terms");
    const text = costs.textContent ?? "";
    expect(text).not.toMatch(/\/month|\/mo\b|seven-day|eligible|annual|per year|yearly/i);
    expect(text).not.toMatch(/\b(?:Starter|Pro|Power)\b/);
  });

  it("keeps the token ecosystem, the migration and the litepaper off the page and out of the markup", async () => {
    const { container } = await renderAbout(false);
    const text = [pageText(container), JSON.stringify(jsonLd(container)), String(metadata.description)].join("\n");
    expect(hits(text, /\$HIVRA|\$HermesOS|HermesOS token|token ecosystem|token pages|tokenomics|airdrop|snapshot|migration|launchpad|Bankr|wallet|litepaper|economic plans/i)).toEqual([]);
    expect(container.querySelector(`a[href="${LITEPAPER_HREF}"], a[href*="litepaper"], a[href="/token"], a[href="/tokenomics"]`)).toBeNull();
    // The ecosystem map is always linked, with the owner's closing sentence for this variant.
    const going = screen.getByRole("region", { name: ABOUT_HEADINGS.going });
    expect(going).toHaveTextContent("See the ecosystem map for the distinction.");
    expect(within(going).getByRole("link", { name: "ecosystem map" })).toHaveAttribute("href", "/ecosystem");
    // The lookalike-domain warning loses only the wallet clause.
    expect(screen.getByRole("region", { name: ABOUT_HEADINGS.rightHivra })).toHaveTextContent(
      "When you're signing in or paying, check the domain carefully.",
    );
    // The FAQ keeps the token question as a short negation, in the words "a token".
    expect(screen.getByText("Do I need a token?")).toBeInTheDocument();
    expect(screen.queryByText("Do I need $HIVRA?")).toBeNull();
  });

  it("marks Gate, Exchange, Arena and Signal as plans, not products", async () => {
    await renderAbout(false);
    const going = screen.getByRole("region", { name: ABOUT_HEADINGS.going });
    const planned = [...going.querySelectorAll("strong")].map((node) => node.textContent);
    expect(planned).toEqual(["Gate", "Exchange", "Arena", "Signal"]);
    expect(going).toHaveTextContent("We're planning tools for");
    expect(going).toHaveTextContent("described as plans or research, not products you can buy today");
    expect(going.textContent).not.toMatch(/available now|launched|\blive\b|generally available/i);
  });

  it("names the founder as Ash only and links the founder's essay", async () => {
    await renderAbout(false);
    const builder = screen.getByRole("region", { name: ABOUT_HEADINGS.builder });
    expect(builder).toHaveTextContent("Hivra is an independent project founded by Ash, who builds with AI agents himself.");
    expect(within(builder).getByRole("link", { name: "Why I'm building Hivra" })).toHaveAttribute("href", "/why-hivra");
    // One name: the site states no surname.
    expect(builder.textContent).not.toMatch(/Ash [A-Z][a-z]+/);
  });

  it("links the repository, the email and every page the owner lists, with real routes only", async () => {
    await renderAbout(false);
    const region = screen.getByRole("region", { name: ABOUT_HEADINGS.contact });
    const expected: Array<[string, string]> = [
      ["GitHub", "https://github.com/ashneil12/hivra"],
      ["Pricing", "/pricing"],
      ["Status", "/status"],
      ["Security", "/security"],
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
      ["X", "https://x.com/HivraOS"],
    ];
    for (const [name, href] of expected) {
      expect(within(region).getByRole("link", { name })).toHaveAttribute("href", href);
    }
    for (const name of ["GitHub", "X"]) {
      expect(within(region).getByRole("link", { name })).toHaveAttribute("target", "_blank");
      expect(within(region).getByRole("link", { name })).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(within(region).getByRole("link", { name: "Pricing" })).not.toHaveAttribute("target");
    expect(within(region).getByRole("link", { name: "info@hivra.cloud" })).toHaveAttribute("href", "mailto:info@hivra.cloud");
    expect(region).toHaveTextContent("For questions and support: info@hivra.cloud.");
    const items = [...region.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([
      "GitHub:Read the code and follow development.",
      "Pricing:Current hosting plans and restrictions.",
      "Status:Service status.",
      "Security:How to report a vulnerability privately.",
      "Privacy and Terms:How the service is operated and the rules of use.",
      "X:Updates from the project.",
    ]);
    // The repository is linked in the open source section too, under its address.
    const openSource = screen.getByRole("region", { name: ABOUT_HEADINGS.openSource });
    expect(within(openSource).getByRole("link", { name: REPOSITORY_LABEL })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  });

  it("points every internal link at a page the app serves, and never at /litepaper", async () => {
    const { container } = await renderAbout(false);
    const appRoot = path.join(__dirname, "..", "..");
    const internal = [...(container.querySelector("main")?.querySelectorAll("a[href^='/']") ?? [])]
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => !href.startsWith("/docs/"));
    expect(internal.length).toBeGreaterThan(8);
    for (const href of new Set(internal)) {
      const route = href.replace(/[?#].*$/, "");
      if (route === "/") continue;
      const exists = fs.existsSync(path.join(appRoot, route.slice(1), "page.tsx"));
      expect({ href, exists }).toEqual({ href, exists: true });
    }
    expect(container.querySelector('a[href="/litepaper"]')).toBeNull();
  });

  it("names the lookalike sites without linking or criticising them", async () => {
    const { container } = await renderAbout(false);
    const notice = screen.getByRole("region", { name: ABOUT_HEADINGS.rightHivra });
    expect(notice).toHaveTextContent("Our official website is hivra.cloud.");
    expect(notice).toHaveTextContent("including sites at hivra.ai or hivra.app");
    expect(container.querySelector('a[href*="hivra.ai"], a[href*="hivra.app"]')).toBeNull();
    expect(hits(pageText(container), /scam|fake|fraud|copycat|competitor/i)).toEqual([]);
  });

  it("invents no facts: no legal entity, registration, address, funding or founder details the site does not state", async () => {
    const { container } = await renderAbout(false);
    const text = pageText(container);
    expect(hits(text, /\b(Ltd|Limited|LLC|LLP|plc|Inc\.?|GmbH|Corp\.?|VAT|EIN)\b/)).toEqual([]);
    expect(hits(text, /registered (company|office|in)|company (number|no)|legal entity|headquarter/i)).toEqual([]);
    expect(hits(text, /\b(Street|Road|Avenue|Suite|PO Box|postcode)\b/i)).toEqual([]);
    expect(hits(text, /funded by|raised|investors?|venture|seed round|backed by|bootstrapped|profitable/i)).toEqual([]);
    // Nor a claim about who pays for Hivra: nothing in the repository says how it is funded.
    expect(hits(text, /paid for|paid by|pays for|who use it|supported by (?:its |our )?(?:users|customers)|(?:user|customer|self)[- ]funded|no outside funding/i)).toEqual([]);
    expect(hits(text, /founded in|\bborn\b|lives in|based in|located in|years of experience/i)).toEqual([]);
    // Marketing copy never names the licence or says public domain.
    expect(hits(text, /apache|mit licen|\blicen[sc]e\b|public domain/i)).toEqual([]);
  });

  it("makes no banned public claim and uses the plain vocabulary, in the page, the FAQ and the markup", async () => {
    const { container } = await renderAbout(false);
    const text = [pageText(container), String(metadata.description), JSON.stringify(jsonLd(container))].join("\n");
    expect(bannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/\b(box|boxes|runtime|runtimes|instance|instances)\b/i);
    expect(text).not.toMatch(/[–—]/);
    // Windows and Omarchy are never labelled preview (owner decision 2026-09-28), and never called plainly available either (pinned in the "what you can do today" test).
    expect(text).not.toMatch(/\bpreview\b|private preview|\bbeta\b|coming soon/i);
    // No trial, no hosted free plan, no card-free claim, no speed claim.
    expect(text).not.toMatch(/free trial|free plan|free tier|no card|in minutes|one[- ]click|instantly/i);
    // British spelling in the words the owner's text uses.
    expect(hits(text, /\b(?:color|organize|optimize|customize|authorize|recognize|center)\b/i)).toEqual([]);
  });

  it("does not imply Hivra is affiliated with or endorsed by a model or agent provider", async () => {
    const { container } = await renderAbout(false);
    const text = pageText(container);
    expect(hits(text, /officially (?:supported|partnered)|partner(?:ed)? with|endorsed by|certified by|approved by|official (?:Anthropic|OpenAI|Nous)/i)).toEqual([]);
    expect(text).toContain("It isn't affiliated with the makers of the agents.");
    // The FAQ answers the affiliation question it asks. It does not say "independent": Hivra supports agents those companies make,
    // so what those agents can do depends on their makers' software and terms.
    expect(text).toContain(
      "No. Hivra isn't affiliated with those companies. It supports agents they make, such as Claude Code, Codex and Hermes, so what those agents can do depends on their makers' software and terms.",
    );
    expect(text).not.toMatch(/independent of Anthropic|Yes\. Hivra isn't affiliated/);
  });

  it("tells a visitor without a paid plan what a free account is for, in the FAQ", async () => {
    await renderAbout(false);
    const free = screen.getByText("Can I run Hivra without paying for cloud hosting?").closest("details") as HTMLElement;
    expect(free).toHaveTextContent(
      "Yes. Create a free account and connect your own computer or server, or self-host the open-source platform. Hivra doesn't run a computer for you without a paid plan, and you'll still pay your infrastructure and AI providers.",
    );
  });

  it("answers the seven questions and adds the provider-terms and credits wording to the AI subscription answer", async () => {
    await renderAbout(false);
    const questions = [
      "Is Hivra the same project as HermesOS?",
      "Is Hivra the same as hivra.ai or hivra.app?",
      "Can I run Hivra without paying for cloud hosting?",
      "Can I use my existing AI subscription?",
      "Is Hivra affiliated with Anthropic, OpenAI or Nous Research?",
      "Do I need a token?",
      "How do I report a security issue?",
    ];
    const summaries = [...document.querySelectorAll("summary")].map((node) => node.firstChild?.textContent);
    expect(summaries).toEqual(questions);
    const ai = screen.getByText("Can I use my existing AI subscription?").closest("details") as HTMLElement;
    expect(ai).toHaveTextContent("subject to the provider's terms");
    expect(ai).toHaveTextContent("you may need your own API key or Hivra credits");
    expect(ai).toHaveTextContent("The plan does not include AI usage.");
  });

  it("links the security answer inside the FAQ and mirrors it in the markup", async () => {
    const { container } = await renderAbout(false);
    const details = screen.getByText("How do I report a security issue?").closest("details") as HTMLElement;
    expect(within(details).getByRole("link", { name: "hivra.cloud/security" })).toHaveAttribute("href", "/security");
    expect(within(details).getByRole("link", { name: "info@hivra.cloud" })).toHaveAttribute("href", "mailto:info@hivra.cloud");
    expect(details).toHaveTextContent(
      "Follow the private reporting instructions at hivra.cloud/security. For general support, email info@hivra.cloud.",
    );
    const faq = jsonLd(container).find((node) => node["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq.mainEntity.at(-1)?.acceptedAnswer.text).toBe(
      "Follow the private reporting instructions at hivra.cloud/security. For general support, email info@hivra.cloud.",
    );
  });

  it("answers the lookalike-site question with the exact entity sentences, in the page and in the FAQPage markup", async () => {
    const { container } = await renderAbout(false);
    // Word for word as the page stated them before the overhaul (git b9fe7921). llms.txt carries the same non-affiliation sentence.
    expect(DISAMBIGUATION).toBe("Hivra at hivra.cloud is unrelated to other projects called Hivra, such as hivra.ai and hivra.app.");
    expect(NON_AFFILIATION_LINE).toBe("Hivra is not affiliated with Nous Research, Anthropic or OpenAI.");
    const question = "Is Hivra the same as hivra.ai or hivra.app?";
    const answer = `No. ${DISAMBIGUATION} ${NON_AFFILIATION_LINE}`;
    const details = screen.getByText(question).closest("details") as HTMLElement;
    expect(details).toHaveTextContent(answer);
    // The lookalike sites are named, never linked.
    expect(details.querySelector("a")).toBeNull();
    const faq = jsonLd(container).find((node) => node["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq.mainEntity.filter((entry) => entry.name === question)).toHaveLength(1);
    expect(faq.mainEntity.find((entry) => entry.name === question)?.acceptedAnswer.text).toBe(answer);
    // One entity question: the question list is the owner's six plus this one.
    expect(faq.mainEntity).toHaveLength(7);
  });

  it("marks up an AboutPage that points at the homepage Organization, and an FAQ that mirrors the page", async () => {
    const { container } = await renderAbout(false);
    const graph = jsonLd(container);
    const about = graph.find((node) => node["@type"] === "AboutPage") as Record<string, unknown>;
    expect(about.url).toBe("https://hivra.cloud/about");
    expect(about.name).toBe(MD_TITLE);
    expect(about.description).toBe(MD_DESCRIPTION);
    expect(about.about).toEqual({ "@id": "https://hivra.cloud/#organization" });
    expect(about.mainEntity).toEqual({ "@id": "https://hivra.cloud/#organization" });
    expect(about.isPartOf).toEqual({ "@id": "https://hivra.cloud/#website" });

    const faq = graph.find((node) => node["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    const content = buildAboutContent({ tokens: false });
    expect(faq.mainEntity.map((entry) => [entry.name, entry.acceptedAnswer.text])).toEqual(content.faq.map(({ q, a }) => [q, a]));
    // Each visible answer reads the same as its markup text.
    for (const { q, a } of content.faq) {
      const details = screen.getByText(q).closest("details") as HTMLElement;
      expect(details.textContent?.replace(q, "").replace(/^\+/, "").replace(/\s+/g, " ").trim()).toBe(a);
    }
    // No second Organization node: the homepage owns it.
    expect(graph.some((node) => node["@type"] === "Organization")).toBe(false);
  });

  it("adds glossary tooltips to plain words without changing the text", async () => {
    const { container } = await renderAbout(false);
    const main = container.querySelector("main") as HTMLElement;
    expect(main.querySelectorAll("[data-gloss]").length).toBeGreaterThan(0);
    expect(main.querySelector("a [data-gloss], strong [data-gloss]")).toBeNull();
    expect(plainText("**Bold** and [a link](/x).")).toBe("Bold and a link.");
  });
});

describe("/about copy (token surfaces on, viewer not blocked)", () => {
  it("adds only the owner's token sentences, each behind the switch", async () => {
    const { container } = await renderAbout(true);
    const isNot = screen.getByRole("region", { name: ABOUT_HEADINGS.isNot });
    expect(isNot).toHaveTextContent(
      "Hivra's software can be self-hosted without buying or holding a token. Card-paid cloud hosting is available separately. Hivra also has a token and future economic plans, but those aren't prerequisites for using the open-source platform.",
    );
    const costs = screen.getByRole("region", { name: ABOUT_HEADINGS.costs });
    expect(costs).toHaveTextContent(
      "There's a separate Hivra token ecosystem. Its current arrangements and proposed uses are explained on the token pages, not folded into ordinary hosting prices or presented as a requirement to use the software.",
    );
    expect(within(costs).getByRole("link", { name: "token pages" })).toHaveAttribute("href", "/token");
    expect(screen.getByRole("region", { name: ABOUT_HEADINGS.rightHivra })).toHaveTextContent(
      "When you're signing in, paying or connecting a wallet, check the domain carefully.",
    );
    expect(screen.getByText("Do I need $HIVRA?")).toBeInTheDocument();
    expect(screen.queryByText("Do I need a token?")).toBeNull();

    // /litepaper is not a route: the link goes to the static document, as a plain anchor.
    const going = screen.getByRole("region", { name: ABOUT_HEADINGS.going });
    expect(going).toHaveTextContent("See the ecosystem map and litepaper for the distinction.");
    expect(within(going).getByRole("link", { name: "litepaper" })).toHaveAttribute("href", LITEPAPER_HREF);
    expect(within(going).getByRole("link", { name: "ecosystem map" })).toHaveAttribute("href", "/ecosystem");
    expect(container.querySelector('a[href="/litepaper"]')).toBeNull();
  });

  it("keeps the same FAQ markup as the page, token question included", async () => {
    const { container } = await renderAbout(true);
    const content = buildAboutContent({ tokens: true });
    const faq = jsonLd(container).find((node) => node["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq.mainEntity.map((entry) => [entry.name, entry.acceptedAnswer.text])).toEqual(content.faq.map(({ q, a }) => [q, a]));
    expect(faq.mainEntity.map((entry) => entry.name)).toContain("Do I need $HIVRA?");
    expect(faq.mainEntity.find((entry) => entry.name === "Do I need $HIVRA?")?.acceptedAnswer.text).toBe(
      "No. It's not required for self-hosting or ordinary card-paid access.",
    );
  });

  it("still passes the banned-claims scan and keeps the metadata free of token words", async () => {
    const { container } = await renderAbout(true);
    const text = [pageText(container), JSON.stringify(jsonLd(container))].join("\n");
    expect(bannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/[–—]/);
    expect(`${metadata.title && JSON.stringify(metadata.title)} ${metadata.description}`).not.toMatch(/\$HIVRA|token|litepaper/i);
    // Never an imported sample: no date, address or figure from a dry run.
    expect(hits(text, /0x[0-9a-fA-F]{6,}|snapshot (?:has been|was) (?:taken|completed)|claim window|opens on|closes on/i)).toEqual([]);
  });
});
