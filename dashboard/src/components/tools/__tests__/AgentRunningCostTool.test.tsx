/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import AgentRunningCostTool from "../AgentRunningCostTool";
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

const BASE = "/tools/ai-agent-running-cost-calculator";
const setAddress = (search = "") => window.history.replaceState(null, "", `${BASE}${search}`);
const total = () => screen.getByTestId("arc-total").textContent;
const verdict = () => screen.getByTestId("arc-verdict").textContent ?? "";
const pick = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

function blockText(container: HTMLElement): string {
  return [...container.querySelectorAll("p, li, h2, h3")].map((el) => el.textContent ?? "").join("\n");
}

beforeEach(() => setAddress());
afterEach(() => setAddress());

describe("AgentRunningCostTool", () => {
  it("renders a full default result: total, split, table and verdict", () => {
    const { container } = render(<AgentRunningCostTool />);
    expect(total()).toBe("$27.97 a month");
    expect(screen.getByRole("img", { name: /Server \$7\.09, Model tokens \$20\.88, Your time \$0\.00/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Monthly cost breakdown" })).toBeInTheDocument();
    expect(verdict()).toMatch(/Model tokens are 75% of this bill/);
    expect(container).toHaveTextContent("Our assumption, not a measurement: 40 messages a day, about 40,000 tokens each");
  });

  it("labels every input", () => {
    render(<AgentRunningCostTool />);
    for (const label of ["Where the agent runs", "Model"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "How busy is the agent?" })).toBeInTheDocument();
  });

  it("lists models from both tables in separate groups", () => {
    render(<AgentRunningCostTool />);
    const select = screen.getByLabelText("Model");
    expect(select.querySelectorAll("optgroup")).toHaveLength(2);
    expect(select.querySelector('option[value="hivra:deepseek-v4-1-flash"]')).not.toBeNull();
    expect(select.querySelector('option[value="openrouter:google/gemma-4-31b-it:free"]')).not.toBeNull();
  });

  it("a laptop and a free model is $0 and the verdict names the limits", () => {
    render(<AgentRunningCostTool />);
    pick("Where the agent runs", "laptop");
    pick("Model", "openrouter:google/gemma-4-31b-it:free");
    expect(total()).toBe("$0.00 a month");
    expect(verdict()).toMatch(/20 requests a minute and 50 a day/);
    expect(screen.getByText(/sleeps when it idles/)).toBeInTheDocument();
  });

  it("changes the total when the usage preset changes, and shows the custom fields only for custom", () => {
    render(<AgentRunningCostTool />);
    expect(screen.queryByLabelText("Messages per day")).toBeNull();
    fireEvent.click(screen.getByLabelText("Light"));
    expect(total()).toBe("$9.70 a month");
    fireEvent.click(screen.getByLabelText("Custom"));
    fireEvent.change(screen.getByLabelText("Messages per day"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Tokens per message"), { target: { value: "20000" } });
    expect(total()).toBe("$9.70 a month");
    fireEvent.change(screen.getByLabelText("Tokens per message"), { target: { value: "40000" } });
    expect(total()).not.toBe("$9.70 a month");
    expect(screen.getByTestId("arc-usage-plain")).toHaveTextContent("10 messages a day, about 40,000 tokens each");
  });

  it("leaves time off by default and adds it when counted", () => {
    render(<AgentRunningCostTool />);
    expect(screen.queryByLabelText("Hours per month")).toBeNull();
    fireEvent.click(screen.getByLabelText("Count my time (off by default)"));
    expect(total()).toBe("$178 a month");
    fireEvent.change(screen.getByLabelText("Hours per month"), { target: { value: "0" } });
    expect(total()).toBe("$27.97 a month");
  });

  it("counts no hours on a Hivra computer and says so", () => {
    render(<AgentRunningCostTool />);
    fireEvent.click(screen.getByLabelText("Count my time (off by default)"));
    pick("Where the agent runs", "hivra-entry");
    expect(screen.getByText(/Hours are not added for a managed computer/)).toBeInTheDocument();
    expect(total()).toBe("$30.87 a month");
    expect(verdict()).toMatch(/DIY is cheaper in dollars/);
  });

  it("the larger Hivra plan verdict does not claim a same-size VPS price", () => {
    render(<AgentRunningCostTool />);
    pick("Where the agent runs", "hivra-larger");
    expect(verdict()).toMatch(/smaller than that/);
    expect(verdict()).not.toMatch(/lists from/);
  });

  it("shows the clamped hours and rate in the note, matching the total", () => {
    render(<AgentRunningCostTool />);
    fireEvent.click(screen.getByLabelText("Count my time (off by default)"));
    fireEvent.change(screen.getByLabelText(/hours/i), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText(/rate|hour/i, { selector: "#arc-rate" }), { target: { value: "5000" } });
    expect(screen.getByText(/200h a month at \$1,000 an hour/)).toBeInTheDocument();
    expect(screen.queryByText(/500h/)).toBeNull();
    expect(total()).toBe("$200,028 a month");
  });

  it("keeps the hash and unrelated query keys with custom usage", () => {
    window.history.replaceState(null, "", `${BASE}?utm_source=x#top`);
    render(<AgentRunningCostTool />);
    fireEvent.click(screen.getByLabelText("Custom"));
    fireEvent.change(screen.getByLabelText(/messages/i), { target: { value: "12" } });
    expect(window.location.search).toContain("utm_source=x");
    expect(window.location.search).toContain("usage=custom");
    expect(window.location.search).toContain("msgs=12");
    expect(window.location.hash).toBe("#top");
  });

  it("writes the structured answers to the address and reads them back from a shared link", () => {
    const { unmount } = render(<AgentRunningCostTool />);
    pick("Where the agent runs", "laptop");
    fireEvent.click(screen.getByLabelText("Heavy"));
    expect(window.location.search).toBe("?server=laptop&usage=heavy");
    unmount();
    render(<AgentRunningCostTool />);
    expect(screen.getByLabelText("Where the agent runs")).toHaveValue("laptop");
    expect(screen.getByLabelText("Heavy")).toBeChecked();
  });

  it("keeps other query keys, ignores hand-edited ones and survives a missing history API", () => {
    setAddress("?utm_source=x&server=evil");
    render(<AgentRunningCostTool />);
    expect(screen.getByLabelText("Where the agent runs")).toHaveValue("hetznerCx23");
    fireEvent.click(screen.getByLabelText("Light"));
    expect(window.location.search).toContain("utm_source=x");
    expect(window.location.search).toContain("usage=light");
    expect(window.location.search).not.toContain("evil");
    const spy = jest.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("no history");
    });
    fireEvent.click(screen.getByLabelText("Heavy"));
    expect(total()).not.toBe("");
    spy.mockRestore();
  });

  it("shows one start button, worded as a statement, without an unsupported AI usage claim", () => {
    const { container } = render(<AgentRunningCostTool />);
    const links = screen.getAllByRole("link", { name: /Start on Hivra/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", PUBLIC_START_HREF);
    expect(container).not.toHaveTextContent(/does not include AI usage/);
  });

  it("sends nothing anywhere", () => {
    const fetchSpy = jest.fn();
    Object.defineProperty(window, "fetch", { value: fetchSpy, configurable: true });
    render(<AgentRunningCostTool />);
    fireEvent.click(screen.getByLabelText("Heavy"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes no banned claim in the rendered text in any state", () => {
    const { container } = render(<AgentRunningCostTool />);
    const check = () => {
      expect(findBannedClaims(container.textContent ?? "")).toEqual([]);
      expect(unqualifiedKeepRunningClaims(blockText(container), /Hivra|managed|always-on (?:box|computer)/i)).toEqual([]);
      expect(unknownDashboardNames(blockText(container))).toEqual([]);
    };
    check();
    for (const server of ["laptop", "vultr1gb", "do4gb", "hivra-entry", "hivra-larger"]) {
      pick("Where the agent runs", server);
      check();
    }
    pick("Model", "openrouter:google/gemma-4-31b-it:free");
    check();
    fireEvent.click(screen.getByLabelText("Count my time (off by default)"));
    check();
    fireEvent.click(screen.getByLabelText("Custom"));
    check();
  });
});
