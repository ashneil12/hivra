/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { LaunchModelControl } from "../LaunchModelControl";
import type { useModelLaunch } from "../useModelLaunch";

function launch(selfManaged: boolean, confirmed: boolean): ReturnType<typeof useModelLaunch> {
  return {
    ownerId: "fixture-owner", ready: true, busy: false, editing: false, error: null,
    saved: { requestId: "11111111-1111-4111-8111-111111111111", intent: {
      type: "codex", name: "SAVED_AGENT", cpu: 0.5, ram: 1, browser: false,
      deployment: selfManaged ? { mode: "self-managed", connectionId: "44444444-4444-4444-8444-444444444444", targetId: "22222222-2222-4222-8222-222222222222", expectedConnectionRevision: 1 } : { mode: "hivra-managed" },
      llm: { provider: "venice", mode: "managed", model: "fixture-model", walletType: "card" },
    } },
    agent: confirmed ? { id: "33333333-3333-4333-8333-333333333333", type: "codex", name: "SAVED_AGENT", status: "running", cpu: 2, ram: 4 } : null,
    submit: jest.fn(), check: jest.fn(), startAnother: jest.fn(), reviewChoices: jest.fn(),
  };
}

it.each([[true, false], [false, false], [true, true]])("shows actual capacity or honest saved intent (self-managed=%s confirmed=%s)", (selfManaged, confirmed) => {
  render(<LaunchModelControl draft={{ mode: "managed", model: "fixture-model", apiKey: "", walletType: "card" }}
    launch={launch(selfManaged, confirmed)} onChange={jest.fn()} onOpen={jest.fn()} onReview={jest.fn()} disabled={false} supported />);
  expect(screen.getByText(`SAVED_AGENT · ${confirmed ? "2 CPU / 4 GB" : selfManaged ? "Using your selected infrastructure" : "0.5 CPU / 1 GB"}`)).toBeInTheDocument();
  if (selfManaged) expect(screen.queryByText(/0.5 CPU \/ 1 GB/)).not.toBeInTheDocument();
});

it("removes Hivra model credits from a standalone launch", () => {
  render(<LaunchModelControl draft={{ mode: "native", model: "fixture-model", apiKey: "", walletType: "card" }}
    launch={{ ...launch(true, false), saved: null }} onChange={jest.fn()} onOpen={jest.fn()} onReview={jest.fn()}
    disabled={false} supported allowManaged={false} />);
  expect(screen.getByRole("button", { name: /Native sign-in/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /My Venice API key/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Hivra model credits/i })).not.toBeInTheDocument();
});

it("keeps phone keyboards from capitalizing the Venice model ID", () => {
  render(<LaunchModelControl draft={{ mode: "byok", model: "deepseek-v4-pro", apiKey: "", walletType: "card" }}
    launch={{ ...launch(true, false), saved: null }} onChange={jest.fn()} onOpen={jest.fn()} onReview={jest.fn()}
    disabled={false} supported />);
  const modelId = screen.getByRole("textbox", { name: /Venice model ID/i });
  expect(modelId).toHaveAttribute("autocapitalize", "none");
  expect(modelId).toHaveAttribute("autocorrect", "off");
  expect(modelId).toHaveAttribute("enterkeyhint", "done");
});
