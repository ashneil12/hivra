/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { desktopClipboardCopy, desktopClipboardPaste, desktopClipboardSet } from "@/lib/hivra/agent-api";
import { DesktopClipboard } from "../DesktopClipboard";

jest.mock("@/lib/hivra/agent-api", () => ({
  desktopClipboardSet: jest.fn(),
  desktopClipboardPaste: jest.fn(),
  desktopClipboardCopy: jest.fn(),
}));
jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: jest.fn() }));
jest.mock("../ClaudeAppSwitch.module.css", () => new Proxy({}, { get: (_target, key) => String(key) }));

const readText = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
  jest.mocked(desktopClipboardSet).mockImplementation(async (_box, enabled) => ({ ok: true, clipboard: enabled, error: null }));
  jest.mocked(desktopClipboardPaste).mockResolvedValue({ ok: true, error: null });
  jest.mocked(copyTextToClipboard).mockResolvedValue(true);
});

const mount = (enabled: boolean, onChanged = jest.fn()) => {
  render(<DesktopClipboard boxUrl="https://box.example" token="t" enabled={enabled} onChanged={onChanged} />);
  return onChanged;
};

it("is off by default and shows no transfer buttons while off", () => {
  mount(false);
  expect(screen.getByRole("button", { name: "Clipboard off" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("button", { name: /Paste in/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Copy out/ })).toBeNull();
});

it("turns on with one click and reports the new state", async () => {
  const onChanged = mount(false);
  fireEvent.click(screen.getByRole("button", { name: "Clipboard off" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(true));
  expect(desktopClipboardSet).toHaveBeenCalledWith("https://box.example", true, "t");
});

it("turns off with one click", async () => {
  const onChanged = mount(true);
  fireEvent.click(screen.getByRole("button", { name: "Clipboard on" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(false));
  expect(desktopClipboardSet).toHaveBeenCalledWith("https://box.example", false, "t");
});

it("pastes the owner's clipboard into the desktop", async () => {
  readText.mockResolvedValue("npm test");
  mount(true);
  fireEvent.click(screen.getByRole("button", { name: /Paste in/ }));
  await waitFor(() => expect(desktopClipboardPaste).toHaveBeenCalledWith("https://box.example", "npm test", "t"));
  expect(await screen.findByText(/Press Ctrl\+V in the desktop/)).toBeTruthy();
});

it("offers a box when the browser will not share its clipboard", async () => {
  readText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  mount(true);
  fireEvent.click(screen.getByRole("button", { name: /Paste in/ }));
  const box = await screen.findByRole("textbox", { name: "Text to paste into the desktop" });
  expect(desktopClipboardPaste).not.toHaveBeenCalled();
  fireEvent.change(box, { target: { value: "typed by hand" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to desktop" }));
  await waitFor(() => expect(desktopClipboardPaste).toHaveBeenCalledWith("https://box.example", "typed by hand", "t"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("copies the desktop clipboard out", async () => {
  jest.mocked(desktopClipboardCopy).mockResolvedValue({ ok: true, text: "from the desktop", error: null });
  mount(true);
  fireEvent.click(screen.getByRole("button", { name: /Copy out/ }));
  await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith("from the desktop"));
  expect(await screen.findByText("Copied to your clipboard.")).toBeTruthy();
});

it("shows the text selected when the browser blocks copying", async () => {
  jest.mocked(desktopClipboardCopy).mockResolvedValue({ ok: true, text: "from the desktop", error: null });
  jest.mocked(copyTextToClipboard).mockResolvedValue(false);
  mount(true);
  fireEvent.click(screen.getByRole("button", { name: /Copy out/ }));
  expect((await screen.findByRole("textbox", { name: "Text from the desktop" }) as HTMLTextAreaElement).value).toBe("from the desktop");
});

it("shows the computer's own reason when a transfer is refused", async () => {
  jest.mocked(desktopClipboardCopy).mockResolvedValue({ ok: false, error: "The clipboard is off for this computer. Turn it on first." });
  mount(true);
  fireEvent.click(screen.getByRole("button", { name: /Copy out/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("clipboard is off");
  expect(copyTextToClipboard).not.toHaveBeenCalled();
});
