/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import { SUPPORT_EMAIL } from "@/lib/support-channels";
import { findBannedClaims as findPublicClaims, renderedCopy } from "../../features/__tests__/public-claims";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// The page resolves the token surfaces once per render. Each case sets the view it wants.
const mockGetTokenSurfaceView = jest.fn();
jest.mock("@/lib/compliance/token-surface-view", () => ({
  getTokenSurfaceView: (...args: unknown[]) => mockGetTokenSurfaceView(...args),
}));

import { PAYMENT_GRACE_HOURS } from "@/lib/subscription/plans";
import TermsPage, { metadata } from "../page";

const SWITCH_OFF = { tokenSurfaces: false, geoBlocked: false };
const SHOWN = { tokenSurfaces: true, geoBlocked: false };
const BLOCKED = { tokenSurfaces: true, geoBlocked: true };

async function renderTerms(view = SWITCH_OFF) {
  mockGetTokenSurfaceView.mockResolvedValue(view);
  return render(await TermsPage());
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The document itself: the site header and footer around it are other pages' copy. */
function documentElement(container: HTMLElement): HTMLElement {
  const main = container.querySelector("main");
  expect(main).not.toBeNull();
  return main as HTMLElement;
}

/** Headings, paragraphs and list items of the document itself, in order. */
function documentBlocks(container: HTMLElement): string[] {
  return Array.from(documentElement(container).querySelectorAll("h1, h2, p, li")).map((element) => squash(element.textContent ?? ""));
}

const BILLING_OPENING = (tokenAccess: string) =>
  "Hivra offers a free account that any user may use without selecting a paid plan, subject to fair-use limits and anti-abuse checks. " +
  "A free account does not include a computer that Hivra Cloud runs for you; it works with a computer or server you connect yourself. " +
  `Every computer that Hivra Cloud runs for you needs a paid plan${tokenAccess}. ` +
  "Paid tiers (Pro, Power) are billed for the tier and billing period you choose when you subscribe. " +
  "Card payments and card verification are processed securely via Stripe. " +
  "Hivra credits, where offered, pay for AI model usage through Hivra. They are separate from your plan, which does not include AI usage.";

const REFUND_ITEM =
  "Refund Policy: We set up a dedicated computer for you when you start, and that cost cannot be recovered. We still offer a 7-day money-back guarantee on card payments, counted from your first paid subscription charge.";
const FAILED_PAYMENT_ITEM =
  "Failed Payments and Cancellation: Except for Hermes agents, which the next item covers, a computer that Hivra Cloud runs for you runs only while its plan is paid. If a card payment fails, we retry the card and keep your computer running for up to " + PAYMENT_GRACE_HOURS + " hours after the first failed payment. If the payment has still not gone through by then, or when a cancelled plan ends, we stop your computer. We keep its files for a limited time, so that you can start it again once payment resumes, and we email you before we delete anything. If you still have another paid plan with us, your computer keeps running under that plan.";
const HERMES_ITEM =
  "Hermes Agents: Hermes agents (the agents you launch as Hermes) follow an older process. If a payment fails or you cancel, we mark your Hermes agents as suspended straight away, unless you still have another paid plan with us. We may then switch them off, and we delete a suspended Hermes agent only after a warning period, with emails beforehand. The length of that period depends on your account.";
const PLAN_CHANGES_ITEM =
  "Plan Changes: Due to the nature of our dedicated infrastructure provisioning, you may upgrade your plan at any time, but moving to a smaller size is not always possible in place. If the billing page does not offer it, email info@hivra.cloud for help, or cancel your current subscription and subscribe again. What happens to your computer when you cancel is described above.";

// The supplied draft (batches/b06/04-terms.md) in page order, with the edits to sections 2 and 4 listed in
// docs/legal-copy-changes.md. Spellings are British (Behaviour, behaviour); every other word is
// the draft's. A legal text changes only with the solicitor's say-so, so this list is the lock: edit it together
// with the page.
const EXPECTED_TERMS = (tokenAccess: string): string[] => [
  "Terms of Service",
  "These terms describe the conditions for using Hivra, including its hosted AI agent environments and related services. Please read them before creating an account, subscribing or deploying an agent.",
  "If you have questions about the terms, contact info@hivra.cloud.",
  "Last Updated: May 2, 2026",
  "1. Acceptance of Terms",
  "By accessing or using Hivra, you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you do not have permission to access the Service.",
  "2. Description of Service",
  "Hivra provides computers for AI agents, and for you to work with them. You can run them on Hivra Cloud, on a computer or server you connect yourself, or by self-hosting the open-source platform. On Hivra Cloud the service includes setting up the computer, keeping its files and settings, and giving you a way to open it and work with your agents.",
  "3. Your Responsibilities",
  "API Usage: You are responsible for all usage and billing related to the third-party API keys (e.g., OpenRouter, OpenAI, Anthropic) you provide to your agents.",
  "Agent Behaviour: You assume full liability for the actions, automated operations, and internet browsing conducted by your agents. You agree not to use agents for illegal activities, mass spamming, denial of service attacks, or any malicious behaviour.",
  "Security: You are responsible for safeguarding your account access credentials and provided API keys.",
  "4. Subscription and Billing",
  BILLING_OPENING(tokenAccess),
  REFUND_ITEM,
  FAILED_PAYMENT_ITEM,
  HERMES_ITEM,
  PLAN_CHANGES_ITEM,
  "5. Limitation of Liability",
  "In no event shall Hivra, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Service.",
];

const TOKEN_ACCESS = " or a qualifying token-based access path";

describe("/terms", () => {
  it("keeps its title, description and canonical (the supplied draft gives none)", () => {
    expect(metadata.title).toBe("Terms of Service");
    expect(metadata.description).toBe("The terms that govern your use of Hivra.");
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/terms");
    expect(metadata.openGraph?.title).toBe("Terms of Service");
    // The root layout appends " | Hivra", so the title must not carry it.
    expect(String(metadata.title)).not.toMatch(/\| Hivra$/);
  });

  it("has one h1 and the five sections in order", async () => {
    const { container } = await renderTerms();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Terms of Service");
    // The site footer carries its own h2 headings; the document's are the ones in <main>.
    expect(within(documentElement(container)).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "1. Acceptance of Terms",
      "2. Description of Service",
      "3. Your Responsibilities",
      "4. Subscription and Billing",
      "5. Limitation of Liability",
    ]);
  });

  it("is the supplied draft, word for word, with the token-access words hidden while the surfaces are off", async () => {
    const { container } = await renderTerms(SWITCH_OFF);
    expect(documentBlocks(container)).toEqual(EXPECTED_TERMS(""));
  });

  it("shows the token-access words only while the surfaces are on and the viewer is not blocked", async () => {
    const shown = await renderTerms(SHOWN);
    expect(documentBlocks(shown.container)).toEqual(EXPECTED_TERMS(TOKEN_ACCESS));
    shown.unmount();

    const blocked = await renderTerms(BLOCKED);
    expect(documentBlocks(blocked.container)).toEqual(EXPECTED_TERMS(""));
  });

  it("sets the four labelled policies in section 4 as a list under the opening paragraph, like the items in section 3", async () => {
    const { container } = await renderTerms();
    const billing = documentElement(container).querySelector("section#billing") as HTMLElement;
    expect(billing.querySelectorAll(":scope > p")).toHaveLength(1);
    const rows = Array.from(billing.querySelectorAll(":scope > ul > li")).map((row) => squash(row.textContent ?? ""));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^Refund Policy: We set up/);
    expect(rows[1]).toMatch(/^Failed Payments and Cancellation: Except for Hermes agents/);
    expect(rows[2]).toMatch(/^Hermes Agents: Hermes agents \(the agents you launch as Hermes\)/);
    expect(rows[3]).toMatch(/^Plan Changes: Due to the nature/);
  });

  it("names no token anywhere while the surfaces are off, in the page text or the metadata", async () => {
    const { container } = await renderTerms(SWITCH_OFF);
    const everything = `${documentElement(container).textContent} ${JSON.stringify(metadata)}`;
    expect(everything).not.toMatch(/token|\$HIVRA|\$HermesOS|airdrop|snapshot|litepaper|tokenomics|launchpad|Bankr|Sablier|migration/i);
  });

  it("carries the date exactly as supplied", async () => {
    const { container } = await renderTerms();
    expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-05-02");
    expect(documentBlocks(container)).toContain("Last Updated: May 2, 2026");
    // A legal date is never read from the clock (static-copy-safety.test.ts checks the source too).
    const source = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).not.toMatch(/new Date\(|toLocaleDateString|Date\.now/);
  });

  it("links the contact address as a mailto, in bold as the draft has it, and it is the live inbox", async () => {
    const { container } = await renderTerms();
    const link = within(container.querySelector("main")!).getByRole("link", { name: "info@hivra.cloud" });
    expect(link).toHaveAttribute("href", "mailto:info@hivra.cloud");
    expect(link.closest("strong")).not.toBeNull();
    expect(SUPPORT_EMAIL).toBe("info@hivra.cloud");
  });

  it("lists the sections in a contents navigation outside <main>, each entry reaching its section", async () => {
    const { container } = await renderTerms();
    const nav = screen.getByRole("navigation", { name: "Contents" });
    const main = container.querySelector("main")!;
    expect(main.contains(nav)).toBe(false);
    const headings = Array.from(main.querySelectorAll("h2"));
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(headings.map((heading) => heading.textContent));
    for (const [index, link] of links.entries()) {
      const target = main.querySelector(link.getAttribute("href")!);
      expect(target).not.toBeNull();
      expect(target).toBe(headings[index].closest("section"));
    }
  });

  it("keeps the contractual tier names Pro and Power, says billing periods are chosen, and limits the refund to card payments", async () => {
    const { container } = await renderTerms();
    const text = documentElement(container).textContent ?? "";
    // Decision L1: contractual tier names stay in the Terms; the marketing rule against plan names does not apply here.
    expect(text).toContain("Paid tiers (Pro, Power) are billed for the tier and billing period you choose when you subscribe");
    // Billing is not monthly only (yearly, token and Apple plans exist), and no annual price is stated.
    expect(text).not.toMatch(/monthly subscription basis|yearly|per year|annual/i);
    // Every other page says "on card payments" (MONEY_BACK_GUARANTEE in lib/blog/plan-facts.ts); so does this one.
    expect(text).toContain("We still offer a 7-day money-back guarantee on card payments, counted from your first paid subscription charge.");
    expect(text).not.toMatch(/seven-day|eligible|at checkout/i);
    // The refund sentence no longer reasons backwards from the cost, and is about every computer, not only Hermes agents.
    expect(text).not.toMatch(/Therefore, we offer|for each Hermes agent/);
    // No claim route is promised in the Terms (no code handles refund requests).
    expect(text).not.toMatch(/email us to claim|to claim (?:a|your) refund/i);
  });

  it("describes a free account as having no Hivra Cloud computer, and keeps no promise that older free computers stay", async () => {
    const { container } = await renderTerms();
    const text = documentElement(container).textContent ?? "";
    expect(text).toContain("A free account does not include a computer that Hivra Cloud runs for you; it works with a computer or server you connect yourself.");
    expect(text).toContain("Every computer that Hivra Cloud runs for you needs a paid plan");
    expect(text).not.toMatch(/Free-tier computers|remain available|created before this change/i);
  });

  it("describes the service without a production-grade or fully managed claim", async () => {
    const { container } = await renderTerms();
    const text = documentElement(container).textContent ?? "";
    expect(text).not.toMatch(/production-grade|fully managed|persisting memory/i);
    expect(text).toContain("Hivra provides computers for AI agents, and for you to work with them.");
  });

  it("states the failed payment and cancellation rule for Hivra Cloud computers, and the older rule for Hermes agents, as two separate items", async () => {
    const { container } = await renderTerms();
    const billing = documentElement(container).querySelector("section#billing") as HTMLElement;
    const rows = Array.from(billing.querySelectorAll(":scope > ul > li")).map((row) => squash(row.textContent ?? ""));
    const failed = rows[1];
    const hermes = rows[2];
    // The one number is the 48 hour window after the first failed payment, and only in the Hivra Cloud item.
    expect(PAYMENT_GRACE_HOURS).toBe(48);
    expect(failed).toContain("keep your computer running for up to 48 hours after the first failed payment");
    expect(failed).toContain("or when a cancelled plan ends, we stop your computer");
    expect(failed).toContain("we email you before we delete anything");
    expect(failed).toContain("If you still have another paid plan with us, your computer keeps running under that plan.");
    expect(hermes).not.toMatch(/48/);
    expect(hermes).toContain("we mark your Hermes agents as suspended straight away, unless you still have another paid plan with us");
    expect(hermes).toContain("we delete a suspended Hermes agent only after a warning period, with emails beforehand");
    // The old sentence that told customers a lapsed computer keeps running is gone.
    const text = documentElement(container).textContent ?? "";
    expect(text).not.toMatch(/not currently suspended automatically|do not rely on a computer continuing to run/i);
    expect(text).not.toMatch(/grace period before|secure deletion|retained for a/i);
    // The plan changes item no longer promises a deletion that no code carries out, and does not depend on a switch.
    expect(text).not.toMatch(/result in the deletion of your current/i);
    expect(text).not.toMatch(/cannot be downgraded|Upgrade-Only/i);
    expect(text).not.toMatch(/(?:Hivra computers?|computers run by Hivra) (?:is|are|will be) (?:deleted|retained|kept)/i);
  });

  it("makes no banned public claim", async () => {
    const { container } = await renderTerms();
    const text = documentElement(container).textContent ?? "";
    expect(findBannedClaims(text)).toEqual([]);
    expect(findPublicClaims("terms", renderedCopy(documentElement(container)))).toEqual([]);
  });

  it("has no dash, placeholder, editor note, American spelling or invented legal identity", async () => {
    const { container } = await renderTerms();
    const text = documentElement(container).textContent ?? "";
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/[\[\]]|\bTODO\b|lorem ipsum/i);
    expect(text).not.toMatch(/Route:|Status:|Editorial redraft|not approved legal advice|Publication checks|not website copy|solicitor/i);
    expect(text).not.toMatch(/\b(behavior|authorized|anonymized|minimize|organization|license|center)\b/i);
    // Decision L2: no entity, address, registration or governing law is invented.
    expect(text).not.toMatch(/\b(Ltd|Limited|LLC|LLP|plc|Inc\.?|GmbH|Corp\.?|VAT)\b/);
    expect(text).not.toMatch(/registered (office|company|in)|company number|governing law|jurisdiction|\b(Street|Road|Avenue|PO Box)\b/i);
    // The plan names marketing pages use are not introduced.
    expect(text).not.toMatch(/Starter|Studio|\bMax\b|Hivra Pro|Hivra Power/);
  });
});
