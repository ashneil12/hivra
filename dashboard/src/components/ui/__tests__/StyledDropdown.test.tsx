/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { StyledDropdown } from "../StyledDropdown";

function setPointer(fine: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({ matches: query === "(pointer: fine)" ? fine : false, media: query })),
  });
}

const shortOptions = [
  { value: "am", label: "AM" },
  { value: "pm", label: "PM" },
];
const longOptions = Array.from({ length: 12 }, (_, index) => ({ value: `m-${index}`, label: `Model ${index}` }));

describe("StyledDropdown", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("keeps the desktop search row and focuses it with a fine pointer, even for short lists", () => {
    setPointer(true);
    render(<StyledDropdown value="am" onChange={() => {}} options={shortOptions} />);
    fireEvent.click(screen.getByRole("button", { name: "AM" }));
    act(() => { jest.advanceTimersByTime(60); });
    const search = screen.getByPlaceholderText("Search...");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("type", "search");
    expect(search).toHaveAttribute("enterkeyhint", "search");
  });

  it("does not raise the keyboard on touch: no search row for short lists, focus on the selected option", () => {
    setPointer(false);
    render(<StyledDropdown value="pm" onChange={() => {}} options={shortOptions} />);
    fireEvent.click(screen.getByRole("button", { name: "PM" }));
    act(() => { jest.advanceTimersByTime(60); });
    expect(screen.queryByPlaceholderText("Search...")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "PM" })[1]).toHaveFocus();
  });

  it("offers search on touch for long lists without focusing it", () => {
    setPointer(false);
    render(<StyledDropdown value="" onChange={() => {}} options={longOptions} placeholder="Pick a model" />);
    fireEvent.click(screen.getByRole("button", { name: "Pick a model" }));
    act(() => { jest.advanceTimersByTime(60); });
    expect(screen.getByPlaceholderText("Search...")).not.toHaveFocus();
  });

  it("closes on a touch outside the menu", () => {
    setPointer(false);
    render(<StyledDropdown value="am" onChange={() => {}} options={shortOptions} />);
    const trigger = screen.getByRole("button", { name: "AM" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("positions the menu inside the visual viewport so an open keyboard cannot cover it", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { height: 500, offsetTop: 0, addEventListener: jest.fn(), removeEventListener: jest.fn() },
    });
    render(<StyledDropdown value="" onChange={() => {}} options={longOptions} placeholder="Pick a model" />);
    const trigger = screen.getByRole("button", { name: "Pick a model" });
    jest.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 400, bottom: 440, left: 10, right: 210, width: 200, height: 40, x: 10, y: 400, toJSON: () => ({}) });
    fireEvent.click(trigger);
    // Only 48px remain above the keyboard, so the menu opens upward.
    const menu = document.querySelector('[data-hermes-portal-root] div[style*="position: fixed"]');
    expect(menu).toHaveStyle({ top: "76px" });
    expect(window.visualViewport!.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("renders the open menu in a portal and caps the menu height when menuMaxHeight is provided", async () => {
    const options = Array.from({ length: 20 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
    }));

    render(
      <StyledDropdown
        value=""
        onChange={() => {}}
        options={options}
        placeholder="Select model..."
        menuMaxHeight={240}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /select model/i }));

    await waitFor(() => {
      expect(document.querySelector("[data-hermes-portal-root]")).toBeInTheDocument();
    });

    const menu = document.querySelector('div[style*="overflow-y: auto"]');
    expect(menu).toHaveStyle({ maxHeight: "240px" });
    expect(document.querySelector("[data-hermes-portal-root]")).toContainElement(
      screen.getByPlaceholderText("Search...")
    );
  });

  it("uses a capped scrollable menu height by default", async () => {
    const options = Array.from({ length: 20 }, (_, index) => ({
      value: `provider-${index}`,
      label: `Provider ${index}`,
    }));

    render(
      <StyledDropdown
        value=""
        onChange={() => {}}
        options={options}
        placeholder="Select provider..."
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));

    await waitFor(() => {
      const menu = document.querySelector('div[style*="overflow-y: auto"]');
      expect(menu).toHaveStyle({ maxHeight: "320px" });
    });
  });

  it("clears the pending focus timer on unmount", () => {
    const options = [{ value: "model-1", label: "Model 1" }];

    const { unmount } = render(
      <StyledDropdown
        value=""
        onChange={() => {}}
        options={options}
        placeholder="Select model..."
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /select model/i }));

    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });

  it("renders the raw value when it doesn't match any option (saved selection survives a stale options list)", () => {
    // Live failure 2026-05-02: a saved (provider, model) pair was rendered
    // with provider out of the static options list (or model out of the
    // provider-scoped static options), so the dropdown silently fell back
    // to the placeholder ("Select...") and the user thought their save
    // hadn't persisted. The dropdown now shows the raw value so an unknown
    // saved selection is still visible.
    render(
      <StyledDropdown
        value="claude-opus-4-7"
        onChange={() => {}}
        options={[
          { value: "gpt-5.5-all", label: "GPT-5.5 All" },
          { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        ]}
        placeholder="Select model..."
      />,
    );
    // Button label is the raw value, not the placeholder.
    expect(
      screen.getByRole("button", { name: /claude-opus-4-7/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /select model/i })).toBeNull();
  });

  it("still uses placeholder when both value and options are empty", () => {
    render(
      <StyledDropdown
        value=""
        onChange={() => {}}
        options={[]}
        placeholder="Select something..."
      />,
    );
    expect(
      screen.getByRole("button", { name: /select something/i }),
    ).toBeInTheDocument();
  });

  it("renders duplicate option values only once", async () => {
    render(
      <StyledDropdown
        value=""
        onChange={() => {}}
        options={[
          { value: "kimi-k2.6-precision", label: "Kimi K2.6" },
          { value: "kimi-k2.6-precision", label: "Kimi K2.6 duplicate" },
          { value: "glm-5.1", label: "GLM-5.1" },
        ]}
        placeholder="Select model..."
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /select model/i }));

    await waitFor(() => {
      expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    });

    expect(screen.queryByText("Kimi K2.6 duplicate")).not.toBeInTheDocument();
    expect(screen.getByText("GLM-5.1")).toBeInTheDocument();
  });
});
