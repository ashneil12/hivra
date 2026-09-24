/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockLaunch = jest.fn();
const mockModels = jest.fn();
const mockBalance = jest.fn();

jest.mock("@/lib/hivra/managed-session-client", () => {
  const actual = jest.requireActual("@/lib/hivra/managed-session-client");
  return {
    ...actual,
    launchManagedSession: (...args: unknown[]) => mockLaunch(...args),
    listDigitalOceanModels: (...args: unknown[]) => mockModels(...args),
    getDigitalOceanBalance: (...args: unknown[]) => mockBalance(...args),
  };
});

import { DigitalOceanLaunchDialog } from "../DigitalOceanLaunchDialog";
import type { DigitalOceanConnectionDto, DigitalOceanDeploymentTargetDto } from "@/lib/infrastructure/contracts";

const CONNECTION = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const connection = { id: CONNECTION, name: "Team", provider: "digitalocean" } as unknown as DigitalOceanConnectionDto;
const target = {
  id: TARGET, connectionId: CONNECTION, status: "ready",
  capacity: { model: "serverless-sessions", sizes: [{ slug: "mars-2vcpu-4gb", vcpus: 2, memoryMb: 4096 }] },
  capabilities: { harnesses: ["claude-code", "codex", "hermes"], sizes: ["mars-2vcpu-4gb"] },
} as unknown as DigitalOceanDeploymentTargetDto;
const KEY = "do-model-" + "k".repeat(30);

beforeEach(() => {
  mockLaunch.mockReset();
  mockModels.mockReset();
  mockBalance.mockReset().mockResolvedValue({ state: "ok", balance: "25.00", autoPrepay: false, checkedAt: "2026-09-24T00:00:00.000Z" });
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => "44444444-4444-4444-8444-444444444444";
});

it("names the agent after its runtime and offers DigitalOcean's models in a list", async () => {
  mockModels.mockResolvedValueOnce(["deepseek-v4-pro", "llama3.3-70b-instruct"]);
  mockLaunch.mockResolvedValueOnce({ agentId: "a", name: "Hermes 1", status: "ready" });
  render(<DigitalOceanLaunchDialog connection={connection} target={target} onClose={jest.fn()} onLaunched={jest.fn()} />);
  expect(screen.getByDisplayValue("Claude Code 1")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/Hermes/));
  expect(screen.getByDisplayValue("Hermes 1")).toBeInTheDocument();

  const picker = await screen.findByLabelText(/^DigitalOcean model(?! access)/);
  await waitFor(() => expect(picker).toHaveValue("deepseek-v4-pro"));
  fireEvent.change(picker, { target: { value: "llama3.3-70b-instruct" } });
  fireEvent.change(screen.getByLabelText(/DigitalOcean model access key/), { target: { value: KEY } });
  fireEvent.click(screen.getByRole("button", { name: /Launch and start billing/ }));
  await waitFor(() => expect(mockLaunch).toHaveBeenCalled());
  expect(mockModels).toHaveBeenCalledWith(CONNECTION, expect.anything());
  expect(mockLaunch.mock.calls[0][0]).toMatchObject({
    harness: "hermes", name: "Hermes 1", model: { mode: "digitalocean-inference", apiKey: KEY, model: "llama3.3-70b-instruct" },
  });
});

it("falls back to typing a model id when DigitalOcean's list is unavailable", async () => {
  mockModels.mockRejectedValueOnce(new Error("DigitalOcean rejected the saved token."));
  render(<DigitalOceanLaunchDialog connection={connection} target={target} onClose={jest.fn()} onLaunched={jest.fn()} />);
  fireEvent.click(screen.getByLabelText(/Hermes/));
  expect(await screen.findByText(/Enter the model id instead/)).toBeInTheDocument();
  expect(screen.getByLabelText("Model id")).toBeInTheDocument();
});

it("says before launch that Hivra sends a visible setup note that uses a little usage (ATT-13)", () => {
  render(<DigitalOceanLaunchDialog connection={connection} target={target} onClose={jest.fn()} onLaunched={jest.fn()} />);
  expect(screen.getByTestId("digitalocean-setup-note-disclosure")).toHaveTextContent(
    "Hivra first sends the agent a short setup note, as a visible message in the chat: where it runs, its /workspace and how you see its work. The agent replies once, which uses a little of your DigitalOcean and model usage.",
  );
  expect(screen.getByText("Sent once the session is ready, right after Hivra's setup note.")).toBeInTheDocument();
});

it("warns up front when the prepaid balance is empty", async () => {
  mockBalance.mockResolvedValueOnce({ state: "empty", balance: "0.00", autoPrepay: false, checkedAt: "2026-09-24T00:00:00.000Z" });
  render(<DigitalOceanLaunchDialog connection={connection} target={target} onClose={jest.fn()} onLaunched={jest.fn()} />);
  expect(await screen.findByText(/prepaid Managed Agents balance is empty/)).toBeInTheDocument();
  expect(screen.getByText(/won’t start this agent until you add funds/)).toBeInTheDocument();
});
