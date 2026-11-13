/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import AgentModelFinderTool from "../AgentModelFinderTool";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { FINDER_ROWS } from "@/lib/tools/agent-tools/agent-model-finder";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const BASE = "/tools/best-free-models-for-ai-agents";
const setAddress = (search = "") => window.history.replaceState(null, "", `${BASE}${search}`);
const bodyRows = () => screen.queryAllByTestId("amf-row");
const firstColumn = () => bodyRows().map((row) => within(row).getByRole("rowheader").textContent ?? "");

beforeEach(() => setAddress());
afterEach(() => setAddress());

describe("AgentModelFinderTool", () => {
  it("renders a real table with every model by default and a status line", () => {
    render(<AgentModelFinderTool />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(FINDER_ROWS.length);
    expect(screen.getByTestId("amf-status")).toHaveTextContent(`${FINDER_ROWS.length} of ${FINDER_ROWS.length} models match.`);
  });

  it("labels every input", () => {
    render(<AgentModelFinderTool />);
    for (const label of ["Minimum context window", "Where", "Search by name", "Private models only", "Reasoning models only", "Accepts image input"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("group", { name: "Price" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /How busy is the agent/ })).toBeInTheDocument();
  });

  it("marks the sort column with aria-sort and flips it on a second press", () => {
    render(<AgentModelFinderTool />);
    const costHeader = screen.getByRole("columnheader", { name: /Est\. cost per agent-day/ });
    expect(costHeader).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: /Input \$\/M/ })).toHaveAttribute("aria-sort", "none");
    fireEvent.click(within(costHeader).getByRole("button"));
    expect(costHeader).toHaveAttribute("aria-sort", "descending");
    const contextHeader = screen.getByRole("columnheader", { name: /Context/ });
    fireEvent.click(within(contextHeader).getByRole("button"));
    expect(contextHeader).toHaveAttribute("aria-sort", "descending");
    expect(costHeader).toHaveAttribute("aria-sort", "none");
    expect(window.location.search).toBe("?sort=context");
  });

  it("sorts by input price low to high", () => {
    render(<AgentModelFinderTool />);
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Input \$\/M/ })).getByRole("button"));
    const prices = bodyRows().map((row) => within(row).getAllByRole("cell")[1].textContent);
    expect(prices[0]).toBe("Free");
  });

  it("free only shows only free rows, each tagged Free, none with a Hivra link", () => {
    render(<AgentModelFinderTool />);
    fireEvent.click(screen.getByLabelText("Free only"));
    const rows = bodyRows();
    expect(rows).toHaveLength(FINDER_ROWS.filter((r) => r.free).length);
    for (const row of rows) {
      expect(row).toHaveTextContent("Free");
      expect(within(row).queryByRole("link")).toBeNull();
    }
    expect(window.location.search).toBe("?price=free");
  });

  it("private only keeps Hivra rows, and the page has exactly one start link", () => {
    render(<AgentModelFinderTool />);
    fireEvent.click(screen.getByLabelText("Private models only"));
    const rows = bodyRows();
    expect(rows).toHaveLength(FINDER_ROWS.filter((r) => r.isPrivate).length);
    for (const row of rows) {
      expect(row).toHaveTextContent("Hivra managed inference");
      expect(within(row).queryByRole("link")).toBeNull();
    }
    const startLinks = screen.getAllByRole("link").filter((a) => a.getAttribute("href") === `${PUBLIC_START_HREF}?agentType=general`);
    expect(startLinks).toHaveLength(1);
  });

  it("keeps unrelated query params and the hash when a filter changes", () => {
    setAddress("?utm=x&price=free#top");
    render(<AgentModelFinderTool />);
    fireEvent.click(screen.getByLabelText("Heavy"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("utm")).toBe("x");
    expect(params.get("price")).toBe("free");
    expect(params.get("usage")).toBe("heavy");
    expect(window.location.hash).toBe("#top");
  });

  it("does not rewrite an unrelated address on mount", () => {
    setAddress("?utm=x#top");
    render(<AgentModelFinderTool />);
    expect(window.location.search).toBe("?utm=x");
    expect(window.location.hash).toBe("#top");
  });

  it("clears back to the bare path when every filter returns to its default", () => {
    render(<AgentModelFinderTool />);
    fireEvent.click(screen.getByLabelText("Free only"));
    expect(window.location.search).toBe("?price=free");
    fireEvent.click(screen.getByLabelText("All models"));
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain("?");
  });

  it("hydrates sort and dir from a link, and ignores junk values", () => {
    setAddress("?sort=name&dir=desc");
    const first = render(<AgentModelFinderTool />);
    expect(screen.getByRole("columnheader", { name: /Model/ })).toHaveAttribute("aria-sort", "descending");
    first.unmount();
    setAddress("?sort=zzz&dir=sideways&price=nope");
    render(<AgentModelFinderTool />);
    expect(screen.getByRole("columnheader", { name: /Est\. cost per agent-day/ })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByLabelText("All models")).toBeChecked();
  });

  it("gives the phone sort button a label that says what pressing does", () => {
    render(<AgentModelFinderTool />);
    const button = screen.getByRole("button", { name: /Sort direction: low to high. Press to reverse./ });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: /Sort direction: high to low/ })).toBeInTheDocument();
  });

  it("the minimum context filter and the where filter narrow the list", () => {
    render(<AgentModelFinderTool />);
    fireEvent.change(screen.getByLabelText("Minimum context window"), { target: { value: "1m" } });
    const afterContext = bodyRows().length;
    expect(afterContext).toBeLessThan(FINDER_ROWS.length);
    fireEvent.change(screen.getByLabelText("Where"), { target: { value: "openrouter" } });
    expect(bodyRows().length).toBeLessThanOrEqual(afterContext);
    for (const row of bodyRows()) expect(row).toHaveTextContent("OpenRouter");
  });

  it("searching by name filters and keeps the text out of the address", () => {
    render(<AgentModelFinderTool />);
    fireEvent.change(screen.getByLabelText("Search by name"), { target: { value: "deepseek" } });
    expect(bodyRows().length).toBeGreaterThan(0);
    for (const name of firstColumn()) expect(name.toLowerCase()).toContain("deepseek");
    expect(window.location.search).toBe("");
  });

  it("shows an empty state when nothing matches", () => {
    render(<AgentModelFinderTool />);
    fireEvent.change(screen.getByLabelText("Search by name"), { target: { value: "zzzz no such model" } });
    expect(bodyRows()).toHaveLength(0);
    expect(screen.getByTestId("amf-status")).toHaveTextContent("No model matches these filters.");
    expect(screen.getAllByText("No model matches these filters.").length).toBeGreaterThan(0);
  });

  it("changing usage changes the stated assumption and the cost column", () => {
    render(<AgentModelFinderTool />);
    expect(screen.getByTestId("amf-usage-plain")).toHaveTextContent("40 messages a day, about 40,000 tokens each");
    fireEvent.click(screen.getByLabelText("Heavy"));
    expect(screen.getByTestId("amf-usage-plain")).toHaveTextContent("150 messages a day");
    expect(window.location.search).toBe("?usage=heavy");
  });

  it("reads a shared link on mount", () => {
    setAddress("?price=free&minctx=200k&sort=context");
    render(<AgentModelFinderTool />);
    expect(screen.getByLabelText("Free only")).toBeChecked();
    expect(screen.getByLabelText("Minimum context window")).toHaveValue("200k");
    expect(screen.getByRole("columnheader", { name: /Context/ })).toHaveAttribute("aria-sort", "descending");
  });

  it("says plainly that free models are rate limited and that retries cost money", () => {
    const { container } = render(<AgentModelFinderTool />);
    expect(container).toHaveTextContent("Free models are rate limited and can change.");
    expect(container).toHaveTextContent("20 requests a minute and 50 a day");
    expect(container).toHaveTextContent("A cheap model that fails tool calls costs more in retries than it saves");
    expect(container).toHaveTextContent("We rank by a stated number only, never by quality.");
  });

  it("names the date of both datasets and offers one start button", () => {
    const { container } = render(<AgentModelFinderTool />);
    expect(container).toHaveTextContent("Hivra's managed inference list, updated");
    expect(container).toHaveTextContent("a copy taken");
    expect(screen.getByRole("link", { name: /Start a Hermes agent on Hivra/ })).toHaveAttribute("href", `${PUBLIC_START_HREF}?agentType=general`);
  });

  it("makes no banned claim in its rendered text", () => {
    const { container } = render(<AgentModelFinderTool />);
    const text = container.textContent ?? "";
    expect(findBannedClaims(text)).toEqual([]);
    expect(unqualifiedKeepRunningClaims(text, /Hivra|always-on (?:box|computer)|managed (?:box|computer)/i)).toEqual([]);
    expect(unknownDashboardNames(text)).toEqual([]);
  });
});
