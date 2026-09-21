/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentModelSettings } from "../AgentModelSettings";
import { AgentModelSettingsError, cancelAgentLaunchModel, continueAgentLaunchModel, getAgentModelSettings, resumeAgentModelSettings, setAgentModelSettings } from "@/lib/hivra/agent-model-settings-api";

jest.mock("@/lib/hivra/agent-model-settings-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-model-settings-api"),
  getAgentModelSettings: jest.fn(), resumeAgentModelSettings: jest.fn(), setAgentModelSettings: jest.fn(),
  cancelAgentLaunchModel: jest.fn(), continueAgentLaunchModel: jest.fn(),
}));
const read = jest.mocked(getAgentModelSettings), save = jest.mocked(setAgentModelSettings), resume = jest.mocked(resumeAgentModelSettings);
const continueLaunch = jest.mocked(continueAgentLaunchModel), cancelLaunch = jest.mocked(cancelAgentLaunchModel);
const op = "00000000-0000-4000-8000-000000001031";
const requestId = "00000000-0000-4000-8000-000000001011";
const launch = { requestId, operationId: op, createdAt: "2026-08-28T00:00:00Z", state: "needs_attention" as const,
  requested: { provider: "venice" as const, mode: "byok" as const, model: "fixture-model" } };
const config = { provider: "venice" as const, mode: "managed" as const, model: "test-model", keyPrefix: "fixture", walletType: "card" as const, enabledAt: "2026-08-28T00:00:00Z" };
const pending = { operationId: op, requested: { ...config, mode: "byok" as const }, createdAt: "2026-08-28T00:00:00Z", applying: false };
const props = { agentId: "agent-fixture", agentName: "Codex", ready: true, disabled: false, onChanged: jest.fn(), onBusyChange: jest.fn() };
beforeEach(() => {
  jest.clearAllMocks(); read.mockResolvedValue({ llm: null, pending: null });
  save.mockResolvedValue({ operationId: op, status: "applied" }); resume.mockResolvedValue({ operationId: op, status: "applied" });
  continueLaunch.mockResolvedValue({ requestId, operationId: op, status: "pending" });
  cancelLaunch.mockResolvedValue({ requestId, status: "cancelled" });
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => op });
});
async function mount() {
  const view = render(<AgentModelSettings {...props} />);
  await waitFor(() => expect(screen.getByText("Native sign-in")).toBeInTheDocument());
  return view;
}
const enterKey = () => fireEvent.change(screen.getByLabelText("Venice API key"), { target: { value: "synthetic-fixture-key" } });

it.each(["Codex", "OpenClaw", "Agent Zero"])("names %s in the native sign-in guidance", async agentName => {
  render(<AgentModelSettings {...props} agentName={agentName} />);
  await screen.findByText("Native sign-in");
  expect(screen.getByText(`These settings connect Hivra Chat. The native ${agentName} interface keeps its own sign-in and configuration.`)).toBeInTheDocument();
  if (agentName !== "Codex") expect(screen.queryByText(/native Codex/)).not.toBeInTheDocument();
});

it("reads saved metadata without claiming guest confirmation, with labeled optional fields", async () => {
  let complete!: (v: { llm: null; pending: null }) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  render(<AgentModelSettings {...props} />);
  expect(screen.getByText("Checking saved settings…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  await act(async () => complete({ llm: null, pending: null }));
  expect(screen.getByText("Saved setting")).toBeInTheDocument();
  expect(screen.getByText(/not a live inference check/)).toBeInTheDocument();
  expect(screen.queryByText(/Last confirmed/)).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Model/)).toBeInTheDocument();
  expect(screen.getByLabelText("Venice API key")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("Venice API key")).toHaveAttribute("autocomplete", "off");
});

it("sends a single server request, wipes the submitted key, and refreshes confirmed metadata", async () => {
  await mount(); enterKey();
  read.mockResolvedValue({ llm: { ...config, mode: "byok" }, pending: null });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(props.agentId, op, { provider: "venice", mode: "byok", apiKey: "synthetic-fixture-key" }, { signal: expect.any(AbortSignal) });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Setting confirmed"));
  expect(screen.getByLabelText("Venice API key")).toHaveValue("");
  expect(read).toHaveBeenCalledTimes(2); expect(props.onChanged).toHaveBeenCalledTimes(1);
  expect(props.onBusyChange.mock.calls).toEqual([[true], [false]]);
  expect(screen.getByText("Replace your connection")).toBeInTheDocument();
});

