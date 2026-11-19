/** @jest-environment jsdom */
// Agent job library component: renders every job grouped by category, filters by group, connections and
// search, offers a copy button per prompt, writes only allow-listed params to the address, shows one
// contextual start button, and makes no banned claim in its rendered text.
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import AgentJobLibraryTool from "../AgentJobLibraryTool";
import { AGENT_JOBS } from "@/lib/tools/agent-tools/agent-job-library";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

beforeEach(() => {
  window.history.replaceState(null, "", "/tools/ai-agent-use-cases");
});

describe("AgentJobLibraryTool", () => {
  it("renders every job as a card under group headings, with a status line", () => {
    render(<AgentJobLibraryTool />);
    expect(screen.getAllByTestId("job-card")).toHaveLength(AGENT_JOBS.length);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(8);
    expect(screen.getByRole("heading", { name: "Inbox and calendar" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(`Showing ${AGENT_JOBS.length} of ${AGENT_JOBS.length} jobs.`);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("labels every input and button", () => {
    render(<AgentJobLibraryTool />);
    expect(screen.getByLabelText("Search the jobs")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Group" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "What my agent is connected to" })).toBeInTheDocument();
    for (const name of ["Email", "Calendar", "Web browsing", "Files", "A chat app"]) expect(screen.getByLabelText(name)).toBeInTheDocument();
  });

  it("filters by group", () => {
    render(<AgentJobLibraryTool />);
    fireEvent.click(screen.getByRole("button", { name: /^Money and shopping \(\d+\)$/ }));
    const cards = screen.getAllByTestId("job-card");
    expect(cards.length).toBe(AGENT_JOBS.filter((j) => j.category === "money").length);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Money and shopping/ })).toHaveAttribute("aria-pressed", "true");
    expect(window.location.search).toBe("?jobs=money");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByTestId("job-card")).toHaveLength(AGENT_JOBS.length);
    expect(window.location.search).toBe("");
  });

  it("filters by what is connected, and shows jobs that need nothing", () => {
    render(<AgentJobLibraryTool />);
    fireEvent.click(screen.getByLabelText("Email"));
    const shown = screen.getAllByTestId("job-card");
    const expected = AGENT_JOBS.filter((j) => j.needs.every((n) => n === "email"));
    expect(shown).toHaveLength(expected.length);
    expect(screen.getByLabelText("Only show jobs I can run with what is ticked")).toBeChecked();
    expect(screen.getByText("Sort the morning inbox")).toBeInTheDocument();
    expect(screen.queryByText("Preview the week ahead")).toBeNull();
    expect(window.location.search).toBe("?have=email&runnable=1");
  });

  it("keeps the connections in the link when 'only show' is unticked, and reloads to the same list", () => {
    const { unmount } = render(<AgentJobLibraryTool />);
    fireEvent.click(screen.getByLabelText("Email"));
    fireEvent.click(screen.getByLabelText("Only show jobs I can run with what is ticked"));
    expect(window.location.search).toBe("?have=email");
    expect(screen.getAllByTestId("job-card")).toHaveLength(AGENT_JOBS.length);
    unmount();
    render(<AgentJobLibraryTool />);
    expect(screen.getByLabelText("Email")).toBeChecked();
    expect(screen.getByLabelText("Only show jobs I can run with what is ticked")).not.toBeChecked();
    expect(screen.getAllByTestId("job-card")).toHaveLength(AGENT_JOBS.length);
  });

  it("keeps 'only show' in the link with nothing connected, and reloads to jobs that need nothing", () => {
    const { unmount } = render(<AgentJobLibraryTool />);
    fireEvent.click(screen.getByLabelText("Only show jobs I can run with what is ticked"));
    expect(window.location.search).toBe("?runnable=1");
    const count = screen.getAllByTestId("job-card").length;
    expect(count).toBe(AGENT_JOBS.filter((j) => j.needs.length === 0).length);
    unmount();
    render(<AgentJobLibraryTool />);
    expect(screen.getByLabelText("Only show jobs I can run with what is ticked")).toBeChecked();
    expect(screen.getAllByTestId("job-card")).toHaveLength(count);
  });

  it("keeps the clear button out of the live status region", () => {
    render(<AgentJobLibraryTool />);
    fireEvent.click(screen.getByLabelText("Email"));
    const clear = screen.getByRole("button", { name: "Clear filters" });
    expect(screen.getByRole("status")).not.toContainElement(clear);
    expect(screen.getByRole("status")).toHaveTextContent(/^Showing \d+ of \d+ jobs\.$/);
  });

  it("searches without putting the text in the address", () => {
    render(<AgentJobLibraryTool />);
    fireEvent.change(screen.getByLabelText("Search the jobs"), { target: { value: "invoice" } });
    expect(screen.getAllByTestId("job-card").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("job-card").length).toBeLessThan(AGENT_JOBS.length);
    expect(window.location.search).toBe("");
    fireEvent.change(screen.getByLabelText("Search the jobs"), { target: { value: "zzzz-nothing" } });
    expect(screen.queryAllByTestId("job-card")).toHaveLength(0);
    expect(screen.getByText(/No job matches/)).toBeInTheDocument();
  });

  it("reads a shared link on load", () => {
    window.history.replaceState(null, "", "/tools/ai-agent-use-cases?jobs=code&have=files&runnable=1&utm_source=x");
    render(<AgentJobLibraryTool />);
    const cards = screen.getAllByTestId("job-card");
    expect(cards.map((c) => c.getAttribute("data-job-id")).sort()).toEqual(["code-dependency-audit", "code-diff-summary", "code-log-triage", "code-readme-draft"]);
    expect(screen.getByLabelText("Files")).toBeChecked();
    // Keys the tool does not own are kept.
    expect(window.location.search).toContain("utm_source=x");
  });

  it("ignores junk in a shared link", () => {
    window.history.replaceState(null, "", "/tools/ai-agent-use-cases?jobs=%3Cscript%3E&have=nope");
    render(<AgentJobLibraryTool />);
    expect(screen.getAllByTestId("job-card")).toHaveLength(AGENT_JOBS.length);
  });

  it("gives each card the prompt, setup and risk notes, and a copy button that copies the exact prompt", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AgentJobLibraryTool />);
    const job = AGENT_JOBS[0];
    const card = screen.getAllByTestId("job-card")[0];
    expect(within(card).getByText(job.title)).toBeInTheDocument();
    expect(within(card).getByText(/Set up first:/)).toBeInTheDocument();
    expect(within(card).getByText(/What can go wrong:/)).toBeInTheDocument();
    expect(card.querySelector("pre")?.textContent).toBe(job.prompt);
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: `Copy prompt: ${job.title}` }));
    });
    expect(writeText).toHaveBeenCalledWith(job.prompt);
    expect(within(card).getByRole("button")).toHaveTextContent("Prompt copied");
  });

  it("has one copy button per card", () => {
    render(<AgentJobLibraryTool />);
    expect(screen.getAllByRole("button", { name: /^Copy prompt: / })).toHaveLength(AGENT_JOBS.length);
  });

  it("offers one start button, worded as a statement, with the plan size and no pressure", () => {
    render(<AgentJobLibraryTool />);
    const links = screen.getAllByRole("link", { name: /Start Hermes on Hivra/ });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toContain(PUBLIC_START_HREF);
    expect(screen.getByText(/2 vCPU and 4 GB/)).toBeInTheDocument();
  });

  it("makes no banned claim in what it renders", () => {
    const { container } = render(<AgentJobLibraryTool />);
    const text = container.textContent ?? "";
    expect(findBannedClaims(text)).toEqual([]);
    expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
    expect(unknownDashboardNames(text)).toEqual([]);
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/saves? (?:you )?(?:time|money)/i);
  });
});
