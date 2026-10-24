/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

// The view module reaches the server-only geo modules; only the page's own use of it is under test here.
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: jest.fn() }));
jest.mock("@/lib/compliance/token-surface-view", () => ({
  ...jest.requireActual("@/lib/compliance/token-surface-view"),
  getTokenSurfaceView: jest.fn(),
}));

import PricingPage, { metadata } from "../page";
import {
  HOSTED_SIZES,
  PRICING_ACTIONS,
  PRICING_FAQ,
  PRICING_FAQ_HEADING,
  PRICING_INTRO,
  PRICING_OPTIONS,
  SELF_HOST_SOURCE_URL,
} from "../pricing-content";
import { BANNED_PUBLIC_CLAIMS, renderedCopy, sentences } from "@/app/features/__tests__/public-claims";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { getTokenSurfaceView, type TokenSurfaceView } from "@/lib/compliance/token-surface-view";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n";
import { HOSTED_MACHINES } from "@/lib/subscription/hosted-ladder";
import { PAYMENT_GRACE_HOURS, PLANS } from "@/lib/subscription/plans";
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

const SWITCH_OFF: TokenSurfaceView = { tokenSurfaces: false, geoBlocked: false };
const SWITCH_ON: TokenSurfaceView = { tokenSurfaces: true, geoBlocked: false };
const GEO_BLOCKED: TokenSurfaceView = { tokenSurfaces: true, geoBlocked: true };

/** The page is an async server component; the production default is the token surfaces OFF. */
async function renderPricing(view: TokenSurfaceView = SWITCH_OFF) {
  (getTokenSurfaceView as jest.Mock).mockResolvedValue(view);
  return render(await PricingPage());
}

function jsonLd(container: HTMLElement): string {
  return [...container.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent ?? "").join("\n");
}

function pageAndStructuredText(container: HTMLElement): string {
  const og = metadata.openGraph as { title?: string; description?: string } | undefined;
  return [container.textContent ?? "", titleOf(), String(metadata.description), og?.title, og?.description, jsonLd(container)].join("\n");
}

function titleOf(): string {
  return (metadata.title as { absolute: string }).absolute;
}

function faqGraph(container: HTMLElement) {
  const schema = JSON.parse(jsonLd(container));
  return schema["@graph"].find((node: { "@type": string }) => node["@type"] === "FAQPage") as {
    mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
  };
}

const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

describe("/pricing metadata", () => {
  it("is indexable on its own URL with the finished title, not the template's second brand", () => {
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/pricing");
    // absoluteTitle(): the root template's " | Hivra" is not appended to a title that carries its own brand.
    expect(metadata.title).toEqual({ absolute: "Hivra Pricing | Self-host free or cloud from $9.99/month" });
    expect(metadata.description).toBe(
      "Run Hivra on your own infrastructure for free, or choose a managed agent computer from $9.99/month. Compare resources, AI costs and hosting options.",
    );
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
  });

  it("gives Open Graph and Twitter the same title and description, and keeps the price in step with the plans", () => {
    const og = metadata.openGraph as { title?: string; description?: string; url?: string };
    const twitter = metadata.twitter as { title?: string; description?: string };
    expect(og.title).toBe(titleOf());
    expect(twitter.title).toBe(titleOf());
    expect(og.description).toBe(metadata.description);
    expect(twitter.description).toBe(metadata.description);
    expect(og.url).toBe("https://hivra.cloud/pricing");
    // Fails when checkout's entry price moves, so the title and description cannot go stale.
    expect(titleOf()).toContain(`${ENTRY_PLAN_PRICE}/month`);
    expect(String(metadata.description)).toContain(`${ENTRY_PLAN_PRICE}/month`);
  });

  it("has no dash and makes no banned claim in the title or description", () => {
    const text = `${titleOf()}\n${metadata.description}`;
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/\|\s*Hivra\s*$/m);
  });
});

