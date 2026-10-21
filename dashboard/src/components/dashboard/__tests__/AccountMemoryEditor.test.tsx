/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AccountMemoryEditor } from "../AccountMemoryEditor";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe("AccountMemoryEditor", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("shows Saved on the button after a successful save, then Save again after the text changes", async () => {
    let resolvePut: (response: Response) => void = () => {};
    const put = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });

    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return put;
      return jsonResponse({ success: true, data: { content: "hello" } });
    }) as typeof fetch;

    render(<AccountMemoryEditor />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();

    await act(async () => {
      resolvePut(jsonResponse({ success: true, data: { content: "hello" } }));
      await put;
    });

    const saved = await screen.findByRole("button", { name: "Saved" });
    expect(saved).toHaveAttribute("aria-live", "polite");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello!" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Saved" })).not.toBeInTheDocument();
  });
});
