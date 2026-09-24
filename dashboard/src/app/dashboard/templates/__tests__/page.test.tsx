/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import TemplatesPage from "../page";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

jest.mock("@/components/layout/DashboardPageShell", () => ({
  DashboardPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/lib/client/clipboard", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

const TEMPLATE = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "research-bot",
  type: "claude-code",
  name: "Research Bot",
  goal: "research",
  personality: "calm",
  emoji: null,
  visibility: "private",
  share_token: null,
  created_at: "2026-09-01T00:00:00Z",
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("TemplatesPage", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/hivra/agents") return jsonResponse({ success: true, data: { agents: [] } });
      if (url === "/api/hivra/templates") return jsonResponse({ success: true, data: { templates: [TEMPLATE] } });
      if (url === `/api/hivra/templates/${TEMPLATE.id}` && init?.method === "DELETE") {
        return jsonResponse({ success: true, data: {} });
      }
      if (url === `/api/hivra/templates/${TEMPLATE.id}` && init?.method === "PATCH") {
        const { visibility } = JSON.parse(String(init.body));
        return jsonResponse({ success: true, data: { template: { ...TEMPLATE, visibility, share_token: "abc123" } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  function mutationCalls(method: string) {
    return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);
  }

  it("asks before deleting a template and only deletes on the second tap", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Research Bot");

    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    expect(mutationCalls("DELETE")).toHaveLength(0);
    const confirm = screen.getByRole("group", { name: "Confirm delete" });
    // The trash button is gone; focus lands on the safe choice in its place.
    const cancel = within(confirm).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    fireEvent.click(cancel);
    expect(screen.queryByRole("group", { name: "Confirm delete" })).not.toBeInTheDocument();
    expect(mutationCalls("DELETE")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Delete template" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: /Delete\?/ }));

    await waitFor(() => expect(screen.queryByText("Research Bot")).not.toBeInTheDocument());
    expect(mutationCalls("DELETE")).toHaveLength(1);
  });

  it("confirms inline before publishing a template publicly", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Research Bot");
    expect(screen.getByText(/switch to Link or Public to create a share link/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /public/i }));
    expect(mutationCalls("PATCH")).toHaveLength(0);
    const confirm = screen.getByRole("group", { name: "Confirm public template" });
    expect(confirm).toHaveTextContent(/can be found and launched by anyone/i);

    fireEvent.click(within(confirm).getByRole("button", { name: /Make public/i }));

    await waitFor(() => expect(mutationCalls("PATCH")).toHaveLength(1));
    expect(JSON.parse(String((mutationCalls("PATCH")[0][1] as RequestInit).body))).toEqual({ visibility: "public" });
    await waitFor(() => expect(screen.getByRole("button", { name: /public/i })).toHaveAttribute("aria-pressed", "true"));
  });

  it("switches to a share link without an extra confirmation", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Research Bot");

    fireEvent.click(screen.getByRole("button", { name: /^link$/i }));

    await waitFor(() => expect(mutationCalls("PATCH")).toHaveLength(1));
    expect(JSON.parse(String((mutationCalls("PATCH")[0][1] as RequestInit).body))).toEqual({ visibility: "link" });
  });

  it("hands the template to the welcome flow on Launch", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Research Bot");

    fireEvent.click(screen.getByRole("button", { name: /launch/i }));

    expect(pushMock).toHaveBeenCalledWith(`/dashboard/launch?start=1&template=${TEMPLATE.id}`);
  });
});
