/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import { SUPPORT_EMAIL } from "@/lib/support-channels";
import { OPEN_COOKIE_PREFERENCES_EVENT } from "@/components/consent/CookieConsentBanner";
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

import PrivacyPage, { metadata } from "../page";

const SWITCH_OFF = { tokenSurfaces: false, geoBlocked: false };
const SHOWN = { tokenSurfaces: true, geoBlocked: false };
const BLOCKED = { tokenSurfaces: true, geoBlocked: true };

async function renderPrivacy(view = SWITCH_OFF) {
  mockGetTokenSurfaceView.mockResolvedValue(view);
  return render(await PrivacyPage());
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

// The draft's own line, word for word. It shows only while the token surfaces are on and the viewer is not blocked.
const MANAGED_PARTNERS_AS_SUPPLIED =
  "Managed inference and wallet partners: if you opt into managed AI inference or token and wallet features, Venice (inference) and Bankr (wallet and on-chain payments) process the data needed for those features.";
// What every other viewer reads: the same line without the token words and the on-chain payments words. Venice
// (inference) and Bankr (wallet) are live processors, so both are named for everyone.
const MANAGED_PARTNERS_NEUTRAL =
  "Managed inference and wallet partners: if you opt into managed AI inference or wallet features, Venice (inference) and Bankr (wallet) process the data needed for those features.";

// Lines that are NOT in the supplied draft (docs/legal-copy-changes.md has the code evidence for each). Each names
// a recipient the code sends personal data to; the introduction describes the main service providers.
const ADDED_PROVIDERS = [
  "Resend: email delivery for account notices and product updates; it receives your name and email address.",
  "proxycheck.io: IP address reputation checks, used only for fraud and abuse prevention.",
  "Services you connect: if you connect a Telegram bot, your Hetzner account or apps through Composio, we hold the token or key you give us so your agents can act for you, and those services handle your data under their own terms.",
];
const ADDED_BLOCKCHAIN_PROVIDERS =
  "Blockchain data providers: if you use wallet or on-chain payment features, wallet addresses and transaction hashes are sent to providers of public Base network data so that we can read the chain.";

// The supplied draft (batches/b06/05-privacy.md) in page order, with the edits listed in docs/legal-copy-changes.md:
// the introduction's provider promise, the provider list, the retention rows and the security sentence. Spellings
// are British (authorised, anonymised, generalised, minimise); every other word is the draft's.
// A legal text changes only with legal review, so this list is the lock: edit it together with the page.
const EXPECTED_PRIVACY = (shown: boolean): string[] => [
  "Privacy Policy",
  "This notice explains what personal information Hivra handles, why we need it, the main service providers that process it and how you can exercise your rights.",
  "Because Hivra provides computers on which agents can run, the distinction between account and operational information and the contents of an agent's own workspace matters. This notice explains both without suggesting that cloud hosting is completely inaccessible to its operator.",
  "Last Updated: September 24, 2026",
  "1. Introduction",
  "Welcome to Hivra. We are committed to protecting your personal information and your right to privacy. Because Hivra provides you with autonomous agents that interact with external services, we take data security very seriously. Hivra is the controller of the personal data described in this policy; you can reach us using the details in the Contact section below.",
  "2. Information We Collect",
  "We collect information necessary to provide our services:",
  "Account Data: Email address and authentication data when you create an account, managed securely via Clerk.",
  "API Keys: Keys submitted to access third-party AI models (e.g., OpenRouter, OpenAI, Anthropic). These are encrypted at rest and injected directly into your agent instances at runtime.",
  "Usage Metrics: Aggregated system logs, compute usage metrics, and error reports necessary to maintain service stability and infrastructure scaling.",
  "Diagnostic Telemetry: Runtime exception reports, incident metadata, and operator-visible troubleshooting events generated when the product fails or behaves unexpectedly.",
  "Fraud & Abuse Prevention: IP address, browser/device signals, FingerprintJS request identifiers, and Stripe verification metadata when a card-on-file check is required. Stripe handles card numbers directly; we only receive limited metadata such as card fingerprint and funding type for abuse prevention.",
  "Session Replay & Product Analytics: We use product analytics and session replay tooling to understand navigation, UI friction, and bugs. Input fields are masked by the analytics provider by default, but non-input page content may be visible in replay unless specifically masked or blocked.",
  "Agent Data: Data generated by your autonomous agents runs in an isolated, per-user environment. We do not read the contents of your agents' conversations for analytics or model training; automated metering reads only aggregated usage counters such as token and session counts (see Diagnostics and Internal Access).",
  "3. How We Use Information",
  "We use your information to operate, maintain, secure, troubleshoot, and improve Hivra infrastructure, and to send you account notices and product updates. This includes preventing fraud and free-tier abuse, investigating failures, reviewing diagnostic logs and session replays, and fixing bugs that impact user experience. We do not sell your personal data. We do not use your agent's interactions or your proprietary data to train generalised AI models.",
  "4. Service Providers and Sub-processors",
  "We rely on service providers to run Hivra. The main ones are listed below, and each processes only the data needed for its function:",
  "Clerk: authentication and account management.",
  "Supabase: our application database, storing account records and the operational metadata described above (United States).",
  "Hetzner: hosting for the virtual machines that run your agents (European Union).",
  "Vercel: hosting and delivery of this dashboard (United States and global edge).",
  "Cloudflare: DNS, network routing, and secure tunneling.",
  "PostHog: product analytics and session replay (United States).",
  "Google (Google Analytics and Google Tag Manager): website traffic analytics (United States). They follow your analytics cookie choice: where the law requires consent they load only after you accept, and you can turn them off at any time.",
  "Stripe: payment processing; Stripe handles card numbers directly and we receive only limited metadata.",
  "FingerprintJS: device signals used only for fraud and abuse prevention.",
  shown ? MANAGED_PARTNERS_AS_SUPPLIED : MANAGED_PARTNERS_NEUTRAL,
  "Third-party AI model providers: when you supply your own keys (for example OpenRouter, OpenAI, or Anthropic), your agents send prompts directly to those providers under their respective privacy terms.",
  ...ADDED_PROVIDERS,
  ...(shown ? [ADDED_BLOCKCHAIN_PROVIDERS] : []),
  "We do not sell your data to, or share it for advertising with, any third party.",
  "5. Diagnostics and Internal Access",
  "Automated systems and authorised operators may connect to the infrastructure that hosts your agent to read aggregated usage counters for billing and capacity planning, run health and recovery checks, and create backups. These systems are designed to collect operational metadata such as token and session counts, not the contents of your agents' conversations. Authorised operators may also review incident dashboards, error reports, and session-replay tooling solely to diagnose problems and improve reliability; we minimise the sensitive information exposed to these tools, but replay and debugging systems can still capture contextual application data needed for support. Authorised operators can also connect to the hosts that run your computers and to the computers themselves. Backups and archives of a computer can contain everything stored on it, including your files and any credentials saved there.",
  "6. International Data Transfers",
  "Our providers are located mainly in the United States and the European Union. Where personal data of UK or EU residents is transferred outside the UK or EEA (for example to United States providers such as PostHog, Vercel, Stripe, or Resend), we rely on appropriate safeguards, including the European Commission's Standard Contractual Clauses and the UK International Data Transfer Addendum, together with the providers' own compliance frameworks.",
  "7. Data Retention",
  "We keep personal data only as long as needed for the purposes above:",
  "Account and profile data: for the life of your account. When you close your account or ask us to delete it, we delete or anonymise it as part of our account-deletion process, except where we must retain it to meet legal obligations. Our team carries this out on request; it does not run on an automatic timer.",
  "Agent data and computer contents: removed when you delete the computer. If a computer's plan stays unpaid, we stop it and keep its files for a limited time, and we email you before we delete anything. Copies of its settings, operational backups and cold-storage archives can remain after the computer is deleted, and we do not currently set a fixed purge date for them. Computers that fail to set up are removed on a rolling schedule.",
  "Third-party API keys: deleted when you remove them from your vault. Keys stored with a Hivra computer are erased when that computer is deleted; keys saved in your account vault stay until you remove them or close your account.",
  "Usage and compute metrics: kept for as long as we need them for billing and capacity planning, and deleted when your account is deleted. There is no automatic deletion schedule for them yet.",
  "Diagnostic logs and error telemetry: kept for as long as we need them to investigate problems, and deleted when your account is deleted. There is no automatic deletion schedule for them yet.",
  "Agent activity and trace records: the activity history of your Hivra computers, meaning lifecycle events (such as launch, restart, resize, and deletion) and run and tool records (which tools ran, when, for how long, and whether they succeeded). These records never contain your prompts, commands, or file contents. We keep them for as long as the computer exists. When you delete a computer, its records are deleted with it; a record that the deletion happened may be kept until you close your account. When you close your account, all of them are deleted.",
  "Session replays: up to 30 days. Product-analytics events: up to 12 months.",
  "Fraud and abuse signals: kept for as long as we need them to prevent abuse, and deleted when your account is deleted. There is no automatic deletion schedule for them yet.",
  "Billing and payment records: retained as required by financial and tax law, typically up to 7 years.",
  "8. Your Privacy Rights",
  "Depending on where you live (including the UK and EU), you have the right to access, correct, delete, or export your personal data, and to restrict or object to certain processing or withdraw consent. To exercise any of these rights, contact us using the details below; we will respond within the timeframe required by applicable law. You also have the right to complain to your local data-protection authority, such as the Information Commissioner's Office (ICO) in the UK.",
  "9. Cookies, Analytics, and Session Replay",
  "We use cookies and similar technologies for essential functionality and, with your consent where the law requires it, for product analytics, website traffic analytics (Google Analytics), and session replay. Session replay masks input fields by default and is disabled on sensitive pages, including sign-in, billing, wallet, settings, and your agent chat. You can change your choice at any time: Manage cookie preferences. Strictly necessary cookies cannot be turned off. You can also control non-essential cookies through your browser settings.",
  "10. Data Security",
  "Your third-party API keys and wallet credentials are encrypted before we store them, and connections to Hivra use HTTPS. Your agent environments are isolated. While we employ rigorous security hardening to protect your data, no method of transmission over the Internet is 100% secure.",
  "11. Changes to This Policy",
  "We may update this policy as the product and our providers evolve. Material changes will be reflected by the 'Last Updated' date above, and where required we will provide additional notice.",
  "12. Contact Us",
  "If you have questions about this policy or wish to exercise your privacy rights, contact us at info@hivra.cloud or through our Discord community. For formal data-protection requests, please include enough detail for us to verify your identity and locate your records.",
];

describe("/privacy", () => {
  it("keeps its title, description and canonical (the supplied draft gives none)", () => {
    expect(metadata.title).toBe("Privacy Policy");
    expect(metadata.description).toBe("How Hivra collects, uses, and protects your data.");
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/privacy");
    expect(metadata.openGraph?.title).toBe("Privacy Policy");
    // The root layout appends " | Hivra", so the title must not carry it.
    expect(String(metadata.title)).not.toMatch(/\| Hivra$/);
  });

  it("has one h1 and the twelve sections in order", async () => {
    const { container } = await renderPrivacy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Privacy Policy");
    expect(within(documentElement(container)).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "1. Introduction",
      "2. Information We Collect",
      "3. How We Use Information",
      "4. Service Providers and Sub-processors",
      "5. Diagnostics and Internal Access",
      "6. International Data Transfers",
      "7. Data Retention",
      "8. Your Privacy Rights",
      "9. Cookies, Analytics, and Session Replay",
      "10. Data Security",
      "11. Changes to This Policy",
      "12. Contact Us",
    ]);
  });

  it("is the supplied draft with the listed legal edits and added provider lines, and the shorter managed partners line while the surfaces are off", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    expect(documentBlocks(container)).toEqual(EXPECTED_PRIVACY(false));
  });

  it("shows the draft's own managed partners line and the blockchain data providers line only while the surfaces are on and the viewer is not blocked", async () => {
    const shown = await renderPrivacy(SHOWN);
    expect(documentBlocks(shown.container)).toEqual(EXPECTED_PRIVACY(true));
    shown.unmount();

    const blocked = await renderPrivacy(BLOCKED);
    expect(documentBlocks(blocked.container)).toEqual(EXPECTED_PRIVACY(false));
  });

  it("names no token, on-chain or ticker word while the surfaces are off, in the page text or the metadata", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    const everything = `${documentElement(container).textContent} ${JSON.stringify(metadata)}`;
    expect(everything).not.toMatch(/\$HIVRA|\$HermesOS|airdrop|snapshot|litepaper|tokenomics|launchpad|Sablier|migration|on-chain|blockchain|\bBase network\b|token and wallet/i);
    // Plain mentions of metering counters and connection tokens are not token surfaces.
    expect(everything).toContain("token and session counts");
  });

  it("always discloses Venice (inference) and Bankr (wallet) as processors, because both are live", async () => {
    for (const view of [SWITCH_OFF, SHOWN, BLOCKED]) {
      const { container, unmount } = await renderPrivacy(view);
      const blocks = documentBlocks(container);
      expect(
        blocks.some(
          (block) =>
            block.startsWith("Managed inference and wallet partners:") && block.includes("Venice (inference)") && block.includes("Bankr (wallet"),
        ),
      ).toBe(true);
      unmount();
    }
  });

  it("names every provider of a public feature that the code sends personal data to, in the list and not only in the introduction", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    const items = Array.from(documentElement(container).querySelectorAll("section#service-providers li")).map((item) => squash(item.textContent ?? ""));
    for (const name of ["Resend", "proxycheck.io", "Venice (inference)", "Bankr (wallet)"]) {
      expect(items.some((item) => item.includes(name))).toBe(true);
    }
    const connected = items.find((item) => item.startsWith("Services you connect:")) ?? "";
    for (const name of ["Telegram", "Hetzner", "Composio"]) expect(connected).toContain(name);
  });

  it("holds back the providers of features that are not public yet, and no longer says information is used exclusively for infrastructure", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    const text = documentElement(container).textContent ?? "";
    // Apple, Expo, OpenAI (voice and avatars) and DigitalOcean wait for their features to be public; the wording to add is in docs/legal-copy-changes.md.
    expect(text).not.toMatch(/App Store|Expo|OpenAI \(voice|DigitalOcean/);
    expect(text).not.toMatch(/exclusively/i);
    expect(text).toContain("and to send you account notices and product updates");
  });

  it("states retention only as the code does it: no fixed periods for the records no job prunes", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    const rows = Array.from(documentElement(container).querySelectorAll("section#data-retention li")).map((row) => squash(row.textContent ?? ""));
    const text = rows.join(" ");
    // The enforced-by-nothing periods of the draft are gone.
    expect(text).not.toMatch(/within 90 days|approximately 35 days|up to 24 months|Diagnostic logs and error telemetry: up to 90 days|up to 90 days/);
    // The two periods set outside this repository (analytics provider) and by law are kept as the draft has them.
    expect(text).toContain("Session replays: up to 30 days. Product-analytics events: up to 12 months.");
    expect(text).toContain("typically up to 7 years");
  });

  it("says what happens to an unpaid computer's files, without promising an abandoned-computer clean-up or contradicting itself about purge dates", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    const rows = Array.from(documentElement(container).querySelectorAll("section#data-retention li")).map((row) => squash(row.textContent ?? ""));
    const agentData = rows.find((row) => row.startsWith("Agent data and computer contents:")) ?? "";
    expect(agentData).toContain("If a computer's plan stays unpaid, we stop it and keep its files for a limited time, and we email you before we delete anything.");
    // No code removes abandoned computers; only computers that fail to set up are purged on a schedule.
    expect(agentData).not.toMatch(/abandoned/i);
    expect(agentData).toContain("Computers that fail to set up are removed on a rolling schedule.");
    // "a limited time" is used for the stopped computer's files only, not beside "no fixed purge date" for copies.
    expect(agentData).toContain("can remain after the computer is deleted, and we do not currently set a fixed purge date for them");
  });

  it("delivers in section 5 the explanation of operator access that the introduction promises", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    const lead = documentBlocks(container).find((block) => block.includes("without suggesting that cloud hosting is completely inaccessible to its operator")) ?? "";
    expect(lead).not.toBe("");
    const diagnostics = squash(documentElement(container).querySelector("section#diagnostics-and-internal-access")?.textContent ?? "");
    expect(diagnostics).toContain("Authorised operators can also connect to the hosts that run your computers and to the computers themselves.");
    expect(diagnostics).toContain("Backups and archives of a computer can contain everything stored on it, including your files and any credentials saved there.");
  });

  it("narrows the encryption claim to API keys and wallet credentials, and keeps no blanket claim", async () => {
    const { container } = await renderPrivacy(SWITCH_OFF);
    const text = documentElement(container).textContent ?? "";
    expect(text).toContain("Your third-party API keys and wallet credentials are encrypted before we store them");
    expect(text).not.toMatch(/All sensitive data|encrypted in transit and at rest/);
  });

  it("lists the added providers after the draft's own, so the draft's order is unbroken", async () => {
    const { container } = await renderPrivacy(SHOWN);
    const items = Array.from(documentElement(container).querySelectorAll("section#service-providers li")).map((item) => squash(item.textContent ?? ""));
    const draftLast = items.findIndex((item) => item.startsWith("Third-party AI model providers:"));
    expect(draftLast).toBeGreaterThan(0);
    expect(items.slice(draftLast + 1)).toEqual([...ADDED_PROVIDERS, ADDED_BLOCKCHAIN_PROVIDERS]);
  });

  it("lays the long activity retention row out label over text, and the short rows as a schedule", async () => {
    const { container } = await renderPrivacy();
    const rows = Array.from(documentElement(container).querySelectorAll("section#data-retention li"));
    const activity = rows.find((row) => row.textContent?.startsWith("Agent activity and trace records:"));
    expect(activity).toHaveAttribute("data-stacked");
    expect(rows.filter((row) => row.hasAttribute("data-stacked"))).toHaveLength(1);
  });

  it("carries the date exactly as supplied", async () => {
    const { container } = await renderPrivacy();
    expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-09-24");
    expect(documentBlocks(container)).toContain("Last Updated: September 24, 2026");
    // A legal date is never read from the clock (static-copy-safety.test.ts checks the source too).
    const source = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).not.toMatch(/new Date\(|toLocaleDateString|Date\.now/);
  });

  it("keeps the working cookie preferences button inside section 9, and it reopens the consent banner", async () => {
    const { container } = await renderPrivacy();
    const section = documentElement(container).querySelector("section#cookies") as HTMLElement;
    const button = within(section).getByRole("button", { name: "Manage cookie preferences" });
    const opened = jest.fn();
    window.addEventListener(OPEN_COOKIE_PREFERENCES_EVENT, opened);
    fireEvent.click(button);
    window.removeEventListener(OPEN_COOKIE_PREFERENCES_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("links the contact address as a mailto, and the two cross-references to their sections", async () => {
    const { container } = await renderPrivacy();
    const main = documentElement(container);
    expect(within(main).getByRole("link", { name: "info@hivra.cloud" })).toHaveAttribute("href", "mailto:info@hivra.cloud");
    expect(SUPPORT_EMAIL).toBe("info@hivra.cloud");
    expect(within(main).getByRole("link", { name: "Contact section" })).toHaveAttribute("href", "#contact");
    expect(within(main).getByRole("link", { name: "Diagnostics and Internal Access" })).toHaveAttribute("href", "#diagnostics-and-internal-access");
    expect(main.querySelector("#contact")).not.toBeNull();
    expect(main.querySelector("#diagnostics-and-internal-access")).not.toBeNull();
    // The draft names the Discord community without a link; none is invented.
    expect(main.querySelector('a[href*="discord"]')).toBeNull();
  });

  it("bolds the two workspace terms in the introduction, as the draft does", async () => {
    const { container } = await renderPrivacy();
    const lead = Array.from(documentElement(container).querySelectorAll("p strong")).map((strong) => strong.textContent);
    expect(lead).toEqual(expect.arrayContaining(["account and operational information", "the contents of an agent's own workspace"]));
  });

  it("lists the sections in a contents navigation outside <main>, each entry reaching its section", async () => {
    const { container } = await renderPrivacy();
    const nav = screen.getByRole("navigation", { name: "Contents" });
    const main = documentElement(container);
    expect(main.contains(nav)).toBe(false);
    const headings = Array.from(main.querySelectorAll("h2"));
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(headings.map((heading) => heading.textContent));
    const ids = links.map((link) => link.getAttribute("href"));
    expect(new Set(ids).size).toBe(12);
    for (const [index, link] of links.entries()) {
      const target = main.querySelector(link.getAttribute("href")!);
      expect(target).not.toBeNull();
      expect(target).toBe(headings[index].closest("section"));
    }
  });

  it("makes no banned public claim", async () => {
    const { container } = await renderPrivacy(SHOWN);
    const text = documentElement(container).textContent ?? "";
    expect(findBannedClaims(text)).toEqual([]);
    expect(findPublicClaims("privacy", renderedCopy(documentElement(container)))).toEqual([]);
  });

  it("has no dash, placeholder, editor note, American spelling or invented legal identity", async () => {
    const { container } = await renderPrivacy(SHOWN);
    const text = documentElement(container).textContent ?? "";
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/[\[\]]|\bTODO\b|lorem ipsum/i);
    expect(text).not.toMatch(/Route:|Status:|Editorial redraft|not approved legal advice|Publication checks|not website copy|solicitor/i);
    expect(text).not.toMatch(/\b(behavior|authorized|anonymized|generalized|minimize|organization|license|center)\b/i);
    // Decision L2: no entity, registration number, address or DPO is invented.
    expect(text).not.toMatch(/\b(Ltd|Limited|LLC|LLP|plc|Inc\.?|GmbH|Corp\.?|VAT)\b/);
    expect(text).not.toMatch(/registered (office|company|in)|company number|registration number|data protection officer|\bDPO\b|\b(Street|Road|Avenue|PO Box)\b/i);
  });
});
