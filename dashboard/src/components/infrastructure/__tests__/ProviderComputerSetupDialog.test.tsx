/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderComputerSetupDialog } from "../ProviderComputerSetupDialog";
import { listProviderComputerSetups, advanceProviderComputerSetup } from "@/lib/infrastructure/client";
import type { HetznerCloudConnectionDto } from "@/lib/infrastructure/contracts";
import type { ProviderComputerSetupView } from "@/lib/infrastructure/provider-computer-setup-contracts";
jest.mock("@/lib/infrastructure/client", () => ({ listProviderComputerSetups: jest.fn(), advanceProviderComputerSetup: jest.fn() }));
const view: ProviderComputerSetupView = { orderId: "22222222-2222-4222-8222-222222222222", connectionId: "11111111-1111-4111-8111-111111111111",
  connectionRevision: 7, serverName: "hivra-22222222222242228222", providerServerId: "42", stage: "awaiting_setup", targetId: null, observedAt: null, launchReady: false };
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
  expect(screen.queryByRole("button", { name: "Continue setup" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Choose what to launch" })).not.toBeInTheDocument();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("advances the original selected computer only after a click and does not claim an agent is running", async () => {
  (advanceProviderComputerSetup as jest.Mock).mockResolvedValue({ ...view, stage: "environment_prepared", launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333", observedAt: "2026-08-28T01:00:00Z" });
  const changed = jest.fn();
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button", { name: "Continue setup" }));
  expect(await screen.findByRole("heading", { name: "Environment prepared" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Choose what to launch" })).toHaveAttribute("href", "/dashboard/launch?start=1&targetId=33333333-3333-4333-8333-333333333333");
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
  expect(screen.queryByRole("link", { name: "Choose what to launch" })).not.toBeInTheDocument();
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it.each([false, true])("returns Ubuntu to launch for fresh compatibility checks (unified=%s)", async unifiedLaunchReturn => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, stage: "environment_prepared", launchReady: true,
    targetId: "33333333-3333-4333-8333-333333333333" }]);
  render(<ProviderComputerSetupDialog connection={connection} launchResourceId="linux-desktop"
    unifiedLaunchReturn={unifiedLaunchReturn} onClose={jest.fn()} onChanged={jest.fn()} />);
  await screen.findByRole("heading", { name: "Environment prepared" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText(/launch will check this computer’s current compatibility/)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing has been launched yet/)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Choose what to launch" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Continue launch" })).toHaveAttribute("href",
    unifiedLaunchReturn ? "/dashboard/launch?kind=computer&targetId=33333333-3333-4333-8333-333333333333"
      : "/dashboard/computers?launch=1&targetId=33333333-3333-4333-8333-333333333333");
  expect(advanceProviderComputerSetup).not.toHaveBeenCalled();
});
it("does not start or offer desktop launch before setup is prepared", async () => {
  render(<ProviderComputerSetupDialog connection={connection} launchResourceId="linux-desktop"
    onClose={jest.fn()} onChanged={jest.fn()} />);
  await screen.findByRole("button", { name: "Continue setup" });
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
  fireEvent.click(await screen.findByRole("button", { name: "Continue setup" }));
  await screen.findByRole("alert");
  expect(advanceProviderComputerSetup).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Continue setup" })).toBeEnabled();
});
it.each(["not_requested", "expired", "retired", "power_outcome_unknown"] as const)("does not offer automatic advancement for %s", async stage => {
  (listProviderComputerSetups as jest.Mock).mockResolvedValue([{ ...view, stage }]);
  render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  await waitFor(() => expect(screen.queryByText("Loading saved setup…")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Continue setup" })).not.toBeInTheDocument();
});
it("does not dispatch further steps after unmount", async () => {
  let finish!: (value: ProviderComputerSetupView) => void;
  (advanceProviderComputerSetup as jest.Mock).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const element = render(<ProviderComputerSetupDialog connection={connection} onClose={jest.fn()} onChanged={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Continue setup" })); element.unmount();
  await act(async () => finish({ ...view, stage: "waiting_for_power" }));
  expect(advanceProviderComputerSetup).toHaveBeenCalledTimes(1);
});
