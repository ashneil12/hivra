/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import PlanCalculatorTool from "../PlanCalculatorTool";
import AgentSurvivalCheckTool from "../AgentSurvivalCheckTool";
import HostingCostCalculatorTool from "../HostingCostCalculatorTool";
import LimitResetCalculatorTool from "../LimitResetCalculatorTool";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const TOOL_FILES = ["PlanCalculatorTool.tsx", "AgentSurvivalCheckTool.tsx", "HostingCostCalculatorTool.tsx", "LimitResetCalculatorTool.tsx"];

function expectNoBannedClaims(container: HTMLElement) {
  expect(findBannedClaims(container.textContent ?? "")).toEqual([]);
}

// Rendered text one block per line, so sentences from neighbouring elements
// never run together.
function blockText(container: HTMLElement): string {
  return [...container.querySelectorAll("p, li, h2, h3")].map((el) => el.textContent ?? "").join("\n");
}

// Whether a Claude Code or Codex run started in the browser chat or the agent's
// session tab outlives the tab depends on the computer's runtime version, so the
// tools promise neither. Any sentence about Hivra or a managed computer that
// says the work keeps going has to say how: tmux or Telegram.
function expectKeepRunningClaimsQualified(container: HTMLElement) {
  expect(unqualifiedKeepRunningClaims(blockText(container), /Hivra|managed|always-on (?:box|computer)/i)).toEqual([]);
  expect(container.textContent).not.toMatch(/Box Terminal|\b(?:the|a|managed|always-on|cloud) box\b/i);
  expect(unknownDashboardNames(blockText(container))).toEqual([]);
}

describe("tool components carry no retired claims", () => {
  it.each(TOOL_FILES)("%s does not depend on the retired trial flag or name Hivra plans", (file) => {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    expect(source).not.toMatch(/trial-ui|isCardRequiredTrialUiEnabled|CARD_REQUIRED_TRIAL/);
    expect(source).not.toMatch(/free trial|card required|never sleeps/i);
    expect(source).not.toMatch(/Hivra Pro|Hivra Power|maxAgents/);
    expect(source).not.toMatch(/[–—]/);
  });
});

