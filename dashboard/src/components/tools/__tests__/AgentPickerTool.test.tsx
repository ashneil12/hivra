/** @jest-environment jsdom */
// Agent Picker component: renders the six questions, shows a result only when all are answered, shares
// answers through allow-listed URL params, offers one contextual start button, and makes no banned claim.
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import AgentPickerTool from "../AgentPickerTool";
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

const pick = (group: string, label: RegExp | string) => {
  const fieldset = screen.getByRole("group", { name: group });
  fireEvent.click(within(fieldset).getByLabelText(label));
};

function answerChatUser() {
  pick("What do you want it to do?", /Be an assistant/);
  pick("Where will you talk to it?", "Telegram");
  pick("Is the work mostly code, or everyday tasks?", "Mostly everyday tasks");
  pick("How hands-on do you want to be?", /Some setup/);
  pick("Does it need to be available around the clock?", /Yes, I want/);
  pick("Do you already pay for Claude or ChatGPT?", "Neither");
}

function answerCoder() {
  pick("What do you want it to do?", /Take a goal/);
  pick("Where will you talk to it?", "A terminal");
  pick("Is the work mostly code, or everyday tasks?", "Mostly code");
  pick("How hands-on do you want to be?", /Minimal/);
  pick("Does it need to be available around the clock?", /No, only while/);
  pick("Do you already pay for Claude or ChatGPT?", "Claude");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/tools/hermes-vs-openclaw");
});

describe("AgentPickerTool", () => {
  it("renders six labelled questions and no result or start button at first", () => {
    render(<AgentPickerTool />);
    expect(screen.getAllByRole("group")).toHaveLength(6);
    expect(screen.getByText(/0 of 6 answered/)).toBeInTheDocument();
    expect(screen.queryByTestId("agent-picker-result")).toBeNull();
    expect(screen.queryByRole("link", { name: /Start .* on Hivra/ })).toBeNull();
  });

  it("always shows the Hermes and OpenClaw comparison table", () => {
    render(<AgentPickerTool />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Built around")).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
  });

  it("counts answers and keeps the result hidden until all six are given", () => {
    render(<AgentPickerTool />);
    pick("Where will you talk to it?", "Telegram");
    expect(screen.getByText(/1 of 6 answered/)).toBeInTheDocument();
    expect(screen.queryByTestId("agent-picker-result")).toBeNull();
  });

  it("shows a tie for the chat user, with both cards and three reasons", () => {
    render(<AgentPickerTool />);
    answerChatUser();
    const result = screen.getByTestId("agent-picker-result");
    expect(within(result).getByRole("heading", { level: 2, name: /A tie: Hermes and OpenClaw/ })).toBeInTheDocument();
    expect(within(result).getByText("Why it fits your answers")).toBeInTheDocument();
    expect(within(result).getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(within(result).getByText("The honest tradeoff")).toBeInTheDocument();
    expect(within(result).getByText("When OpenClaw is the better choice")).toBeInTheDocument();
  });

  it("names a single best fit for the coder and starts Claude Code with its agentType", () => {
    render(<AgentPickerTool />);
    answerCoder();
    expect(screen.getByRole("heading", { level: 2, name: "Your best fit: Claude Code" })).toBeInTheDocument();
    expect(screen.getByText("When Codex is the better choice")).toBeInTheDocument();
    const buttons = screen.getAllByRole("link", { name: /Start .* on Hivra/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("href", `${PUBLIC_START_HREF}?agentType=claude-code`);
    expect(buttons[0]).toHaveTextContent("Start Claude Code on Hivra");
  });

  it("points Hermes at the general agentType", () => {
    render(<AgentPickerTool />);
    answerChatUser();
    expect(screen.getByRole("link", { name: "Start Hermes on Hivra" })).toHaveAttribute("href", `${PUBLIC_START_HREF}?agentType=general`);
  });

  it("updates the result when an answer changes", () => {
    render(<AgentPickerTool />);
    answerCoder();
    pick("Do you already pay for Claude or ChatGPT?", "ChatGPT");
    expect(screen.getByRole("heading", { level: 2, name: "Your best fit: Codex" })).toBeInTheDocument();
  });

  it("writes only the answers into the address and keeps other query keys", () => {
    window.history.replaceState(null, "", "/tools/hermes-vs-openclaw?utm_source=x");
    render(<AgentPickerTool />);
    pick("Where will you talk to it?", "Discord");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("where")).toBe("discord");
    expect(params.get("utm_source")).toBe("x");
    expect([...params.keys()].sort()).toEqual(["utm_source", "where"]);
  });

  it("restores a shared result from the address", () => {
    window.history.replaceState(null, "", "/tools/hermes-vs-openclaw?job=project&where=terminal&focus=code&hands=minimal&uptime=present&sub=claude");
    render(<AgentPickerTool />);
    expect(screen.getByRole("heading", { level: 2, name: "Your best fit: Claude Code" })).toBeInTheDocument();
  });

  it("ignores values that are not on the allow-list", () => {
    window.history.replaceState(null, "", "/tools/hermes-vs-openclaw?job=%3Cscript%3E&where=telegram");
    render(<AgentPickerTool />);
    expect(screen.getByText(/1 of 6 answered/)).toBeInTheDocument();
    expect(screen.getByLabelText("Telegram")).toBeChecked();
    expect(window.location.search).not.toContain("script");
  });

  it("clears the answers and the address", () => {
    render(<AgentPickerTool />);
    answerCoder();
    fireEvent.click(screen.getByRole("button", { name: "Clear answers" }));
    expect(screen.getByText(/0 of 6 answered/)).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("copies the link to the result", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AgentPickerTool />);
    answerCoder();
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this result" }));
    await screen.findByText("Link copied");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/tools/hermes-vs-openclaw?job=project"));
  });

  it("says the plan has a size and does not include AI usage, and makes no banned claim", () => {
    const { container } = render(<AgentPickerTool />);
    for (const answerAll of [answerChatUser, answerCoder]) {
      answerAll();
      const text = container.textContent ?? "";
      expect(findBannedClaims(text)).toEqual([]);
      expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
      expect(unknownDashboardNames(text)).toEqual([]);
      expect(text).toMatch(/\$9\.99 a month for 2 vCPU and 4 GB/);
      expect(text).toMatch(/does not include AI usage/);
    }
  });

  it("makes no network calls", () => {
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    render(<AgentPickerTool />);
    answerChatUser();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
