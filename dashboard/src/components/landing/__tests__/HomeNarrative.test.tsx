/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import ChooseAgentSection from "../ChooseAgentSection";
import FAQSection from "../FAQSection";
import FeaturesSection from "../FeaturesSection";
import WhatsComingSection from "../WhatsComingSection";
import VisionSection from "../VisionSection";
import { HOMEPAGE_FAQ } from "../public-home-content";
import { AGENT_SLOTS } from "@/lib/subscription/agent-slots";
import { COMPUTER_TEMPLATES } from "@/lib/hivra/computer-catalog";

test("every named agent opens its own plan in Launch, without false waitlists", () => {
  render(<ChooseAgentSection />);
  const expected = [
    ["Claude Code", "/dashboard/launch?kind=agent&start=1&profile=claude-code"],
    ["Codex", "/dashboard/launch?kind=agent&start=1&profile=codex"],
    ["Hermes", "/dashboard/launch?kind=agent&start=1&profile=hermes"],
    ["Agent Zero", "/dashboard/launch?kind=agent&start=1&profile=agent-zero"],
    ["OpenClaw", "/dashboard/launch?kind=agent&start=1&profile=openclaw"],
    ["Aeon", "/dashboard/launch?kind=agent&start=1&profile=aeon"],
  ];
  for (const [name, href] of expected) {
    const row = screen.getByRole("heading", { name }).closest("article")!;
    expect(within(row).getByRole("link", {name:"Choose agent"})).toHaveAttribute("href", href);
  }
  // DeepSeek Harness is not launchable in the agent catalog, so it is a labelled preview, not a launch choice.
  const deepseek = screen.getByRole("heading", { name: "DeepSeek" }).closest("article")!;
  expect(within(deepseek).getByText(/· Preview$/)).toBeInTheDocument();
  expect(within(deepseek).queryByRole("link", { name: "Choose agent" })).not.toBeInTheDocument();
  expect(within(deepseek).getByRole("link", { name: "See the preview" })).toHaveAttribute("href", "/dashboard/agents#deepseek-harness");
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
  // ATT-02: a computer runs without an agent, and an agent gets its own
  // computer. The FAQ must not imply attaching an agent to a computer later.
  expect(screen.getByText(/A computer runs fine without an agent, and every agent you launch gets a computer of its own/)).toBeInTheDocument();
  expect(screen.queryByText(/attach/i)).not.toBeInTheDocument();
  expect(screen.getByText(/Self-hosting needs no token/)).toBeInTheDocument();
  expect(screen.queryByText(/free managed tier/)).not.toBeInTheDocument();
});

test("FAQ availability and agent limits match the catalogs and plan caps", () => {
  const answer = (q: string) => HOMEPAGE_FAQ.find(item => item.q === q)!.a;
  const slots = answer("How many agents can I run?");
  expect(slots).not.toMatch(/as many as fit/i);
  expect(slots).toContain(`${AGENT_SLOTS.free}, ${AGENT_SLOTS.operator} or ${AGENT_SLOTS.fleet} agents`);
  const computers = answer("Do I have to use an agent?");
  for (const template of COMPUTER_TEMPLATES.filter(item => item.status === "private-preview")) {
    expect(computers).toContain(template.name);
  }
  expect(computers).toContain("private preview");
  expect(answer("Which agents can I use?")).toContain("DeepSeek is in preview");
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
