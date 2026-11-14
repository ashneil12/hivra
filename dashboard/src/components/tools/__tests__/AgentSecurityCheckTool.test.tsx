/** @jest-environment jsdom */
// Agent Security Check component: twelve labelled questions in eight groups, a fix under every no or not sure,
// a band and top three only once all twelve are answered, answers shared through one allow-listed URL param,
// one contextual start button, the Hivra section with what Hivra does not do, and no banned claim in the text.
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import AgentSecurityCheckTool from "../AgentSecurityCheckTool";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { CHECKS, GROUPS, serializeSecurityParams } from "@/lib/tools/agent-tools/agent-security-check";
import { EXAMPLE_ANSWERS } from "@/lib/tools/agent-tools/agent-security-check-entry";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const BASE = "/tools/ai-agent-security-checklist";
const setAddress = (search = "") => window.history.replaceState(null, "", `${BASE}${search}`);

const answer = (index: number, label: "Yes" | "No" | "Not sure") => {
  const group = screen.getByRole("group", { name: CHECKS[index].question });
  fireEvent.click(within(group).getByLabelText(label));
};

const answerAll = (label: "Yes" | "No" | "Not sure") => CHECKS.forEach((_, i) => answer(i, label));

beforeEach(() => setAddress());
afterEach(() => setAddress());

