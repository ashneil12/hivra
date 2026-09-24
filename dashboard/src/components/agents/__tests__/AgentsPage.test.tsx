/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentsPage } from "../AgentsPage";

const pushMock = jest.fn();
const listAgentsResultMock = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
jest.mock("@/lib/hivra/agent-api", () => ({
  listAgentsResult: () => listAgentsResultMock(),
}));

describe("AgentsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listAgentsResultMock.mockResolvedValue({ agents: [], error: null });
    global.fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });
  });

  it("offers one primary launch route and opens each catalog agent's own plan in Launch", async () => {
    render(<AgentsPage />);
    await screen.findByRole("heading", { name: "No agents yet" });
    expect(screen.getByRole("link", { name: "Launch agent" })).toHaveAttribute(
      "href",
      "/dashboard/launch?kind=agent&start=1",
    );
    expect(
      screen.queryByRole("button", { name: /deploy/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Browse agents you can launch").closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Browse agents you can launch"));
    for (const [name, profile] of [
      ["Hermes", "hermes"],
      ["Claude Code", "claude-code"],
      ["Codex", "codex"],
      ["Aeon", "aeon"],
      ["OpenClaw", "openclaw"],
      ["Agent Zero", "agent-zero"],
    ]) {
      expect(screen.getByRole("link", { name: `Launch ${name}` })).toHaveAttribute(
        "href",
        `/dashboard/launch?kind=agent&start=1&profile=${profile}`,
      );
    }
    // A row that can't be acted on is never listed as if it could.
    expect(screen.queryByText("Available to configure")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Launch DeepSeek/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /full runtime catalog/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="/dashboard/welcome"]')).toBeNull();
  });

  it("describes the DeepSeek preview in plain words, without engineering notes", async () => {
    render(<AgentsPage />);
    await screen.findByRole("heading", { name: "No agents yet" });
    fireEvent.click(screen.getByText("Browse agents you can launch"));
    const card = screen.getByRole("heading", { name: "DeepSeek Harness" }).closest("article") as HTMLElement;
    expect(card).toHaveTextContent("Private preview");
    expect(card).toHaveTextContent("can't be launched yet");
    expect(card.textContent).not.toMatch(/canary|PTY|ACP|teardown|revocation|gated|runtime/i);
    expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute(
      "href",
      "/dashboard/runtimes/deepseek-harness",
    );
  });

  it("brings an opened runtime catalog below the fold to the top under its heading", async () => {
    const scroll = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<AgentsPage />);
      await screen.findByRole("heading", { name: "No agents yet" });
      const details = screen.getByText("Browse agents you can launch").closest("details") as HTMLDetailsElement;
      const body = details.querySelector("div") as HTMLElement;
      const top = jest.spyOn(body, "getBoundingClientRect");

      // Opened with its first entries already on screen: the page stays put.
      top.mockReturnValue({ top: 200 } as DOMRect);
      details.open = true;
      fireEvent(details, new Event("toggle"));
      expect(scroll).not.toHaveBeenCalled();

      // Opened at the bottom edge: the heading (and its collapse control) goes
      // to the top, not the body, so the tapped summary stays visible.
      details.open = false;
      fireEvent(details, new Event("toggle"));
      top.mockReturnValue({ top: window.innerHeight - 40 } as DOMRect);
      details.open = true;
      fireEvent(details, new Event("toggle"));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      expect(scroll.mock.instances[0]).toBe(details);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("opens the existing Hermes detail route from the merged inventory", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input) =>
      String(input).includes("browser-sessions")
        ? { ok: false }
        : {
            ok: true,
            json: async () => ({
              success: true,
              data: [
                {
                  id: "hermes-1",
                  name: "Research",
                  status: "running",
                  provider: "venice",
                  config: { model: "research-model" },
                },
              ],
            }),
          },
    );
    render(<AgentsPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Open Research/ }),
    );
    expect(pushMock).toHaveBeenCalledWith("/dashboard/instances/hermes-1");
    expect(screen.getByText("Hermes · research-model")).toBeInTheDocument();
  });

  it("does not report zero agents when the Hermes projection fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({
        success: false,
        error: "Hermes inventory unavailable",
      }),
    });
    render(<AgentsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Hermes inventory unavailable",
    );
    expect(screen.queryByText("No agents yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
