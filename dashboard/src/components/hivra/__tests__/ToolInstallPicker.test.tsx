/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolInstallPicker } from "../ToolInstallPicker";

jest.mock("@/lib/hivra/agent-api", () => ({
  listBoxMcp: async () => ({ servers: [] }),
}));

const catalog = {
  success: true,
  data: {
    tools: [{ id: "coingecko", name: "CoinGecko", description: "Crypto prices.", category: "crypto", trust: "trusted", mcpName: "coingecko", env: [], skillCount: 0 }],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Browse tools</button>
      <button type="button">After the tools card</button>
      {open ? <ToolInstallPicker agentId="agent-1" boxUrl="https://box.example.com" token="t" onClose={() => setOpen(false)} onChanged={jest.fn()} /> : null}
    </>
  );
}

async function openPicker() {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Browse tools" });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByText("CoinGecko");
  return { trigger, dialog: screen.getByRole("dialog", { name: "Add tools" }) };
}

describe("ToolInstallPicker keyboard access", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST"
      ? new Promise<Response>(() => undefined)
      : jsonResponse(catalog))) as unknown as typeof fetch;
  });

  it("moves focus into the dialog, wraps Tab inside it and hides the page behind it", async () => {
    const { trigger, dialog } = await openPicker();
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(trigger.closest("[inert]")).not.toBeNull();

    const done = screen.getByRole("button", { name: "Done" });
    done.focus();
    fireEvent.keyDown(done, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(done).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { trigger } = await openPicker();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add tools" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(trigger.closest("[inert]")).toBeNull();
  });

  it("ignores Escape while an install is in flight", async () => {
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /Install/ }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Add tools" })).toBeInTheDocument();
  });

  it("keeps typed credentials: Escape does not close until the field is cleared", async () => {
    const keyed = { ...catalog.data.tools[0], id: "github", name: "GitHub", mcpName: "github",
      env: [{ key: "GITHUB_TOKEN", label: "Token", secret: true, required: true }] };
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: { tools: [keyed] } })) as unknown as typeof fetch;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Browse tools" }));
    const token = await screen.findByPlaceholderText("GITHUB_TOKEN");
    fireEvent.change(token, { target: { value: "ghp_secret" } });
    fireEvent.keyDown(token, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Add tools" })).toBeInTheDocument();
    expect(token).toHaveValue("ghp_secret");

    fireEvent.change(token, { target: { value: "" } });
    fireEvent.keyDown(token, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add tools" })).not.toBeInTheDocument());
  });

  it("sizes the overlay to the visible viewport instead of the full layout viewport", async () => {
    const { dialog } = await openPicker();
    expect(dialog).toHaveStyle({ top: "0px", height: "var(--workspace-viewport-height, 100dvh)" });
    expect(dialog.style.bottom).toBe("");
  });
});
