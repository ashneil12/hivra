/** @jest-environment jsdom */
/**
 * What a viewer the token geo-policy blocks reads on /token, /tokenomics and
 * /why-hivra/evolution, in every $HIVRA phase. The contract addresses, the way to
 * verify them, the notice and the access they already have stay. The status,
 * proposal and qualify-for-compute lines do not: a status sentence about a
 * proposed or launched token is still token copy. Run against the COMMITTED
 * country list (GB), not the empty list jest.setup.tsx gives other suites.
 */
import "@testing-library/jest-dom";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";

jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

// The launch block the real token registry reads. Tests fill it in to change the phase.
const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({ HIVRA_TOKEN_LAUNCH: mockLaunch }));

const mockHeaders = jest.fn();
jest.mock("next/headers", () => ({ ...jest.requireActual("next/headers"), headers: () => mockHeaders() }));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: null })) }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
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

import TokenVerificationPage from "@/app/token/page";
import TokenomicsPage from "@/app/tokenomics/page";
import WhyHivraEvolutionPage from "@/app/why-hivra/evolution/page";
import { getHivraTokenPhase, type HivraTokenPhase } from "@/lib/billing/token-registry";
import { RESTRICTED_TOKEN_PAGE_COPY, TOKEN_PHASE_COPY } from "@/lib/token-phase-copy";

const HIVRA_ADDRESS = "0x1111111111111111111111111111111111111111";
const HERMESOS_ADDRESS = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";
const PHASES = ["dormant", "scheduled", "active"] as const;

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

function viewerFrom(country: string) {
  mockHeaders.mockResolvedValue(new Headers({ "x-vercel-ip-country": country }));
}

async function renderPage(page: () => unknown) {
  cleanup();
  const element = page();
  return render((element instanceof Promise ? await element : element) as React.ReactElement);
}

/** What a blocked viewer must not read: a status of, a proposal for, or a way to qualify with the token. */
const STATUS_OR_PROPOSAL =
  /proposed|proposal|migration|discount|one way to qualify|qualify for compute|does not exist yet|to be launched|launched through|is live on Base|the live token|the proposed next/i;

afterEach(() => setPhase("dormant"));

describe.each(PHASES)("%s $HIVRA, a viewer in the United Kingdom", (phase) => {
  const copy = TOKEN_PHASE_COPY[phase];

  beforeEach(() => {
    setPhase(phase);
    viewerFrom("GB");
  });

  it("/why-hivra/evolution has no $HIVRA status, proposal or relationship line, and keeps the way to check contracts", async () => {
    const { container } = await renderPage(WhyHivraEvolutionPage);
    const text = container.textContent ?? "";
    expect(text).not.toContain(copy.evolution.hivraStatus);
    expect(text).not.toContain(copy.evolution.relationship);
    // The dormant note leads with "Everything about $HIVRA here is a proposal"; the launched ones are just the pointer.
    expect(text).not.toContain("Everything about $HIVRA here is a proposal");
    for (const line of copy.evolution.hivraDetails) expect(text).not.toContain(line);
    expect(text).not.toMatch(STATUS_OR_PROPOSAL);
    expect(screen.getByTestId("token-geo-notice")).toBeInTheDocument();
    expect(text).toContain(`${RESTRICTED_TOKEN_PAGE_COPY.evolutionAddressNote} token page.`);
    expect(screen.getByRole("link", { name: "token page" })).toHaveAttribute("href", "/token");
    // Existing holders are still told their access stays.
    expect(text).toContain("Existing $HermesOS holders are grandfathered.");
  });

  it("/token keeps the contracts, the official accounts and the access they have, and drops the proposal and qualify lines", async () => {
    const { container } = await renderPage(TokenVerificationPage);
    const text = container.textContent ?? "";
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(RESTRICTED_TOKEN_PAGE_COPY.heroTitle);
    expect(text).toContain(RESTRICTED_TOKEN_PAGE_COPY.eyebrow);
    expect(text).toContain(RESTRICTED_TOKEN_PAGE_COPY.heroLead);
    expect(text).toContain(RESTRICTED_TOKEN_PAGE_COPY.accessParagraph);
    expect(text).not.toContain("OPTIONAL TOKEN");
    expect(text).not.toContain(copy.tokenPage.heroLead);
    expect(text).not.toMatch(STATUS_OR_PROPOSAL);
    // The anti-scam controls are untouched.
    expect(screen.getByText(HERMESOS_ADDRESS)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View the contract on BaseScan" })).toHaveAttribute("href", `https://basescan.org/token/${HERMESOS_ADDRESS}`);
    if (phase !== "dormant") expect(screen.getByText(HIVRA_ADDRESS)).toBeInTheDocument();
    expect(screen.getByTestId("token-lookalike-warning")).toBeInTheDocument();
    expect(screen.getByTestId("token-risk-line")).toBeInTheDocument();
    expect(screen.getByText("Official accounts")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Billing" })).toHaveAttribute("href", "/dashboard/billing");
    expect(screen.getByTestId("token-geo-notice")).toBeInTheDocument();
  });

  it("/tokenomics is headed as contracts and has no $HIVRA status or proposal lead", async () => {
    const { container } = await renderPage(TokenomicsPage);
    const text = container.textContent ?? "";
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tokencontracts.");
    expect(text).toContain(RESTRICTED_TOKEN_PAGE_COPY.tokenomicsLead);
    expect(text).not.toContain(copy.tokenomics.headerLead);
    expect(text).not.toMatch(STATUS_OR_PROPOSAL);
    expect(screen.getByTestId("tokenomics-contracts")).toHaveTextContent(HERMESOS_ADDRESS);
    expect(screen.getByRole("link", { name: /verify the token contracts/i })).toHaveAttribute("href", "/token");
  });
});

describe.each(PHASES)("%s $HIVRA, a viewer from elsewhere", (phase) => {
  const copy = TOKEN_PHASE_COPY[phase];

  beforeEach(() => {
    setPhase(phase);
    viewerFrom("FR");
  });

  it("reads every status and proposal line, unchanged", async () => {
    const { container } = await renderPage(WhyHivraEvolutionPage);
    const text = container.textContent ?? "";
    expect(text).toContain(copy.evolution.hivraStatus);
    expect(text).toContain(copy.evolution.relationship);
    expect(text).toContain(copy.evolution.addressNote);

    const token = await renderPage(TokenVerificationPage);
    expect(token.container.textContent).toContain(copy.tokenPage.heroLead);
    expect(token.container.textContent).toContain("OPTIONAL TOKEN");
    expect(token.container.textContent).toContain("Eligible $HermesOS holdings are one way to qualify for compute access.");

    const tokenomics = await renderPage(TokenomicsPage);
    expect(tokenomics.container.textContent).toContain(copy.tokenomics.headerLead);
  });
});

describe("the restricted words", () => {
  it("follow the copy rules: no dash, and no price, return, urgency or invitation", () => {
    for (const text of Object.values(RESTRICTED_TOKEN_PAGE_COPY)) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\b(buy|price|discount|bonus|return|profit|yield|invest|early|hurry|now|limited)\b/i);
    }
  });
});