describe("/pricing page", () => {
  it("has one H1 over the seven md sections, in the md order", async () => {
    const { container } = await renderPricing();
    const main = within(container.querySelector("main") as HTMLElement);

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(squash(h1s[0].textContent)).toBe("A computer for your agent. Without the server setup.");
    expect(main.getAllByRole("heading", { level: 2 }).map((heading) => squash(heading.textContent))).toEqual([
      "Choose how you want to run it",
      "Compare your options",
      "What you're paying for",
      "Important differences between agents",
      "Refunds and billing",
      PRICING_FAQ_HEADING,
      "Ready to give it a computer?",
    ]);
    expect(PRICING_FAQ_HEADING).toBe("Questions people usually ask");
    expect(main.getAllByRole("heading", { level: 3 }).map((heading) => squash(heading.textContent))).toEqual([
      "Self-host Hivra",
      "Hivra Cloud",
      "Hivra Cloud, more room",
      "Already rent a server?",
    ]);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Home/Pricing");
  });

  it("shows self-hosting plus the two sizes checkout sells, priced and sized from the plans", async () => {
    await renderPricing();

    expect(HOSTED_SIZES.map((size) => size.planKey)).toEqual(["operator", "fleet"]);
    const selfHost = screen.getByRole("article", { name: "Self-host Hivra" });
    expect(selfHost).toHaveTextContent("$0 for the software");
    expect(selfHost).toHaveTextContent("Your server · Your control");
    expect(selfHost).toHaveTextContent("Included:Open-source platform, the self-host guide, control over your server.");
    expect(selfHost).toHaveTextContent("Not included:A server, managed maintenance, AI usage or Hivra Cloud-only agent options.");

    const names = ["Hivra Cloud", "Hivra Cloud, more room"];
    HOSTED_SIZES.forEach((size, index) => {
      const plan = PLANS[size.planKey];
      expect(size.price).toBe(`$${(plan.price / 100).toFixed(2)}`);
      const card = screen.getByRole("article", { name: names[index] });
      // The price and its size sit together, so a larger price is never read without its size.
      expect(card).toHaveTextContent(`${size.price}/month`);
      expect(card).toHaveTextContent(`${plan.totalCpu} vCPU and ${plan.totalRam / 1024} GB RAM`);
      // A button that names a paid plan carries that plan into checkout.
      const cta = within(card).getByRole("link", { name: `Choose ${plan.totalCpu} vCPU and ${plan.totalRam / 1024} GB` });
      expect(cta).toHaveAttribute("href", `/get-started?plan=${size.planKey}`);
    });
  });

  it("keeps the pool sentence and describes no plan by checkout's or the ladder's names", async () => {
    const { container } = await renderPricing();
    const main = container.querySelector("main") as HTMLElement;

    expect(
      screen.getByText("Each plan is a pool of CPU and memory for your agents' computers, and each size also sets how many agents can run at once."),
    ).toBeInTheDocument();
    // The copy rules keep agent counts off the public pages, so the limit is named without a number.
    expect(main.textContent).not.toMatch(/\b\d+ (?:active )?agents\b/);
    expect(main.textContent).not.toMatch(/\b(?:Starter|Power|Studio|Max)\b/);
    expect(main.textContent).not.toMatch(/\bPro\b/);
    for (const machine of HOSTED_MACHINES) {
      expect(screen.queryByRole("article", { name: new RegExp(`^${machine.name}$`) })).not.toBeInTheDocument();
    }
    // The proposed ladder is no longer referred to from this page's own copy (the site header keeps its nav link).
    expect(main.querySelector('a[href="/#pricing"]')).toBeNull();
  });

  it("maps every call to action to the real destination", async () => {
    const { container } = await renderPricing();

    expect(PRICING_ACTIONS.connectServer.href).toBe("/sign-up");
    const connect = screen.getByRole("link", { name: "Connect your server" });
    expect(connect).toHaveAttribute("href", "/sign-up");

    const source = screen.getByRole("link", { name: "View the source and setup instructions" });
    expect(source).toHaveAttribute("href", SELF_HOST_SOURCE_URL);
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");

    const launch = screen.getByRole("link", { name: "Launch on Hivra Cloud" });
    expect(launch).toHaveAttribute("href", HOSTED_SIZES[0].href);
    const github = screen.getByRole("link", { name: "Self-host from GitHub" });
    expect(github).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
    expect(github).toHaveAttribute("target", "_blank");
    expect(github).toHaveAttribute("rel", "noopener noreferrer");

    expect(screen.getByRole("link", { name: "individual setup pages" })).toHaveAttribute("href", "/agents");
    expect(screen.getByRole("link", { name: "info@hivra.cloud" })).toHaveAttribute("href", "mailto:info@hivra.cloud");
    const termsLinks = (container.querySelector("main") as HTMLElement).querySelectorAll("a[href='/terms']");
    // The guarantee, the question about stopping payment and the question about being unhappy.
    expect([...termsLinks].map((link) => link.textContent)).toEqual(["terms", "terms", "terms"]);
  });

  // The proposed ladder's perks (snapshots and clones, two months free, unlimited
  // computers, Windows) are not shipped and are never repeated on this indexed page.
  it("makes no banned claim in the page, metadata or JSON-LD, and repeats none of the preview ladder", async () => {
    const { container } = await renderPricing();
    const text = pageAndStructuredText(container);

    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/two months free|unlimited|snapshot|free trial|no card|hosted free/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  // The /features and /compare scanner is stricter about money-back wording and speed claims. One narrow
  // exemption: a table cell that holds only a price, whose size sits in the cell beside it.
  it("passes the public-claims scanner, except a price alone in a table cell", async () => {
    const { container } = await renderPricing();
    const copy = renderedCopy(container);
    const offenders: string[] = [];
    for (const block of copy) {
      for (const sentence of sentences(block)) {
        for (const [name, pattern] of BANNED_PUBLIC_CLAIMS) {
          if (!pattern.test(sentence)) continue;
          const isPriceCell = name.startsWith("$19.99") && /^\$\d+\.\d\d(?:\/month)?$/.test(sentence);
          if (!isPriceCell) offenders.push(`${name}: ${sentence.slice(0, 140)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("promises a computer that stays on only in the approved words", async () => {
    const { container } = await renderPricing();
    const text = (container.querySelector("main") as HTMLElement).textContent ?? "";

    const approved = "A paid Hivra Cloud computer stays on and is not paused for inactivity.";
    // The Hivra Cloud card and the question about turning the computer off.
    expect(text.split(approved).length - 1).toBe(2);
    expect(text).not.toMatch(/isn't paused simply because|let tasks continue/i);
    expect(text).not.toMatch(/never sleeps|always on|24\/7/i);

    // The only sentence the keep-running scanner matches is the page's own hedge, which says it is NOT automatic.
    const flagged = renderedCopy(container).flatMap((block) => unqualifiedKeepRunningClaims(block));
    expect(flagged).toEqual([
      "That doesn't mean every agent task will continue automatically: a command or process must itself be set up to keep running, and external services can still fail or time out.",
    ]);
  });

  it("says the plan has no AI usage, in the approved words, and keeps provider terms on the sign-in promises", async () => {
    const { container } = await renderPricing();
    const text = (container.querySelector("main") as HTMLElement).textContent ?? "";
    const approved =
      "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.";

    expect(text.split(approved).length - 1).toBe(2);
    expect(text).toContain("Support signing in with your own provider account, subject to the provider's terms.");
    expect(text).toContain("whether you sign in with your own account (where the agent supports it, subject to the provider's terms) or use an API key.");
    expect(text).toContain("Whether a particular subscription supports the use you intend is governed by that provider's terms.");
    expect(text).not.toMatch(/\bmodel (?:key|usage|provider|API key)\b/i);
    expect(text).not.toMatch(/Your AI company bills you/);
    expect(text).not.toMatch(/sponsored|endorsed|partner of|official/i);
  });

  it("states the agent requirements the repo already states", async () => {
    const { container } = await renderPricing();
    const rows = [...container.querySelectorAll("li")].map((item) => squash(item.textContent));

    expect(rows).toContain("Claude Code and Codex: Support signing in with your own provider account, subject to the provider's terms.");
    // Owner decision, 21 October 2026: Hivra runs no free computer. No agent is singled out as the paid one
    // (the list used to say "OpenClaw and Agent Zero: Require a paid Hivra Cloud size", so the rest read as free).
    expect(rows).toContain(
      "On Hivra Cloud: Every Hivra Cloud computer needs a paid plan, whichever agent you run on it. Hermes runs on Hivra Cloud only.",
    );
    expect(rows).toContain("On your own computer or server: A free account works with a computer or server you connect yourself.");
    expect(rows.filter((row) => /paid size|Require a paid|OpenClaw and Agent Zero/.test(row))).toEqual([]);
    expect(rows).toContain("Other supported agents: Check their individual setup pages for any account, key or deployment requirements.");
    // No OS is named: Windows and Omarchy are only available with qualifiers this page does not carry.
    expect((container.querySelector("main") as HTMLElement).textContent).not.toMatch(/\b(?:Windows|Omarchy|Ubuntu)\b/);
  });

  it("states the guarantee in the shared words, linked to the terms", async () => {
    const { container } = await renderPricing();
    const text = container.textContent ?? "";

    expect(text).toContain(`Hivra Cloud comes with a ${MONEY_BACK_GUARANTEE}. The full conditions are in the terms.`);
    expect(text).toContain(`Check the terms for the ${MONEY_BACK_GUARANTEE}.`);
    expect(text).not.toMatch(/seven-day|eligible purchases|at checkout/i);
    expect(text).not.toMatch(/annual|yearly|per year|\$79|\$149/i);
    // The repo rule keeps "eligible" off the page: neither the refund nor the provider-account sentences use it.
    expect(text).not.toMatch(/eligible/i);
  });

  it("never shows the md's editor notes, placeholders or implementer directions", async () => {
    const { container } = await renderPricing();
    const text = pageAndStructuredText(container);

    expect(text).not.toMatch(/site export|Prices shown are|Prepublication|Publication checks|Check the live checkout/i);
    expect(text).not.toMatch(/\[[A-Za-z][^\]]*\]/);
    expect(text).not.toMatch(/\b(?:TODO|lorem ipsum)\b/i);
    // The generated line is the one that stays.
    expect(screen.getByText(/^Prices as of/)).toBeInTheDocument();
  });

  it("leaves the unshipped sizes out and says only that they are planned", async () => {
    const { container } = await renderPricing();

    expect(container.textContent).toContain("Larger cloud sizes are planned, but we won't list them here as if they're available until you can actually choose them.");
    expect(container.textContent).not.toMatch(/8 vCPU|12 vCPU|16 GB|32 GB|\$49|\$99/);
  });
});

describe("/pricing questions", () => {
  it("shows every question except the token one, and marks up exactly what it shows", async () => {
    const { container } = await renderPricing(SWITCH_OFF);

    const shown = PRICING_FAQ.filter((item) => !item.tokenOnly);
    expect(shown.length).toBe(10);
    const details = [...container.querySelectorAll("details")];
    expect(details.map((item) => item.querySelector("summary")?.firstChild?.textContent)).toEqual(shown.map(({ q }) => q));
    for (const { q } of shown) expect(screen.getByText(q)).toBeInTheDocument();

    const faq = faqGraph(container);
    expect(faq.mainEntity.map((entry) => entry.name)).toEqual(shown.map(({ q }) => q));
    // The JSON-LD answer is the visible answer, word for word.
    details.forEach((item, index) => {
      expect(squash(item.querySelector("p")?.textContent)).toBe(squash(faq.mainEntity[index].acceptedAnswer.text));
    });
    for (const item of details) expect(item).toHaveAttribute("open");
  });

  it("holds the token question, its ticker and its link back, in the page, links and JSON-LD, while the switch is off", async () => {
    const { container } = await renderPricing(SWITCH_OFF);
    const text = pageAndStructuredText(container);

    expect(screen.queryByText("Do I need to buy $HIVRA?")).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/token"]')).toBeNull();
    expect(text).not.toMatch(/\$HIVRA|\$HermesOS|token information|token ecosystem|airdrop|snapshot|litepaper|tokenomics|launchpad|Bankr/i);
    // The intro's negation says "a token", never the ticker.
    expect(container.textContent).toContain("No requirement to buy a token.");
    // Batch decision 6: the md's "No confusing AI credit bundle" is dropped, as Hivra credits are offered.
    expect(container.textContent).not.toMatch(/credit bundle/i);
  });

  it("shows the token question and its link when the surfaces are on and the viewer is not blocked", async () => {
    const { container } = await renderPricing(SWITCH_ON);

    expect(screen.getByText("Do I need to buy $HIVRA?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "token information" })).toHaveAttribute("href", "/token");
    const faq = faqGraph(container);
    expect(faq.mainEntity).toHaveLength(PRICING_FAQ.length);
    expect(faq.mainEntity.map((entry) => entry.name)).toContain("Do I need to buy $HIVRA?");
    const details = [...container.querySelectorAll("details")];
    expect(details).toHaveLength(PRICING_FAQ.length);
    details.forEach((item, index) => {
      expect(squash(item.querySelector("p")?.textContent)).toBe(squash(faq.mainEntity[index].acceptedAnswer.text));
    });
    // The offer data never carries a token.
    expect(JSON.stringify(JSON.parse(jsonLd(container))["@graph"][1])).not.toMatch(/\$HIVRA|\btoken\b/i);
  });

  it("hides the token question from a geo-blocked viewer even with the switch on", async () => {
    const { container } = await renderPricing(GEO_BLOCKED);

    expect(screen.queryByText("Do I need to buy $HIVRA?")).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/token"]')).toBeNull();
    expect(faqGraph(container).mainEntity).toHaveLength(PRICING_FAQ.length - 1);
    expect(pageAndStructuredText(container)).not.toMatch(/\$HIVRA/);
  });

  it("wraps every link in words that are in the answer exactly once, so the text never changes", () => {
    for (const item of PRICING_FAQ) {
      for (const link of item.links ?? []) {
        expect(item.a.split(link.text).length - 1).toBe(1);
      }
      expect(item.a).not.toMatch(/[\u2013\u2014]/);
    }
  });

  // Owner decision, 21 October 2026: "I'm not giving away free computers anymore." The page says in the canonical
  // words that every computer Hivra Cloud runs is paid and that a free account works with your own computer or server.
  it("states the paid-computer rule in the canonical words under the headline, in the first question and in a question of its own", async () => {
    const { container } = await renderPricing();
    const rule =
      "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.";
    expect(HOSTED_COMPUTE_NEEDS_PLAN).toBe(rule);
    // Under the headline, built from the plan constants.
    const masthead = container.querySelector("main header") as HTMLElement;
    expect(masthead).toHaveTextContent(rule);
    expect(PRICING_INTRO).toContain(rule);
    expect(rule).toContain(`from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}.`);

    const free = PRICING_FAQ.find(({ q }) => q === "Is Hivra free?");
    expect(free?.a).toBe(
      "The open-source platform is free to self-host, and a free Hivra account works with a computer or server you connect yourself. That doesn't make the physical or cloud server free, and your AI usage still has a cost. A computer that Hivra runs for you is paid, from $9.99 a month for 2 vCPU and 4 GB of RAM.",
    );
    const freeComputer = PRICING_FAQ.find(({ q }) => q === "Does Hivra run a free computer for me?");
    expect(freeComputer?.a).toBe(
      "No. Every computer that Hivra Cloud runs for you needs a paid plan. A free account works with a computer or server that you connect yourself, and you can self-host the open-source platform at no software cost.",
    );
    // It sits right after "Is Hivra free?" and is marked up for search with its visible answer.
    expect(PRICING_FAQ.map(({ q }) => q).slice(0, 2)).toEqual(["Is Hivra free?", "Does Hivra run a free computer for me?"]);
    expect(faqGraph(container).mainEntity.find((entry) => entry.name === "Does Hivra run a free computer for me?")?.acceptedAnswer.text).toBe(
      freeComputer?.a,
    );
    // The server-connect panel tells a free account it is enough, and that Hivra runs nothing for it.
    expect(PRICING_OPTIONS.ownServer.body).toBe(
      "You can also connect infrastructure you pay for to Hivra, where supported. A free account is enough for that. Hivra does not run a computer for you on a free account, and your server bill stays with your own provider.",
    );
  });

  // Owner decision, 21 October 2026: a computer Hivra Cloud runs stops when its plan stops being paid. The page says
  // so in the same terms as /terms, with the hours taken from the billing constant, and does not call the computer
  // "always on" without saying when it is not.
  it("says what happens when payment stops, with the grace hours from billing, and links the terms", async () => {
    const { container } = await renderPricing();

    const stop = PRICING_FAQ.find(({ q }) => q === "What happens if I stop paying?");
    expect(stop?.a).toBe(
      `Except for Hermes agents, which follow an older process set out in the terms, a computer that Hivra Cloud runs for you runs only while its plan is paid. If a card payment fails, we retry the card and keep the computer running for up to ${PAYMENT_GRACE_HOURS} hours after the first failed payment. If it is still unpaid then, or when a cancelled plan ends, we stop the computer. A stopped computer keeps its files for a limited time, so you can start it again once you have a paid plan.`,
    );
    // The Hermes exception comes first, as in the terms, so a Hermes customer is not told the 48 hours is theirs.
    expect(stop?.a.startsWith("Except for Hermes agents")).toBe(true);
    expect(PAYMENT_GRACE_HOURS).toBe(48);
    expect(stop?.a).toContain("up to 48 hours after the first failed payment");
    expect(stop?.links).toEqual([{ text: "terms", href: "/terms" }]);
    // Nothing is promised about deletion here: that is for the terms.
    expect(stop?.a).not.toMatch(/delet|free of charge|for free/i);
    expect(faqGraph(container).mainEntity.find((entry) => entry.name === "What happens if I stop paying?")?.acceptedAnswer.text).toBe(stop?.a);

    const off = PRICING_FAQ.find(({ q }) => q === "Will Hivra turn my computer off when I'm not using it?");
    expect(off?.a).toContain("A paid Hivra Cloud computer stays on and is not paused for inactivity. It is stopped if the plan behind it stops being paid.");
  });

  it("answers in the site's own words: AI usage, an automatic migration, no one-click claim", () => {
    const answers = PRICING_FAQ.map(({ a }) => a).join("\n");
    expect(answers).toContain("isn't a promise of an automatic migration");
    expect(answers).not.toMatch(/one-click/i);
    expect(PRICING_OPTIONS.entry.meta).toBe("2 vCPU and 4 GB RAM");
  });
});

describe("/pricing token-free chrome", () => {
  it("passes the geo decision to the header and footer, so a blocked viewer sees no token link there either", async () => {
    const hidden = await renderPricing(GEO_BLOCKED);
    expect(hidden.container.querySelector('a[href="/token"], a[href="/tokenomics"]')).toBeNull();
    hidden.unmount();
    const off = await renderPricing(SWITCH_OFF);
    expect(off.container.querySelector('a[href="/token"], a[href="/tokenomics"]')).toBeNull();
  });
});

// /pricing used to wrap itself in <LocaleProvider initialLocale="en">, whose
// mount effect wrote "en" into the visitor's locale cookie and localStorage,
// silently switching a German visitor's whole site (homepage and dashboard)
// to English. The page must render English without touching either.
describe("locale preference", () => {
  function clearLocale() {
    document.cookie = `${LOCALE_COOKIE_NAME}=; Max-Age=0; Path=/`;
    window.localStorage.removeItem(LOCALE_COOKIE_NAME);
  }
  beforeEach(clearLocale);
  afterEach(clearLocale);

  it("leaves a visitor's chosen language in place and still renders the English questions", async () => {
    document.cookie = `${LOCALE_COOKIE_NAME}=de; Path=/`;
    window.localStorage.setItem(LOCALE_COOKIE_NAME, "de");

    await renderPricing();

    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=de`);
    expect(document.cookie).not.toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(window.localStorage.getItem(LOCALE_COOKIE_NAME)).toBe("de");
    expect(screen.getByText(PRICING_FAQ[0].q)).toBeInTheDocument();
  });

  it("does not write a locale cookie or localStorage entry for a first-time visitor", async () => {
    await renderPricing();

    expect(document.cookie).not.toContain(`${LOCALE_COOKIE_NAME}=`);
    expect(window.localStorage.getItem(LOCALE_COOKIE_NAME)).toBeNull();
  });
});
