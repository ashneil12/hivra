/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { DeepSeekHarnessPreviewPage } from "../DeepSeekHarnessPreviewPage";

describe("DeepSeekHarnessPreviewPage", () => {
  it("says in plain words what DeepSeek Harness is and that it can't be launched yet", () => {
    render(<DeepSeekHarnessPreviewPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("DeepSeek Harness is coming to Hivra.");
    expect(screen.getByText(/It can't be launched yet/)).toBeInTheDocument();
    expect(screen.getByText("Not open for launch yet.")).toBeInTheDocument();
    expect(screen.getByText("Working with other agents", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
    // Back to where the card lives, and on to something that launches today.
    expect(screen.getByRole("link", { name: /Agents/ })).toHaveAttribute("href", "/dashboard/agents#deepseek-harness");
    expect(screen.getByRole("link", { name: /Launch a coding agent/ })).toHaveAttribute("href", "/dashboard/launch?kind=agent&start=1");
  });

  it("claims about the model key only what the preview showed", () => {
    render(<DeepSeekHarnessPreviewPage />);
    const key = screen.getByText("Your model key", { selector: "strong" }).parentElement;

    // Hivra does not deliver this key: the preview entered it in DeepSeek
    // Harness's own settings on its computer, and it never came back to the
    // browser. Nothing showed that it lives nowhere else.
    expect(key).toHaveTextContent("Added in its own settings on its computer, never shown back in your browser.");
    expect(document.body.textContent).not.toMatch(/delivered to its computer/i);
    expect(document.body.textContent).not.toMatch(/kept on its computer only/i);
  });

  it("leaves engineering acceptance notes out of customer copy", () => {
    render(<DeepSeekHarnessPreviewPage />);
    const text = document.body.textContent ?? "";

    expect(text).not.toMatch(/canary|disposable|ACP|PTY|TLS|cookie|revocation|teardown|provisioner|pinned|runtime|gated|pve\d+/i);
    expect(text).not.toMatch(/dashboard\/welcome/);
  });
});
