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

  it("offers one primary launch route and retains the complete runtime catalog", async () => {
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
      screen.getByText("Browse agent runtimes").closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Browse agent runtimes"));
    expect(
      screen.getByRole("link", { name: "Open full runtime catalog" }),
    ).toHaveAttribute("href", "/dashboard/welcome?step=agent-type");
    expect(
      screen.getByRole("link", { name: "Inspect runtime" }),
    ).toHaveAttribute("href", "/dashboard/runtimes/deepseek-harness");
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
