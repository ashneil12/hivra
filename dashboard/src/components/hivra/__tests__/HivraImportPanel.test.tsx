/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HivraImportPanel } from "../manage/HivraImportPanel";

const mockFetch = jest.fn();
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch;
});

const props = {
  cap: { state: "available" } as const,
  boxUrl: "https://box.test",
  token: "box-token",
  agentType: "claude-code",
  agentName: "Claude Code",
};

it("explains the move and mints a transfer prompt the local agent can follow", async () => {
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ supported: true, state: "idle" }))
    .mockResolvedValueOnce(jsonResponse({ token: "hit_abc123", expiresAt: "2026-11-15T15:00:00.000Z" }));
  render(<HivraImportPanel {...props} />);

  expect(screen.getByText("Move an agent from your device")).toBeInTheDocument();
  expect(screen.getByText(/\.claude\.json/)).toBeInTheDocument(); // the transfer list
  const button = await screen.findByRole("button", { name: "Get the transfer prompt" });
  fireEvent.click(button);

  const prompt = await screen.findByText(/Authorization: Bearer hit_abc123/);
  expect(prompt.textContent).toContain("https://box.test/api/import");
  expect(prompt.textContent).toContain("pack and send yourself");
  // The mint went to the box, bearer-authed — never through the dashboard API.
  const mint = mockFetch.mock.calls[1];
  expect(mint[0]).toBe("https://box.test/api/import/token");
  expect(mint[1].headers.Authorization).toBe("Bearer box-token");
});

it("says the box is too old when the import routes are missing", async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
  render(<HivraImportPanel {...props} />);
  expect(await screen.findByText(/can't receive a transfer yet/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Get the transfer prompt" })).not.toBeInTheDocument();
});

it("shows restore progress and the finished result", async () => {
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ supported: true, state: "restoring", detail: "Writing the agent state" }))
    .mockResolvedValueOnce(jsonResponse({ supported: true, state: "done", restored: [".claude", "proj"], skipped: ["junk (not agent state)"], files: 42 }));
  render(<HivraImportPanel {...props} />);
  expect(await screen.findByText(/Restoring the agent's data/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/Restored 42 files/)).toBeInTheDocument(), { timeout: 4000 });
  expect(screen.getByText(/Skipped: junk \(not agent state\)/)).toBeInTheDocument();
});
