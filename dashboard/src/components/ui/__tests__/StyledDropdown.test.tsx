/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { StyledDropdown } from "../StyledDropdown";

describe("StyledDropdown", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
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
