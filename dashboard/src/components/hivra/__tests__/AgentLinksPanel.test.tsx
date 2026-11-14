/** @jest-environment jsdom */
// Manage → which computers an agent may use, and which agents may use a
// computer: links from either end, "Link all", Remove, and whether the agent
// has been told. Nothing shows where links aren't offered.
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentLinksPanel } from "../AgentLinksPanel";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDIO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OMARCHY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const calls: Array<{ url: string; init?: RequestInit }> = [];
let views: unknown[] = [];

function agentView(overrides: Record<string, unknown> = {}) {
  return { subject: { id: AGENT, kind: "agent", available: true }, links: [],
    candidates: [
      { id: STUDIO, name: "Studio", kind: "Ubuntu desktop", linked: false, available: true },
      { id: OMARCHY, name: "Arch", kind: "Omarchy desktop", linked: false, available: true },
      { id: "w", name: "Win", kind: "Windows", linked: false, available: false, reason: "Agents can't use Windows computers yet." },
    ], kit: { state: "not_needed" }, ...overrides };
}

beforeEach(() => {
  calls.length = 0;
  views = [];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
    if (String(url).startsWith("/api/hivra/agent-links?id=")) {
      const view = views.length > 1 ? views.shift() : views[0];
      return view === 404 ? reply(404, {}) : reply(200, { success: true, data: view });
    }
    return reply(201, { success: true, data: {} });
  }) as typeof fetch;
});

describe("AgentLinksPanel", () => {
  it("shows nothing where links aren't offered", async () => {
    views = [404];
    const { container } = render(<AgentLinksPanel subjectId={AGENT} subjectName="Claude" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("links one computer, or all of them, from the agent's page", async () => {
    views = [agentView()];
    render(<AgentLinksPanel subjectId={AGENT} subjectName="Claude" />);
    expect(await screen.findByText("Computers this agent can use")).toBeInTheDocument();
    expect(screen.getByText(/Agents can't use Windows computers yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Computer to link"), { target: { value: OMARCHY } });
    fireEvent.click(screen.getByRole("button", { name: /^Link$/ }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
    const post = calls.find((call) => call.init?.method === "POST")!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ agentId: AGENT, computerId: OMARCHY, from: "agent" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Link all my computers" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Link all my computers" }));
    await waitFor(() => expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(2));
    expect(JSON.parse(String(calls.filter((call) => call.init?.method === "POST")[1].init?.body))).toEqual({ agentId: AGENT, all: true, from: "agent" });
  });

  it("lists linked computers with Remove and says the agent knows about them", async () => {
    views = [agentView({
      links: [{ id: "link-1", agentId: AGENT, agentName: "Claude", computerId: STUDIO, computerName: "Studio", computerKind: "Ubuntu desktop",
        createdAt: "2026-10-19T10:00:00Z", lastUsedAt: null }],
      kit: { state: "delivered" },
    })];
    render(<AgentLinksPanel subjectId={AGENT} subjectName="Claude" />);
    expect(await screen.findByText("Studio")).toBeInTheDocument();
    expect(screen.getByText(/The agent knows about these computers/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Studio" }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
    expect(calls.find((call) => call.init?.method === "DELETE")?.url).toBe("/api/hivra/agent-links/link-1");
  });

  it("tells apart two computers with the same name", async () => {
    views = [agentView({ candidates: [
      { id: STUDIO, name: "My Ubuntu", kind: "Ubuntu desktop", status: "stopped", linked: false, available: true },
      { id: OMARCHY, name: "My Ubuntu", kind: "Ubuntu desktop", status: "running", linked: false, available: true },
      { id: "e", name: "Arch", kind: "Omarchy desktop", status: "running", linked: false, available: true },
    ] })];
    render(<AgentLinksPanel subjectId={AGENT} subjectName="Claude" />);
    expect(await screen.findByRole("option", { name: "My Ubuntu (Ubuntu desktop, stopped, cccccccc)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "My Ubuntu (Ubuntu desktop, running, dddddddd)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Arch (Omarchy desktop)" })).toBeInTheDocument();
  });

  it("links agents from the computer's page", async () => {
    views = [{ subject: { id: STUDIO, kind: "computer", available: true }, links: [],
      candidates: [{ id: AGENT, name: "Claude", kind: "claude-code", linked: false, available: true }] }];
    render(<AgentLinksPanel subjectId={STUDIO} subjectName="Studio" />);
    expect(await screen.findByText("Agents that can use this computer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Link$/ }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "POST")?.init?.body))).toEqual({ agentId: AGENT, computerId: STUDIO, from: "computer" });
  });
});
