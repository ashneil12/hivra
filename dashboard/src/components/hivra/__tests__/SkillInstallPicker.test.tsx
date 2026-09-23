/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillInstallPicker } from "../SkillInstallPicker";

jest.mock("@/lib/hivra/agent-api", () => ({
  listBoxSkills: async () => [],
}));

const catalog = {
  success: true,
  data: { skills: [{ id: "research", name: "Deep research", description: "Cites sources.", category: "research", installedAs: null }] },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Add skills</button>
      {open ? <SkillInstallPicker agentId="agent-1" boxUrl="https://box.example.com" token="t" onClose={() => setOpen(false)} onInstalled={jest.fn()} /> : null}
    </>
  );
}

async function openPicker() {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Add skills" });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByText("Deep research");
  return trigger;
}

describe("SkillInstallPicker keyboard access", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST"
      ? new Promise<Response>(() => undefined)
      : jsonResponse(catalog))) as unknown as typeof fetch;
  });

  it("moves focus into the dialog and returns it to the trigger on Escape", async () => {
    const trigger = await openPicker();
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(trigger.closest("[inert]")).not.toBeNull();

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Add skills" })).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add skills" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("ignores Escape while skills are installing", async () => {
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    fireEvent.click(screen.getByRole("button", { name: "Install 1" }));
    await screen.findByText("Installing…");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Add skills" })).toBeInTheDocument();
  });
});
