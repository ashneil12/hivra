/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProviderComputerSetupDialog } from "../ProviderComputerSetupDialog";
import { listProviderComputerSetups, advanceProviderComputerSetup } from "@/lib/infrastructure/client";
import type { HetznerCloudConnectionDto } from "@/lib/infrastructure/contracts";
import type { ProviderComputerSetupView } from "@/lib/infrastructure/provider-computer-setup-contracts";
jest.mock("@/lib/infrastructure/client", () => ({ listProviderComputerSetups: jest.fn(), advanceProviderComputerSetup: jest.fn() }));
const view: ProviderComputerSetupView = { orderId: "22222222-2222-4222-8222-222222222222", connectionId: "11111111-1111-4111-8111-111111111111",
  connectionRevision: 7, serverName: "hivra-22222222222242228222", providerServerId: "42", stage: "awaiting_setup", targetId: null, observedAt: null, launchReady: false, enrollmentExpiresAt: null,
  enrollmentClosesAt: null, enrollmentWindow: "since_creation" };
// A server created with the current recipe: its window opens at Start setup.
const startView: ProviderComputerSetupView = { ...view, enrollmentWindow: "since_start" };
const connection = { id: view.connectionId, name: "My cloud" } as HetznerCloudConnectionDto;
beforeEach(() => { jest.clearAllMocks(); (listProviderComputerSetups as jest.Mock).mockResolvedValue([view]); });
it("opens saved state without starting a server or setup", async () => {
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByRole("heading", { name: "Ready to begin setup" })).toBeInTheDocument();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("labels retired setup history without confusing it with a launchable computer", async () => {
  const retired = { ...view, orderId: "44444444-4444-4444-8444-444444444444", serverName: "hivra-old", stage: "retired" };
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([retired, view]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  const selector = await screen.findByRole("combobox");
  expect(selector).toHaveValue(view.orderId);
  expect(screen.getByRole("option", { name: "hivra-old — Computer retired" })).toBeInTheDocument();
  fireEvent.change(selector, { target: { value: retired.orderId } });
  expect(screen.getByText(/saved setup is reference-only/)).toHaveTextContent("confirm whether provider billing has ended");
  expect(screen.queryByRole("button", { name: /(Start|Continue) setup/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Launch on this server" })).not.toBeInTheDocument();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("advances the original selected computer only after a click and does not claim an agent is running", async () => {
  (advanceProviderComputerSetup as jest.Mock).mockResolvedValue({ ...view, stage: "environment_prepared", launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333", observedAt: "2026-08-28T01:00:00Z" });
  const changed = jest.fn();
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start setup" }));
  expect(await screen.findByRole("heading", { name: "Ready for agents" })).toBeInTheDocument();
  expect(screen.getByText(`${view.serverName} is ready for agents.`, { exact: false })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Launch on this server" })).toHaveAttribute("href", "/dashboard/launch?start=1&targetId=33333333-3333-4333-8333-333333333333");
  expect(within(screen.getByRole("list", { name: "Observed setup steps" })).getByText("Ready for agents")).toBeInTheDocument();
  expect(advanceProviderComputerSetup).toHaveBeenCalledTimes(1);
  expect(advanceProviderComputerSetup).toHaveBeenCalledWith(connection.id, { orderId: view.orderId, expectedConnectionRevision: 7 });
  expect(changed).toHaveBeenCalledTimes(1);
});
it("returns a prepared computer to the originally selected agent launch", async () => {
  const ready = {
    ...view,
    stage: "environment_prepared" as const,
    launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333",
    observedAt: "2026-08-28T01:00:00Z",
  };
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([ready]);
  render(<ProviderComputerSetupDialog
    connection={connection}
    launchResourceId="codex"
    onClose={jest.fn()}
    onChanged={jest.fn()}
  />);
  expect(await screen.findByRole("link", { name: "Continue launch" })).toHaveAttribute(
    "href",
    "/dashboard/welcome?step=deploy&agentType=codex&targetId=33333333-3333-4333-8333-333333333333",
  );
});
it("returns unified setup to the saved launch journey when requested", async () => {
  const ready = {
    ...view,
    stage: "environment_prepared" as const,
    launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333",
    observedAt: "2026-08-28T01:00:00Z",
  };
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([ready]);
  render(<ProviderComputerSetupDialog
    connection={connection}
    launchResourceId="codex"
    unifiedLaunchReturn
    onClose={jest.fn()}
    onChanged={jest.fn()}
  />);
  expect(await screen.findByRole("link", { name: "Continue launch" })).toHaveAttribute(
    "href",
    "/dashboard/launch?kind=agent&targetId=33333333-3333-4333-8333-333333333333",
  );
});
it("keeps published but unadmitted setup explicitly resumable without a launch link", async () => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, stage: "environment_prepared" }]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByRole("button", { name: "Continue setup" })).toBeEnabled();
  expect(screen.queryByRole("link", { name: "Launch on this server" })).not.toBeInTheDocument();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it.each([false, true])("returns Ubuntu to launch for fresh compatibility checks (unified=%s)", async unifiedLaunchReturn => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, stage: "environment_prepared", launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333" }]);
  render(<ProviderComputerSetupDialog connection={connection} launchResourceId="linux-desktop"
    unifiedLaunchReturn={unifiedLaunchReturn} onClose={jest.fn()} onChanged={jest.fn()} />);
  await screen.findByRole("heading", { name: "Ready for agents" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText(/Launch checks it again before anything starts/)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing has been launched yet/)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Launch on this server" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Continue launch" })).toHaveAttribute("href",
    unifiedLaunchReturn ? "/dashboard/launch?kind=computer&targetId=33333333-3333-4333-8333-333333333333"
      : "/dashboard/computers?launch=1&targetId=33333333-3333-4333-8333-333333333333");
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("does not start or offer desktop launch before setup is prepared", async () => {
  render(<ProviderComputerSetupDialog connection={connection} launchResourceId="linux-desktop"
    onClose={jest.fn()} onChanged={jest.fn()} />);
  await screen.findByRole("button", { name: "Start setup" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Continue launch" })).not.toBeInTheDocument();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("never offers launch from a retired record even with stale ready fields", async () => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, stage: "retired", launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333" }]);
  render(<ProviderComputerSetupDialog connection={connection} launchResourceId="codex" onClose={jest.fn()} onChanged={jest.fn()} />);
  await screen.findByRole("heading", { name: "Computer retired" });
  expect(screen.queryByRole("link", { name: "Continue launch" })).not.toBeInTheDocument();
});
it("stops after an uncertain result and offers explicit resume", async () => {
  (advanceProviderComputerSetup as jest.Mock).mockRejectedValue(new Error("This setup step could not be confirmed."));
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start setup" }));
  await screen.findByRole("alert");
  expect(advanceProviderComputerSetup).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Start setup" })).toBeEnabled();
});
it.each(["not_requested", "expired", "retired", "power_outcome_unknown"] as const)("does not offer automatic advancement for %s", async stage => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, stage }]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  await waitFor(() => expect(screen.queryByText("Loading saved setup…")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /(Start|Continue) setup/ })).not.toBeInTheDocument();
});
it("does not dispatch further steps after unmount", async () => {
  let finish!: (value: ProviderComputerSetupView) => void;
  (advanceProviderComputerSetup as jest.Mock).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const element = render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start setup" })); element.unmount();
  await act(async () => finish({ ...view, stage: "waiting_for_power" }));
  expect(advanceProviderComputerSetup).toHaveBeenCalledTimes(1);
});

