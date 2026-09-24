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
import { TOKEN_PHASE_COPY } from "@/lib/token-phase-copy";

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

describe("dormant $HIVRA: the copy from before", () => {
  const copy = TOKEN_PHASE_COPY.dormant;

  it("/token keeps its title, hero and proposals", () => {
    setPhase("dormant");
    expect(tokenMetadata()).toMatchObject({ title: copy.tokenPage.metadataTitle, description: copy.tokenPage.metadataDescription });
    renderPage(TokenVerificationPage);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^\$HermesOS and Hivra\.$/);
    expect(screen.getByText(copy.tokenPage.heroLead)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The proposed $HIVRA migration" })).toBeInTheDocument();
    expect(screen.getByText("The existing $HermesOS contract. $HIVRA has not launched.")).toBeInTheDocument();
    for (const paragraph of copy.tokenPage.migrationParagraphs) expect(screen.getByText(paragraph)).toBeInTheDocument();
  });

  it("/tokenomics keeps its title, header and migration paragraphs", () => {
    setPhase("dormant");
    expect(tokenomicsMetadata()).toMatchObject({ title: "Proposed $HIVRA tokenomics", description: copy.tokenomics.metadataDescription });
    renderPage(TokenomicsPage);
    expect(screen.getByText(copy.tokenomics.headerLead)).toBeInTheDocument();
    for (const paragraph of copy.tokenomics.migrationParagraphs) expect(screen.getByText(paragraph)).toBeInTheDocument();
  });

  it("/why-hivra/evolution keeps its $HIVRA lines", () => {
    setPhase("dormant");
    const { container } = renderPage(WhyHivraEvolutionPage);
    expect(screen.getByText("$HIVRA is a proposed new token on Base, to be launched through Bankr. It does not exist yet.")).toBeInTheDocument();
    for (const line of copy.evolution.hivraDetails) expect(screen.getByText(line)).toBeInTheDocument();
    expect(container.textContent).toContain("Everything about $HIVRA here is a proposal, not final terms. Check contract addresses only on the token page.");
    expect(screen.getByText("$HermesOS is the live token today. $HIVRA is the proposed next one.")).toBeInTheDocument();
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

  it("/token lists the contract and says it is live, with no proposal copy", () => {
    setPhase(phase);
    expect(tokenMetadata()).toMatchObject({ title: copy.tokenPage.metadataTitle, description: copy.tokenPage.metadataDescription });
    const { container } = renderPage(TokenVerificationPage);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.tokenPage.heroTitle);
    expect(screen.getByText(copy.tokenPage.heroLead)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Converting from $HermesOS" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The proposed $HIVRA migration" })).not.toBeInTheDocument();
    const hivra = within(container.querySelector('[data-token="hivra"]') as HTMLElement);
    expect(hivra.getByText(HIVRA_ADDRESS)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$HIVRA has not launched|There is no \$HIVRA contract yet|proposed \$HIVRA token/);
  });

  it("/tokenomics and /why-hivra/evolution say $HIVRA is live on Base", () => {
    setPhase(phase);
    expect(tokenomicsMetadata()).toMatchObject({ title: "$HIVRA tokenomics" });
    renderPage(TokenomicsPage);
    expect(screen.getByText(copy.tokenomics.headerLead)).toBeInTheDocument();
    expect(screen.getByText(copy.tokenomics.migrationParagraphs[0])).toBeInTheDocument();
    const { container } = renderPage(WhyHivraEvolutionPage);
    expect(screen.getByText(copy.evolution.hivraStatus)).toBeInTheDocument();
    expect(screen.getByText(copy.evolution.relationship)).toBeInTheDocument();
    expect(container.textContent).toContain("Check contract addresses only on the token page.");
    expect(container.textContent).not.toMatch(/does not exist yet|Under the proposal, paying in the token keeps its discount/);
  });

  it("/llms.txt says $HIVRA is live on Base", () => {
    setPhase(phase);
    const txt = buildLlmsTxt({ siteUrl: "https://example.test" });
    expect(txt).toContain(copy.llmsTxt.tokenStatus);
    expect(txt).not.toContain("does not exist yet");
    expect(txt).not.toMatch(/[–—]/);
  });
});

it("a scheduled /token names the instant Hivra starts using $HIVRA, and does not call it unlaunched", () => {
  setPhase("scheduled");
  const { container } = renderPage(TokenVerificationPage);
  expect(screen.getByText("The $HIVRA contract. Hivra starts using it at 1 October 2099, 16:00 UTC.")).toBeInTheDocument();
  const hermesos = within(container.querySelector('[data-token="hermesos"]') as HTMLElement);
  expect(hermesos.getByText("The existing $HermesOS contract.")).toBeInTheDocument();
});

it("an active /token lists $HIVRA first as LIVE and $HermesOS as LEGACY", () => {
  setPhase("active");
  const { container } = renderPage(TokenVerificationPage);
  const listed = Array.from(container.querySelectorAll("[data-token]")).map((node) => node.getAttribute("data-token"));
  expect(listed).toEqual(["hivra", "hermesos"]);
  expect(screen.getByText("The $HIVRA contract. New token payments and holdings use it.")).toBeInTheDocument();
});