describe("PlanCalculatorTool", () => {
  it("scales Pro's observed limit by Anthropic's published multiples and prices the API side", () => {
    const { container } = render(<PlanCalculatorTool />);

    // Default schedule: 5 days x 3 hours = 15 active hours per week.
    expect(screen.getByText("15h")).toBeInTheDocument();
    for (const label of ["Pro", "Max 5x", "Max 20x"]) expect(screen.getByText(label)).toBeInTheDocument();
    for (const price of ["$20/mo", "$100/mo", "$200/mo"]) expect(screen.getByText(price)).toBeInTheDocument();

    // Pro stops the visitor 2 hours in; a 3 hour day needs Max 5x. API: 64.95h x
    // (0.5M in, 0.05M out) at 80% Sonnet 5 ($2/$10) and 20% Opus 5.5 ($4/$20).
    expect(screen.getByTestId("pc-verdict")).toHaveTextContent(
      "Max 5x at $100/month is the cheapest plan that fits. The same usage at API rates: about $117/month."
    );

    // Pro never stopping you means Pro is the answer.
    fireEvent.change(container.querySelector("#pc-pro-hit") as HTMLSelectElement, { target: { value: "never" } });
    expect(screen.getByTestId("pc-verdict")).toHaveTextContent(/^Pro at \$20\/month is the cheapest plan that fits/);

    // One short session a week costs less at API rates than any plan.
    fireEvent.change(container.querySelector("#pc-days") as HTMLInputElement, { target: { value: "1" } });
    fireEvent.change(container.querySelector("#pc-hours") as HTMLInputElement, { target: { value: "1" } });
    expect(screen.getByTestId("pc-verdict")).toHaveTextContent(/plain API billing is cheaper: about \$7\.79\/month/);

    // Without a Pro reading the tool refuses to guess a cap.
    fireEvent.change(container.querySelector("#pc-pro-hit") as HTMLSelectElement, { target: { value: "unknown" } });
    expect(screen.getByTestId("pc-verdict")).toHaveTextContent(/Anthropic does not publish Pro's cap/);
    expect(screen.queryByText("Fits with headroom")).not.toBeInTheDocument();

    // 7 days x the 1 hour set above.
    fireEvent.change(container.querySelector("#pc-days") as HTMLInputElement, { target: { value: "7" } });
    expect(screen.getByText("7h")).toBeInTheDocument();

    expect(screen.getByText(/last verified 2026-09-24/)).toBeInTheDocument();
    // The button promises Claude Code, so it preselects the runtime.
    expect(screen.getByRole("link", { name: /run claude code on hivra/i })).toHaveAttribute(
      "href",
      "/get-started?plan=operator&agentType=claude-code",
    );
    expect(screen.getByText(/start long runs inside tmux or from Telegram/)).toBeInTheDocument();
    expectKeepRunningClaimsQualified(container);
    expectNoBannedClaims(container);
  });
});

describe("AgentSurvivalCheckTool", () => {
  it("scores the default laptop setup low and improves when answers change", () => {
    const { container } = render(<AgentSurvivalCheckTool />);

    const gauge = screen.getByRole("img", { name: /survival score \d+ out of 100/i });
    const initialScore = Number((gauge.getAttribute("aria-label") ?? "").match(/\d+/)?.[0]);
    expect(initialScore).toBeGreaterThanOrEqual(0);
    expect(initialScore).toBeLessThan(80);
    // The lid fix is honest about what caffeinate cannot do.
    expect(screen.getByText(/closed-display mode with an external display/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("A managed always-on computer (Hivra or similar)"));
    const updated = screen.getByRole("img", { name: /survival score \d+ out of 100/i });
    const updatedScore = Number((updated.getAttribute("aria-label") ?? "").match(/\d+/)?.[0]);
    expect(updatedScore).toBeGreaterThan(initialScore);

    expect(screen.getByText(/last verified 2026-09-24/)).toBeInTheDocument();
    expect(screen.getByText(/The \$9\.99 a month plan gives it 2 vCPU and 4 GB/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /skip the server upkeep/i })).toHaveAttribute("href", TOOLS_CTA.primaryHref);
    expectKeepRunningClaimsQualified(container);
    expectNoBannedClaims(container);
  });

  it("tells a managed-computer user to put long runs in tmux, without claiming what a browser run does", () => {
    const { container } = render(<AgentSurvivalCheckTool />);
    fireEvent.click(screen.getByLabelText("A managed always-on computer (Hivra or similar)"));

    // Plain terminal on a managed computer: nothing the owner controls holds the
    // run. It is a failure mode, not a solved problem, but whether a browser run
    // stops with the tab depends on the computer's runtime version, so the tool
    // says neither that it stops nor that it keeps going.
    // Listed as a failure mode and in the shareable verdict.
    expect(screen.getAllByText(/Long runs are not in tmux/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/start long runs inside tmux in the computer's own terminal \(on Hivra, the Terminal tab under Computer\)/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/no SIGHUP|removes the lid, the SIGHUP/);
    expect(container.textContent).not.toMatch(/stops when you close|Closing the tab ends|lasts only as long as that tab/);
    expect(screen.getByText(/Start a run inside tmux in its Terminal tab, or send it from Telegram, and it keeps going after you close\s+the laptop/)).toBeInTheDocument();
    expectKeepRunningClaimsQualified(container);
    expectNoBannedClaims(container);

    // Inside tmux the run survives the closed tab, so that failure mode goes away.
    fireEvent.click(screen.getByLabelText("tmux"));
    expect(screen.queryAllByText(/Long runs are not in tmux/)).toHaveLength(0);
    expectKeepRunningClaimsQualified(container);
    expectNoBannedClaims(container);
  });

  it("recommends the portable swap file recipe", () => {
    render(<AgentSurvivalCheckTool />);
    fireEvent.click(screen.getByLabelText("1 GB or less"));
    fireEvent.click(screen.getByLabelText("A raw VPS or cloud VM I manage"));
    expect(screen.getByText(/dd if=\/dev\/zero of=\/swapfile/)).toBeInTheDocument();
  });
});

describe("HostingCostCalculatorTool", () => {
  it("compares one VPS with Hivra's $9.99 plan and credits DIY honestly", () => {
    const { container } = render(<HostingCostCalculatorTool />);

    // Default preset is the same size as Hivra's computer.
    expect(screen.getByText(/Same CPU and memory as Hivra's 2 vCPU, 4 GB computer/)).toBeInTheDocument();
    expect(screen.getAllByText(/Hivra \$9\.99 plan/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("$120 over 12 monthly payments")).toBeInTheDocument();
    expect(screen.getByTestId("hc-verdict")).toHaveTextContent(/^The server was never the cost/);

    // Backups start off: Hivra's $9.99 price has none, so the default does not
    // charge DIY for something the Hivra side lacks.
    const backups = screen.getByLabelText(/automated backups/i) as HTMLInputElement;
    expect(backups.checked).toBe(false);
    expect(screen.getByText("Off by default. Hivra's $9.99 price does not include backups.")).toBeInTheDocument();
    expect(screen.getByText("none selected")).toBeInTheDocument();
    fireEvent.click(backups);
    expect(screen.getByText("backups")).toBeInTheDocument();
    fireEvent.click(backups);

    // With time counted at $0, the Hetzner CX23 ($7.09 incl. IPv4) beats $9.99.
    fireEvent.click(screen.getByLabelText(/my time is free/i));
    expect(screen.getByTestId("hc-verdict")).toHaveTextContent(/^On raw dollars, DIY wins/);

    // A same-size DigitalOcean droplet costs more even with free time.
    fireEvent.change(container.querySelector("#hc-vps") as HTMLSelectElement, { target: { value: "do4gb" } });
    expect(screen.getByTestId("hc-verdict")).toHaveTextContent(/^Even with your time at \$0, this VPS costs more/);

    // A smaller preset is flagged as not like for like.
    fireEvent.change(container.querySelector("#hc-vps") as HTMLSelectElement, { target: { value: "vultr1gb" } });
    expect(screen.getByText(/Smaller than Hivra's 2 vCPU, 4 GB computer/)).toBeInTheDocument();

    expect(screen.getByText(/Prices last verified 2026-09-24/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start on the \$9\.99 plan/i })).toHaveAttribute("href", "/get-started?plan=operator");
    // /pricing shows a preview ladder, so the two sizes checkout sells are stated here.
    expect(screen.getByText(/\$9\.99 a month for 2 vCPU and 4 GB, or \$19\.99 a month for 4 vCPU and 8 GB/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "the pricing page" })).not.toBeInTheDocument();
    expectNoBannedClaims(container);
  });
});

describe("LimitResetCalculatorTool", () => {
  it("computes the window close time, wraps past midnight, and keeps the weekly limit separate", () => {
    const { container } = render(<LimitResetCalculatorTool />);

    expect(screen.getByTestId("lr-close-time")).toHaveTextContent("14:00");
    expect(screen.getByText(/2:00 pm on the same day/)).toBeInTheDocument();

    const firstPrompt = container.querySelector("#lr-first-prompt") as HTMLInputElement;
    fireEvent.change(firstPrompt, { target: { value: "22:30" } });
    expect(screen.getByTestId("lr-close-time")).toHaveTextContent("03:30");
    expect(screen.getByText(/3:30 am the next day/)).toBeInTheDocument();

    // The weekly limit starts as a warning, not a countdown, because the reset
    // time is assigned per account and the tool refuses to guess it.
    expect(screen.getByText(/Waiting out the 5 hour window does nothing for the weekly limit/)).toBeInTheDocument();

    fireEvent.change(container.querySelector("#lr-weekly-day") as HTMLSelectElement, { target: { value: "3" } });
    expect(screen.getByText(/Weekly limit resets in/)).toBeInTheDocument();
    expect(screen.getByText(/Next reset lands on Wednesday at 09:00/)).toBeInTheDocument();

    // The first-message anchor is labelled as an assumption, not a documented fact.
    expect(screen.getByText(/does\s+not document what opens it/)).toBeInTheDocument();
    expect(screen.getByText(/Facts\s+last verified 2026-09-24/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /run claude code on hivra/i })).toHaveAttribute(
      "href",
      "/get-started?plan=operator&agentType=claude-code",
    );
    // A tmux session in the Terminal tab outlives the tab on every computer; the
    // copy says nothing either way about browser chat runs.
    expect(screen.getByText(/A session you start inside tmux in its\s+Terminal tab stays open after you close the laptop/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/stops when you close|browser chat/);
    expectKeepRunningClaimsQualified(container);
    expectNoBannedClaims(container);
  });
});
