/** @jest-environment jsdom */
/**
 * The public token surfaces follow the $HIVRA phase from the real registry:
 * dormant (no address) renders exactly the copy from before, and a filled-in
 * launch block switches every surface to its factual launched copy.
 */
import "@testing-library/jest-dom";
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";

// The launch block the real token registry reads. Tests fill it in to change the phase.
const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({ HIVRA_TOKEN_LAUNCH: mockLaunch }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
jest.mock("next/headers", () => ({
  headers: () => {
    throw new Error("a dormant geo-policy page must not read the request");
  },
}));

import TokenVerificationPage, { generateMetadata as tokenMetadata } from "@/app/token/page";
import TokenomicsPage, { generateMetadata as tokenomicsMetadata } from "@/app/tokenomics/page";
import WhyHivraEvolutionPage from "@/app/why-hivra/evolution/page";
import { getHivraTokenPhase, type HivraTokenPhase } from "@/lib/billing/token-registry";
import { buildLlmsTxt } from "@/lib/llms-txt";
import { DORMANT_TOKENOMICS_COPY, DORMANT_TOKEN_PAGE_COPY, TOKEN_PHASE_COPY } from "@/lib/token-phase-copy";

const HIVRA_ADDRESS = "0x1111111111111111111111111111111111111111";

function setPhase(phase: HivraTokenPhase) {
  if (phase === "dormant") {
    Object.assign(mockLaunch, { contractAddress: "", poolId: "", activatesAt: "" });
  } else {
    Object.assign(mockLaunch, {
      contractAddress: HIVRA_ADDRESS,
      poolId: `0x${"ab".repeat(32)}`,
      activatesAt: phase === "scheduled" ? "2099-10-01T16:00:00Z" : "2026-01-01T00:00:00Z",
    });
  }
  expect(getHivraTokenPhase()).toBe(phase);
}

function renderPage(page: () => unknown) {
  cleanup();
  const element = page();
  expect(element).not.toBeInstanceOf(Promise);
  return render(element as React.ReactElement);
}

afterEach(() => setPhase("dormant"));

/** Matches a paragraph by its whole text, since glossary tooltips split it into spans. */
const whole = (text: string) => (_: string, element: Element | null) => element?.tagName === "P" && element.textContent === text;

describe("dormant $HIVRA: the copy from before", () => {
  const copy = TOKEN_PHASE_COPY.dormant;

  it("/token keeps its title, hero and proposals", async () => {
    setPhase("dormant");
    expect(await tokenMetadata()).toMatchObject({ title: copy.tokenPage.metadataTitle, description: copy.tokenPage.metadataDescription });
    renderPage(TokenVerificationPage);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^\$HermesOS and Hivra\.$/);
    expect(screen.getByText(DORMANT_TOKEN_PAGE_COPY.heroLead)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The proposed $HIVRA migration" })).toBeInTheDocument();
    expect(screen.getByText("The existing $HermesOS contract. $HIVRA has not launched.")).toBeInTheDocument();
    for (const paragraph of DORMANT_TOKEN_PAGE_COPY.migrationParagraphs) expect(screen.getByText(paragraph)).toBeInTheDocument();
  });

  it("/tokenomics keeps its title, header and migration paragraphs", async () => {
    setPhase("dormant");
    expect(await tokenomicsMetadata()).toMatchObject({ title: "Proposed $HIVRA tokenomics", description: DORMANT_TOKENOMICS_COPY.metadataDescription });
    renderPage(TokenomicsPage);
    expect(screen.getByText(DORMANT_TOKENOMICS_COPY.headerLead)).toBeInTheDocument();
    for (const paragraph of DORMANT_TOKENOMICS_COPY.migrationParagraphs) expect(screen.getByText(whole(paragraph))).toBeInTheDocument();
    // The old token-pricing line stays on the dormant page: only the launched copy drops it.
    expect(screen.getByText(/a year of Pro is \$49 in the token against \$79 by card/)).toBeInTheDocument();
  });

  it("/why-hivra/evolution keeps its $HIVRA lines", () => {
    setPhase("dormant");
    const { container } = renderPage(WhyHivraEvolutionPage);
    expect(screen.getByText("$HIVRA is a proposed new token on Base, to be launched through Bankr. It does not exist yet.")).toBeInTheDocument();
    for (const line of copy.evolution.hivraDetails) expect(screen.getByText(line)).toBeInTheDocument();
    expect(container.textContent).toContain("Everything about $HIVRA here is a proposal, not final terms. Check contract addresses only on the token page.");
    expect(screen.getByText("$HermesOS is the live token today. $HIVRA is the proposed next one.")).toBeInTheDocument();
  });

  it("/why-hivra/evolution markup never names Hermes Agent OS or Hermes Cloud (Nous Research's names)", () => {
    setPhase("dormant");
    const { container } = renderPage(WhyHivraEvolutionPage);
    const jsonLd = [...container.querySelectorAll('script[type="application/ld+json"]')].map(node => node.textContent ?? "");
    expect(jsonLd.length).toBeGreaterThan(0);
    for (const block of jsonLd) {
      expect(block).toContain('"HermesOS"');
      expect(block).not.toMatch(/Hermes Agent OS|Hermes Cloud/i);
    }
  });

  it("/llms.txt keeps its $HIVRA sentences", () => {
    setPhase("dormant");
    const txt = buildLlmsTxt({ siteUrl: "https://example.test" });
    expect(txt).toContain("macOS computers and custom images. $HermesOS is the live token. $HIVRA is a proposed new token and does not exist yet.\n");
    expect(txt).toContain(`(https://example.test/TOKENOMICS.md): ${copy.llmsTxt.tokenomicsNote}\n`);
  });
});

describe.each(["scheduled", "active"] as const)("%s $HIVRA", (phase) => {
  const copy = TOKEN_PHASE_COPY[phase];

  it("/token renders Ash's rewrite with the $HIVRA contract, and no old proposal copy", async () => {
    setPhase(phase);
    expect(await tokenMetadata()).toMatchObject({
      title: { absolute: "Hivra tokens | Official contracts, migration and holder access" },
      description: copy.tokenPage.metadataDescription,
      openGraph: { title: "Hivra tokens | Official contracts, migration and holder access" },
    });
    const { container } = renderPage(TokenVerificationPage);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^\$HIVRA and \$HermesOS$/);
    expect(screen.getByRole("heading", { name: "Already hold $HermesOS?" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The proposed $HIVRA migration" })).not.toBeInTheDocument();
    // No claim or swap step, and nothing that names Bankr as the launcher.
    expect(container.textContent).not.toMatch(/Bankr|active claim|ETH proceeds|claims open/);
    const hivra = within(container.querySelector('[data-token="hivra"]') as HTMLElement);
    expect(hivra.getByText(HIVRA_ADDRESS)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$HIVRA has not launched|There is no \$HIVRA contract yet|proposed \$HIVRA token/);
    expect(container.textContent).not.toMatch(/[–—]/);
  });

  it("/tokenomics renders Ash's pack page, with its head, and none of the old launched or pricing copy", async () => {
    setPhase(phase);
    expect(await tokenomicsMetadata()).toMatchObject({
      title: "$HIVRA tokenomics: access, migration and future uses",
      description: "How Hivra's token access works, how eligible $HermesOS holders claim $HIVRA, and what token-based services Hivra is considering next.",
    });
    const { container } = renderPage(TokenomicsPage);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^\$HIVRA: what it's for$/);
    expect(screen.getByRole("heading", { name: "A snapshot has been taken. Eligible holders can claim." })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Nothing to claim|Nothing to swap|Airdrop flow|sent one \$HIVRA|new users hold and pay|new Hivra accounts use|Bankr|ETH proceeds/);
    // The pack drops the token-pricing line and the bonus-credit offer.
    expect(container.textContent).not.toMatch(/\$49|\$79|bonus credits/);
    expect(container.textContent).not.toMatch(/[–—]/);
  });

  it("/why-hivra/evolution says $HIVRA is live on Base and uses Ash's two replacement paragraphs", () => {
    setPhase(phase);
    const { container } = renderPage(WhyHivraEvolutionPage);
    expect(screen.getByText(copy.evolution.hivraStatus)).toBeInTheDocument();
    expect(screen.getByText(copy.evolution.relationship)).toBeInTheDocument();
    for (const line of copy.evolution.hivraDetails) expect(screen.getByText(line)).toBeInTheDocument();
    expect(container.textContent).toContain("Check contract addresses only on the token page.");
    expect(container.textContent).not.toMatch(/does not exist yet|Under the proposal, paying in the token keeps its discount/);
    expect(container.textContent).not.toMatch(/New accounts use \$HIVRA|sent \$HIVRA automatically|nothing to claim|Hivra starts using it/i);
  });

  it("/llms.txt says $HIVRA is live on Base", () => {
    setPhase(phase);
    const txt = buildLlmsTxt({ siteUrl: "https://example.test" });
    expect(txt).toContain(copy.llmsTxt.tokenStatus);
    expect(txt).not.toContain("does not exist yet");
    expect(txt).not.toMatch(/[–—]/);
  });
});

it.each(["scheduled", "active"] as const)("a %s /token lists $HIVRA first, then $HermesOS, with no launch countdown", (phase) => {
  setPhase(phase);
  const { container } = renderPage(TokenVerificationPage);
  const listed = Array.from(container.querySelectorAll("[data-token]")).map((node) => node.getAttribute("data-token"));
  expect(listed).toEqual(["hivra", "hermesos"]);
  expect(within(container.querySelector('[data-token="hivra"]') as HTMLElement).getByRole("heading", { level: 3 })).toHaveTextContent(/^\$HIVRA · New ecosystem token$/);
  expect(within(container.querySelector('[data-token="hermesos"]') as HTMLElement).getByRole("heading", { level: 3 })).toHaveTextContent(/^\$HermesOS · Legacy token$/);
  expect(container.textContent).not.toMatch(/soon|launching|not launched/i);
});
