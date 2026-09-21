/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { DeepSeekHarnessPreviewPage } from "../DeepSeekHarnessPreviewPage";

describe("DeepSeekHarnessPreviewPage", () => {
  it("shows implemented runtime evidence and keeps launch gated", () => {
    render(<DeepSeekHarnessPreviewPage />);

    expect(screen.getByRole("heading", { name: /deepseek harness, without pretending/i })).toBeTruthy();
    expect(screen.getByText("@deepseek-ai/dsh@0.1.2-alpha.2")).toBeTruthy();
    expect(screen.getByText(/no launch button yet/i)).toBeTruthy();
    expect(screen.getByText(/disposable Canary computer passed/i)).toBeTruthy();
    expect(screen.getByText(/ACP remains unverified/i)).toBeTruthy();
    expect(screen.getByText(/public TLS, fresh authenticated cookie/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /inspect computer capacity/i })).toHaveAttribute("href", "/dashboard/infrastructure");
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/pve\d+/i);
  });
});
