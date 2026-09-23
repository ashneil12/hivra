/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ModalPicker } from "../ModalPicker";

const options = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

function setPointer(fine: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({ matches: query === "(pointer: fine)" ? fine : false, media: query })),
  });
}

describe("ModalPicker", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
  });

  function openPicker() {
    render(<ModalPicker label="Provider" value="openai" options={options} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Provider/ }));
    act(() => { jest.advanceTimersByTime(20); });
    return screen.getByRole("dialog", { name: "Provider" });
  }

  it("pre-focuses the search with a fine pointer", () => {
    setPointer(true);
    openPicker();
    expect(screen.getByRole("searchbox", { name: "Search options..." })).toHaveFocus();
  });

  it("leaves the keyboard down on touch but still moves focus into the dialog", () => {
    setPointer(false);
    const dialog = openPicker();
    const search = screen.getByRole("searchbox", { name: "Search options..." });
    expect(search).not.toHaveFocus();
    expect(dialog).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(search).toHaveAttribute("enterkeyhint", "search");
    expect(search).toHaveAttribute("autocapitalize", "none");
    expect(search).toHaveAttribute("autocorrect", "off");
  });

  it("gives the close control a 44px target and top-aligns on phones through its overlay class", () => {
    setPointer(false);
    const dialog = openPicker();
    expect(screen.getByRole("button", { name: "Close Provider" })).toHaveStyle({ minWidth: "44px", minHeight: "44px" });
    expect(dialog.parentElement).toHaveClass("hivra-modal-picker-overlay");
    expect(screen.getByText("Provider", { selector: "label" })).toHaveStyle({ fontSize: "11px" });
  });
});