it("keeps saved and pending settings distinct, and resumes without a key", async () => {
  read.mockResolvedValue({ llm: config, pending });
  render(<AgentModelSettings {...props} />);
  await screen.findByText("Pending change");
  expect(screen.getByText("Venice · managed gateway · test-model · fixture…")).toBeInTheDocument();
  expect(screen.getByText("Venice · your API key · test-model")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  read.mockResolvedValue({ llm: { ...config, mode: "byok" }, pending: null });
  fireEvent.click(screen.getByRole("button", { name: "Resume change" }));
  await waitFor(() => expect(resume).toHaveBeenCalledWith(props.agentId, op, { signal: expect.any(AbortSignal) }));
  await waitFor(() => expect(screen.queryByText("Pending change")).not.toBeInTheDocument());
  expect(save).not.toHaveBeenCalled();
});

it("clears only explicitly and does not pretend native sign-in applied after uncertainty", async () => {
  read.mockResolvedValue({ llm: config, pending: null });
  render(<AgentModelSettings {...props} />);
  await screen.findByText("Venice · managed gateway · test-model · fixture…");
  save.mockResolvedValue({ operationId: op, status: "pending", reason: "delivery_unconfirmed" });
  read.mockResolvedValue({ llm: config, pending: { ...pending, requested: null } });
  fireEvent.click(screen.getByRole("button", { name: "Use native sign-in" }));
  await screen.findByText("Pending change");
  expect(save).toHaveBeenCalledWith(props.agentId, op, null, { signal: expect.any(AbortSignal) });
  expect(screen.getByText("Venice · managed gateway · test-model · fixture…")).toBeInTheDocument();
  expect(screen.getByRole("status")).not.toHaveTextContent("Setting confirmed");
});

it("discovers a saved pending request after a lost API acknowledgement and wipes the key", async () => {
  await mount(); enterKey(); save.mockRejectedValue(new AgentModelSettingsError("Connection interrupted."));
  read.mockResolvedValue({ llm: null, pending });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await screen.findByText("Pending change");
  expect(screen.getByRole("status")).toHaveTextContent("Connection interrupted");
  expect(screen.getByLabelText("Venice API key")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Resume change" })).toBeEnabled();
  expect(save).toHaveBeenCalledTimes(1); expect(resume).not.toHaveBeenCalled();
});

it("locks changes when saved-state refresh fails instead of assuming native state", async () => {
  read.mockRejectedValue(new AgentModelSettingsError("Saved settings unavailable."));
  render(<AgentModelSettings {...props} />);
  await screen.findByRole("alert");
  expect(screen.queryByText("Native sign-in")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  read.mockResolvedValue({ llm: null, pending: null });
  fireEvent.click(screen.getByRole("button", { name: "Refresh model settings" }));
  await screen.findByText("Native sign-in");
});

it("shows an honest guest update requirement and allows explicit refresh after an update", async () => {
  await mount(); enterKey();
  save.mockRejectedValue(new AgentModelSettingsError("Guest update required.", "guest_upgrade_required"));
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await screen.findByText(/Updating the dashboard alone/);
  expect(screen.getByRole("button", { name: "My Venice key" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh model settings" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "My Venice key" })).toBeEnabled());
  expect(save).toHaveBeenCalledTimes(1);
});

it("keeps the explicitly selected managed wallet and drops the BYOK draft on switching", async () => {
  await mount(); enterKey();
  fireEvent.click(screen.getByRole("button", { name: "Managed gateway" }));
  fireEvent.change(screen.getByLabelText("Pay from"), { target: { value: "card" } });
  expect(screen.getByText(/we do not switch wallets automatically/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(props.agentId, op,
    { provider: "venice", mode: "managed", walletType: "card" }, { signal: expect.any(AbortSignal) }));
  await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "My Venice key" }));
  expect(screen.getByLabelText("Venice API key")).toHaveValue("");
});

it("offers only native sign-in and BYOK in a standalone installation", async () => {
  const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
  process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
  try {
    await mount();
    expect(screen.getByText("Keep native sign-in or use your own Venice API key.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My Venice key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Managed gateway" })).not.toBeInTheDocument();
  } finally {
    if (previousMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previousMode;
  }
});

it.each(["unmount", "switch"])("does not apply a late result after %s", async action => {
  const view = await mount(); enterKey();
  let finish!: (value: { operationId: string; status: "applied" }) => void;
  save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  const signal = save.mock.calls[0][3]!.signal!;
  if (action === "unmount") view.unmount();
  else view.rerender(<AgentModelSettings key="other" {...props} agentId="other" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ operationId: op, status: "applied" }));
  expect(props.onChanged).not.toHaveBeenCalled();
  if (action === "switch") expect(screen.getByLabelText("Venice API key")).toHaveValue("");
});

it("does not double-submit while a request is in flight", async () => {
  const view = await mount(); enterKey();
  let finish!: (value: { operationId: string; status: "pending" }) => void;
  save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const button = screen.getByRole("button", { name: "Save connection" });
  fireEvent.click(button); fireEvent.click(button);
  expect(save).toHaveBeenCalledTimes(1); expect(button).toBeDisabled();
  view.unmount(); await act(async () => finish({ operationId: op, status: "pending" }));
});

it("lets owners inspect saved settings while provisioning but blocks new delivery", async () => {
  render(<AgentModelSettings {...props} ready={false} />);
  await screen.findByText("Native sign-in");
  expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  expect(screen.getByText(/Start this computer/)).toBeInTheDocument();
});

it("shows saved launch intent while provisioning, without pretending it is configured", async () => {
  read.mockResolvedValue({ llm: null, pending: null, launch: { ...launch, state: "waiting_for_computer" } });
  render(<AgentModelSettings {...props} ready={false} />);
  await screen.findByRole("region", { name: "Inference settings" });
  await screen.findByText("Connection chosen at launch");
  expect(screen.queryByText("Native sign-in")).not.toBeInTheDocument();
  expect(screen.getByText("Launch connection not applied yet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue setup" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Use native sign-in instead" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();
  expect(continueLaunch).not.toHaveBeenCalled();
});
it("refreshes on readiness and makes only one automatic attempt for the saved request", async () => {
  read.mockResolvedValue({ llm: null, pending: null, launch: { ...launch, state: "waiting_for_computer" } });
  const view = render(<AgentModelSettings {...props} ready={false} />);
  await screen.findByText("Connection chosen at launch");
  expect(continueLaunch).not.toHaveBeenCalled();
  // A stale read after a lost response must not create an automatic retry loop.
  read.mockResolvedValue({ llm: null, pending: null, launch: { ...launch, state: "ready_to_apply" } });
  continueLaunch.mockRejectedValue(new AgentModelSettingsError("Connection interrupted."));
  view.rerender(<AgentModelSettings {...props} ready />);
  await screen.findByText("Connection interrupted.");
  expect(continueLaunch).toHaveBeenCalledTimes(1);
  expect(continueLaunch).toHaveBeenCalledWith(props.agentId, requestId, op, true, { signal: expect.any(AbortSignal) });
  fireEvent.click(screen.getByRole("button", { name: "Refresh model settings" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh model settings" })).toBeEnabled());
  expect(continueLaunch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Continue setup" })).toBeEnabled();
  expect(save).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
});
it("requires explicit continuation after an earlier attempt and uses its original identity", async () => {
  read.mockResolvedValue({ llm: null, pending: null, launch });
  render(<AgentModelSettings {...props} />);
  await screen.findByText("Connection chosen at launch");
  expect(continueLaunch).not.toHaveBeenCalled();
  read.mockResolvedValue({ llm: null, pending, launch: null });
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  await screen.findByText("Pending change");
  expect(continueLaunch).toHaveBeenCalledWith(props.agentId, requestId, op, false, { signal: expect.any(AbortSignal) });
  expect(screen.queryByText("Connection chosen at launch")).not.toBeInTheDocument();
  expect(resume).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
it("does not repeat an already requested setup, but allows an explicit status refresh", async () => {
  read.mockResolvedValue({ llm: null, pending: null, launch: { ...launch, state: "setup_requested" } });
  render(<AgentModelSettings {...props} />);
  await screen.findByText("Connection chosen at launch");
  expect(screen.getByRole("button", { name: "Continue setup" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh model settings" })).toBeEnabled();
  expect(continueLaunch).not.toHaveBeenCalled();
});
it("lets the owner cancel a saved choice before the computer is ready, without deleting it", async () => {
  read.mockResolvedValue({ llm: null, pending: null, launch: { ...launch, state: "waiting_for_computer" } });
  render(<AgentModelSettings {...props} ready={false} />);
  await screen.findByText("Connection chosen at launch");
  read.mockResolvedValue({ llm: null, pending: null, launch: null });
  fireEvent.click(screen.getByRole("button", { name: "Use native sign-in instead" }));
  await screen.findByText(/Saved launch connection removed/);
  expect(cancelLaunch).toHaveBeenCalledWith(props.agentId, requestId, { signal: expect.any(AbortSignal) });
  expect(screen.getByText("Native sign-in")).toBeInTheDocument();
  expect(continueLaunch).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
it("does not claim cancellation when promotion wins the race", async () => {
  read.mockResolvedValue({ llm: null, pending: null, launch });
  cancelLaunch.mockRejectedValue(new AgentModelSettingsError("A change is already pending.", "pending_change"));
  render(<AgentModelSettings {...props} />);
  await screen.findByText("Connection chosen at launch");
  read.mockResolvedValue({ llm: null, pending, launch: null });
  fireEvent.click(screen.getByRole("button", { name: "Use native sign-in instead" }));
  await screen.findByText("Pending change");
  expect(screen.getByRole("status")).toHaveTextContent("already pending");
  expect(screen.queryByText(/Saved launch connection removed/)).not.toBeInTheDocument();
});
it.each(["unmount", "switch"])("ignores late launch recovery after %s", async action => {
  read.mockResolvedValue({ llm: null, pending: null, launch });
  const view = render(<AgentModelSettings key={props.agentId} {...props} />);
  await screen.findByText("Connection chosen at launch");
  let finish!: (value: { requestId: string; operationId: string; status: "applied" }) => void;
  continueLaunch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  const signal = continueLaunch.mock.calls[0][4]!.signal!;
  read.mockResolvedValue({ llm: null, pending: null });
  if (action === "unmount") view.unmount();
  else view.rerender(<AgentModelSettings key="other" {...props} agentId="other" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ requestId, operationId: op, status: "applied" }));
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(continueLaunch).toHaveBeenCalledTimes(1);
});
