/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { ComposioKeyPanel } from "../ComposioKeyPanel";
import type { UseComposioKey } from "@/lib/composio/use-composio-connect";

function keyState(overrides: Partial<UseComposioKey> = {}): UseComposioKey {
  return {
    enabled: true,
    loading: false,
    hasKey: true,
    keyPreview: "ck_…9f2a",
    save: jest.fn().mockResolvedValue({ ok: true }),
    remove: jest.fn().mockResolvedValue(true),
    refresh: jest.fn(),
    ...overrides,
  };
}

describe("ComposioKeyPanel", () => {
  it("removes the stored key only after an explicit confirmation", () => {
    const composioKey = keyState();
    render(<ComposioKeyPanel composioKey={composioKey} />);

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(composioKey.remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Remove key\? All connected apps stop working\./i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(composioKey.remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Composio connected/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove key$/i }));
    expect(composioKey.remove).toHaveBeenCalledTimes(1);
  });

  it("gives the key field a done key and no autocapitalize or autocorrect", () => {
    render(<ComposioKeyPanel composioKey={keyState({ hasKey: false, keyPreview: null })} />);

    const input = screen.getByLabelText(/Composio consumer API key/i);
    expect(input).toHaveAttribute("enterkeyhint", "done");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  });
});