it("counts down a legacy server's setup key from the server's deadline without starting anything", async () => {
  const deadline = new Date(Date.now() + 14 * 60_000 + 10_500).toISOString();
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, enrollmentExpiresAt: deadline, enrollmentClosesAt: deadline }]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByText(/Setup key valid for/)).toHaveTextContent(/14:(10|09)/);
  expect(screen.getByRole("button", { name: "Start setup" })).toBeEnabled();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("re-reads a legacy server's saved state when the local countdown reaches zero instead of claiming expiry", async () => {
  const deadline = new Date(Date.now() - 1_000).toISOString();
  (listProviderComputerSetups as jest.Mock)
    .mockResolvedValueOnce([{ ...view, enrollmentExpiresAt: deadline, enrollmentClosesAt: deadline }])
    .mockResolvedValueOnce([{ ...view, stage: "expired", enrollmentExpiresAt: null, enrollmentClosesAt: null }]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByRole("heading", { name: "Setup window expired" })).toBeInTheDocument();
  expect(listProviderComputerSetups).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: /(Start|Continue) setup/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Setup key valid for/)).not.toBeInTheDocument();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("shows no countdown before Start setup for a server whose window opens at Start setup", async () => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([startView]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByText(/Setup must finish within 15 minutes of starting/)).toBeInTheDocument();
  expect(screen.queryByText(/Setup key valid for/)).not.toBeInTheDocument();
  expect(screen.queryByText(/left for the server to connect back/)).not.toBeInTheDocument();
  expect(document.querySelector("time, [class*=setupCountdown]")).toBeNull();
  expect(screen.getByRole("button", { name: "Start setup" })).toBeEnabled();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("starts the countdown only from the deadline the server reports after Start setup", async () => {
  const started = { ...startView, stage: "power_requested" as const,
    enrollmentExpiresAt: new Date(Date.now() + 14 * 60_000 + 10_500).toISOString(),
    enrollmentClosesAt: new Date(Date.now() + 16 * 60_000 + 10_500).toISOString() };
  let finish!: (value: ProviderComputerSetupView) => void;
  (advanceProviderComputerSetup as jest.Mock).mockReturnValueOnce(Promise.resolve(started))
    .mockReturnValue(new Promise(resolve => { finish = resolve; }));
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  try {
    render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
    await act(async () => { await Promise.resolve(); });
    const start = await screen.findByRole("button", { name: "Start setup" });
    expect(screen.queryByText(/left for the server to connect back/)).not.toBeInTheDocument();
    fireEvent.click(start);
    const countdown = await screen.findByText(/left for the server to connect back/);
    expect(countdown).toHaveTextContent("Setup must finish within 15 minutes of starting.");
    expect(countdown).toHaveTextContent(/14:(10|09)/);
    expect(screen.queryByText(/Setup key valid for/)).not.toBeInTheDocument();
    await act(async () => { finish({ ...started, stage: "identity_enrolled", enrollmentExpiresAt: null, enrollmentClosesAt: null }); });
  } finally { jest.useRealTimers(); }
});
it("keeps reading through the server's boot allowance after the 15 minutes, then explains a start-window expiry", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  try {
    // The 15 minutes ended a second ago; the server accepts the connection for 2 more minutes.
    const waiting = { ...startView, stage: "waiting_for_identity" as const,
      enrollmentExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      enrollmentClosesAt: new Date(Date.now() + 2 * 60_000 - 1_000).toISOString() };
    (listProviderComputerSetups as jest.Mock)
      .mockResolvedValueOnce([waiting]).mockResolvedValueOnce([waiting])
      .mockResolvedValue([{ ...startView, stage: "expired", enrollmentExpiresAt: null, enrollmentClosesAt: null }]);
    render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
    const slack = await screen.findByText(/Hivra keeps listening/);
    expect(slack).toHaveTextContent(/1:5\d longer while Hetzner finishes booting the server/);
    // Read once when the 15 minutes ended; the server still says it's waiting.
    await waitFor(() => expect(listProviderComputerSetups).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "Setup window expired" })).not.toBeInTheDocument();
    // When the server's own window closes, the page reads again instead of stalling.
    await act(async () => { jest.advanceTimersByTime(2 * 60_000); });
    expect(await screen.findByRole("heading", { name: "Setup window expired" })).toBeInTheDocument();
    expect(listProviderComputerSetups).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/didn't connect back within 15 minutes of starting setup/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /(Start|Continue) setup/ })).not.toBeInTheDocument();
    expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
it("reads again after the server's window closes when this device's clock runs ahead", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  try {
    const closed = new Date(Date.now() - 1_000).toISOString();
    const waiting = { ...startView, stage: "waiting_for_identity" as const, enrollmentExpiresAt: closed, enrollmentClosesAt: closed };
    (listProviderComputerSetups as jest.Mock).mockResolvedValueOnce([waiting]).mockResolvedValueOnce([waiting])
      .mockResolvedValue([{ ...startView, stage: "expired", enrollmentExpiresAt: null, enrollmentClosesAt: null }]);
    render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
    expect(await screen.findByText(/The setup window has closed. Checking the saved state/)).toBeInTheDocument();
    await waitFor(() => expect(listProviderComputerSetups).toHaveBeenCalledTimes(2));
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(await screen.findByRole("heading", { name: "Setup window expired" })).toBeInTheDocument();
    expect(listProviderComputerSetups).toHaveBeenCalledTimes(3);
  } finally { jest.useRealTimers(); }
});
it("says no server exists when a start-window server request was never sent in time", async () => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...startView, stage: "expired", providerServerId: null }]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByRole("heading", { name: "Setup window expired" })).toBeInTheDocument();
  expect(screen.getByText(/no server was created and there is nothing to remove/)).toBeInTheDocument();
  expect(screen.queryByText(/Remove created server/)).not.toBeInTheDocument();
});
it("hides the countdown once the server has connected back", async () => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, stage: "identity_enrolled", enrollmentExpiresAt: null, enrollmentClosesAt: null }]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByRole("button", { name: "Continue setup" })).toBeInTheDocument();
  expect(screen.queryByText(/Setup key valid for/)).not.toBeInTheDocument();
});
it("shows elapsed time and observed stages while setup runs, and keeps the window open", async () => {
  let finish!: (value: ProviderComputerSetupView) => void;
  (advanceProviderComputerSetup as jest.Mock).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onClose = jest.fn();
  render(<ProviderComputerSetupDialog connection={connection} onClose={onClose} onChanged={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start setup" }));
  expect(await screen.findByText(/Setting up/)).toHaveTextContent(/0:0\d.*about 5 minutes/);
  expect(screen.getByRole("button", { name: "Close computer setup" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Pause after this step" })).toBeInTheDocument();
  await act(async () => finish({ ...view, stage: "environment_prepared", launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333", observedAt: "2026-08-28T01:00:00Z" }));
  expect(await screen.findByRole("link", { name: "Launch on this server" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close computer setup" })).toBeEnabled();
});
it("pins the panel to one server when opened for it", async () => {
  const other = { ...view, orderId: "44444444-4444-4444-8444-444444444444", serverName: "hivra-other" };
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([other, view]);
  render(<ProviderComputerSetupDialog connection={connection} orderId={view.orderId} onClose={jest.fn()} onChanged={jest.fn()} />);
  expect(await screen.findByText(view.serverName)).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByText("hivra-other")).not.toBeInTheDocument();
});