describe("AgentSecurityCheckTool", () => {
  it("renders twelve labelled questions in eight groups and no result at first", () => {
    render(<AgentSecurityCheckTool />);
    expect(screen.getAllByRole("group")).toHaveLength(12);
    for (const group of GROUPS) expect(screen.getByRole("heading", { level: 3, name: group.label })).toBeInTheDocument();
    expect(screen.getByText(/0 of 12 answered/)).toBeInTheDocument();
    expect(screen.queryByTestId("asc-result")).toBeNull();
    for (const check of CHECKS) {
      const group = screen.getByRole("group", { name: check.question });
      expect(within(group).getAllByRole("radio")).toHaveLength(3);
      expect(screen.getAllByText(check.why).length).toBeGreaterThan(0);
    }
  });

  it("opens the fix, with its sources, under a no or not sure and closes it for yes", () => {
    render(<AgentSecurityCheckTool />);
    expect(screen.queryByTestId("asc-fix-ui-private")).toBeNull();
    answer(2, "No");
    const fix = screen.getByTestId("asc-fix-ui-private");
    expect(within(fix).getByText('gateway.bind: "loopback"')).toBeInTheDocument();
    expect(within(fix).getByText(/does not list a bind setting/)).toBeInTheDocument();
    expect(within(fix).getByRole("link", { name: "OpenClaw network exposure" })).toHaveAttribute(
      "href",
      "https://docs.openclaw.ai/gateway/security/network-exposure",
    );
    answer(2, "Not sure");
    expect(screen.getByTestId("asc-fix-ui-private")).toBeInTheDocument();
    answer(2, "Yes");
    expect(screen.queryByTestId("asc-fix-ui-private")).toBeNull();
  });

  it("gives commands a copy button and settings none", () => {
    render(<AgentSecurityCheckTool />);
    answer(2, "No");
    const fix = screen.getByTestId("asc-fix-ui-private");
    expect(within(fix).getByRole("button", { name: "Copy: openclaw security audit" })).toBeInTheDocument();
    expect(within(fix).queryByRole("button", { name: /gateway\.bind/ })).toBeNull();
  });

  it("labels spending advice as common practice", () => {
    render(<AgentSecurityCheckTool />);
    answer(1, "No");
    expect(within(screen.getByTestId("asc-fix-spend")).getByText(/common practice, not a step from either project/)).toBeInTheDocument();
  });

  it("keeps the result hidden until all twelve are answered, then shows band and top three", () => {
    render(<AgentSecurityCheckTool />);
    for (let i = 0; i < 11; i++) answer(i, "Yes");
    expect(screen.queryByTestId("asc-result")).toBeNull();
    expect(screen.getByText(/11 of 12 answered/)).toBeInTheDocument();
    answer(11, "Yes");
    const result = screen.getByTestId("asc-result");
    expect(within(result).getByRole("heading", { level: 2, name: "Well covered" })).toBeInTheDocument();
    expect(within(result).getByText(/Nothing is open/)).toBeInTheDocument();
    expect(screen.getByText(/All 12 answered/)).toBeInTheDocument();
  });

  it("lists the top three fixes in order and marks a not sure as to confirm", () => {
    render(<AgentSecurityCheckTool />);
    answerAll("No");
    answer(3, "Not sure");
    const items = within(screen.getByTestId("asc-top")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Keep the control UI off the public internet");
    expect(screen.getByRole("heading", { level: 2, name: "Many open questions" })).toBeInTheDocument();
    expect(screen.getByText(/more open items are marked under their questions/)).toBeInTheDocument();
    answerAll("Not sure");
    expect(within(screen.getByTestId("asc-top")).getAllByRole("listitem")[0]).toHaveTextContent("confirm first");
  });

  it("explains a band that was raised by an exposed UI with no login", () => {
    render(<AgentSecurityCheckTool />);
    answerAll("Yes");
    answer(2, "No");
    answer(3, "No");
    expect(screen.getByRole("heading", { level: 2, name: "Several gaps" })).toBeInTheDocument();
    expect(screen.getByText(/higher than the points alone give because of a control UI that is reachable and has no login/)).toBeInTheDocument();
    expect(within(screen.getByTestId("asc-top")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps Clear answers rendered outside the live region, disabled until something is answered, and returns focus", () => {
    render(<AgentSecurityCheckTool />);
    const clear = screen.getByRole("button", { name: "Clear answers" });
    expect(clear).toBeDisabled();
    expect(clear.closest('[role="status"]')).toBeNull();
    answer(1, "No");
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(screen.getByRole("button", { name: "Clear answers" })).toBeDisabled();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: GROUPS[0].label }));
  });

  it("announces only a short result sentence, not the whole result card", () => {
    render(<AgentSecurityCheckTool />);
    answerAll("Yes");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Result: Well covered");
    expect(screen.getByTestId("asc-result").closest("[aria-live]")).toBeNull();
  });

  it("writes only the answers, as one character each, to the page address", () => {
    render(<AgentSecurityCheckTool />);
    answer(1, "No");
    expect(window.location.search).toBe("?a=-n----------");
    fireEvent.click(screen.getByRole("button", { name: "Clear answers" }));
    expect(window.location.search).toBe("");
  });

  it("reads a shared link and ignores a hand-edited one", () => {
    setAddress(`?${serializeSecurityParams(EXAMPLE_ANSWERS.tidy)}`);
    const { unmount } = render(<AgentSecurityCheckTool />);
    expect(screen.getByRole("heading", { level: 2, name: "Well covered" })).toBeInTheDocument();
    unmount();
    setAddress("?a=%3Cb%3Ehi");
    render(<AgentSecurityCheckTool />);
    expect(screen.getByText(/0 of 12 answered/)).toBeInTheDocument();
  });

  it("keeps other query keys when it writes its own", () => {
    setAddress("?utm_source=x");
    render(<AgentSecurityCheckTool />);
    answer(0, "Yes");
    expect(new URLSearchParams(window.location.search).get("utm_source")).toBe("x");
    expect(new URLSearchParams(window.location.search).get("a")).toBe("y-----------");
  });

  it("states what Hivra does and does not do, and keeps the user's part", () => {
    render(<AgentSecurityCheckTool />);
    const section = screen.getByTestId("asc-hivra");
    expect(within(section).getByRole("heading", { level: 2, name: "What a Hivra computer changes" })).toBeInTheDocument();
    expect(within(section).getByText(/private virtual machine/)).toBeInTheDocument();
    expect(within(section).getByText("What it does not do")).toBeInTheDocument();
    expect(within(section).getByText(/does not stop prompt injection/i)).toBeInTheDocument();
    expect(within(section).getByText(/Still your responsibility/)).toBeInTheDocument();
  });

  it("offers one start button, worded as a statement, with the price and size", () => {
    render(<AgentSecurityCheckTool />);
    const links = screen.getAllByRole("link", { name: /Start an agent on its own Hivra computer/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", PUBLIC_START_HREF);
    expect(screen.getByText(/\$9\.99 a month for 2 vCPU and 4 GB/)).toBeInTheDocument();
  });

  it("makes no banned claim anywhere in its rendered text, with every fix open and a result showing", () => {
    const { container } = render(<AgentSecurityCheckTool />);
    answerAll("No");
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(2000);
    expect(findBannedClaims(text)).toEqual([]);
    expect(unqualifiedKeepRunningClaims(text, /Hivra|always-on (?:box|computer)|managed (?:box|computer)/i)).toEqual([]);
    expect(unknownDashboardNames(text)).toEqual([]);
    expect(text).not.toMatch(/[–—]/);
  });

  it("never fetches", () => {
    const original = global.fetch;
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    render(<AgentSecurityCheckTool />);
    answerAll("No");
    expect(spy).not.toHaveBeenCalled();
    global.fetch = original;
  });
});
