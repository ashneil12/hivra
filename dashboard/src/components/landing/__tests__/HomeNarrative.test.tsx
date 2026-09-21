/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import ChooseAgentSection from "../ChooseAgentSection";
import FAQSection from "../FAQSection";
import FeaturesSection from "../FeaturesSection";
import WhatsComingSection from "../WhatsComingSection";
import VisionSection from "../VisionSection";
import { HOMEPAGE_FAQ } from "../public-home-content";

test("all named agents retain working catalog destinations without false waitlists", () => {
  render(<ChooseAgentSection />);
  const expected = [
    ["Claude Code", "/dashboard/welcome?step=deploy&agentType=claude-code"],
    ["Codex", "/dashboard/welcome?step=deploy&agentType=codex"],
    ["Hermes", "/dashboard/welcome?step=deploy&agentType=general"],
    ["Agent Zero", "/dashboard/welcome?step=deploy&agentType=agent-zero"],
    ["DeepSeek", "/dashboard/agents#deepseek-harness"],
    ["OpenClaw", "/dashboard/welcome?step=deploy&agentType=openclaw"],
    ["Aeon", "/dashboard/welcome?step=deploy&agentType=aeon"],
  ];
  for (const [name, href] of expected) {
    const row = screen.getByRole("heading", { name }).closest("article")!;
    expect(within(row).getByRole("link", {name:"Choose agent"})).toHaveAttribute("href", href);
  }
  expect(screen.queryByText(/join waitlist|private preview|coming soon/i)).not.toBeInTheDocument();
  expect(screen.getByText(/work directly in its terminal, or move between the two/)).toBeInTheDocument();
  expect(screen.getByText("More agents are coming.")).toBeVisible();
  expect(screen.queryByText("DeepSeek Harness")).not.toBeInTheDocument();
});

test("the FAQ renders the same answers used by homepage structured data", () => {
  const { container } = render(<FAQSection />);
  expect(container.querySelectorAll("details")).toHaveLength(HOMEPAGE_FAQ.length);
  for (const { q, a } of HOMEPAGE_FAQ) {
    expect(screen.getByText(q)).toBeInTheDocument();
    expect(screen.getByText(a)).toBeInTheDocument();
  }
  expect(screen.getByText(/without attaching an agent/)).toBeInTheDocument();
  expect(screen.getByText(/Self-hosting needs no token/)).toBeInTheDocument();
  expect(screen.queryByText(/free managed tier/)).not.toBeInTheDocument();
});

test("workspace features keep interface choice and activity limits explicit", () => {
  render(<FeaturesSection />);
  expect(screen.getByRole("heading", { name: "A computer you can actually work in." })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Pick your interface" })).toBeInTheDocument();
  expect(screen.getByText(/Activity entirely inside an external app may not appear/)).toBeInTheDocument();
});

test("planned products are visible on first render and marked as coming or next", () => {
  render(<WhatsComingSection />);
  const fullPlan = screen.getByRole("link", { name: "Explore the full plan" });
  expect(fullPlan).toHaveAttribute("href", "/docs/litepaper/index.html#future");
  expect(fullPlan).toHaveAttribute("target", "_blank");
  expect(fullPlan).toHaveAttribute("rel", "noopener noreferrer");
  for (const name of ["Hivra Orchestrator", "macOS", "Custom images"]) {
    const heading = screen.getByRole("heading", { name });
    expect(heading).toBeVisible();
    expect(within(heading.closest("article")!).getByText(/^(Coming|Next)$/)).toBeVisible();
  }
  expect(screen.getByText(/The longer plan, including Gate/)).toBeVisible();
  expect(screen.queryByRole("heading",{name:"Gate"})).not.toBeInTheDocument();
});


test("the founder story opens the litepaper rather than the brand transition", () => {
  render(<VisionSection />);
  const founder = screen.getByRole("link", { name: "Why Hivra" });
  expect(founder).toHaveAttribute("href", "/docs/litepaper/index.html#founder");
  expect(founder).toHaveAttribute("target", "_blank");
  expect(founder).toHaveAttribute("rel", "noopener noreferrer");
});

test("recovery copy does not promise universal nightly backups", () => {
  const answer = HOMEPAGE_FAQ.find(item => item.q === "What happens if my agent crashes?")!.a;
  expect(answer).toContain("not guaranteed");
  expect(answer).not.toContain("losing today");
});
