/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HermesRestorePoints, restorePointsEnabled } from "../HermesRestorePoints";
import { getBoxRestorePoints, setBoxRestorePoints } from "@/lib/hivra/agent-api";

jest.mock("@/lib/hivra/agent-api", () => ({ getBoxRestorePoints: jest.fn(), setBoxRestorePoints: jest.fn() }));
const get = jest.mocked(getBoxRestorePoints), set = jest.mocked(setBoxRestorePoints);
const props = { chatUrl: "https://box.example.com", apiToken: "t", agentName: "Hermes", running: true, disabled: false };
beforeEach(() => { jest.clearAllMocks(); get.mockResolvedValue({ enabled: false, supported: true, error: null }); });

it("is off unless the release flag is set", () => {
  const before = process.env.NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED;
  delete process.env.NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED;
  expect(restorePointsEnabled()).toBe(false);
  process.env.NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED = "1";
  expect(restorePointsEnabled()).toBe(false);
  process.env.NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED = "true";
  expect(restorePointsEnabled()).toBe(true);
  if (before === undefined) delete process.env.NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED; else process.env.NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED = before;
});

it("asks for the update on a computer that does not have it yet", async () => {
  get.mockResolvedValue({ enabled: false, supported: false, error: null });
  render(<HermesRestorePoints {...props} />);
  expect(await screen.findByText(/Update Hermes's connection service/)).toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

it("does not ask a stopped computer", () => {
  render(<HermesRestorePoints {...props} running={false} />);
  expect(screen.getByText(/Start this computer/)).toBeInTheDocument();
  expect(get).not.toHaveBeenCalled();
});

it("turns restore points on and says how to roll back", async () => {
  set.mockResolvedValue({ ok: true, enabled: true, error: null });
  render(<HermesRestorePoints {...props} />);
  const sw = await screen.findByRole("switch", { name: "Restore points" });
  expect(sw).toHaveAttribute("aria-checked", "false");
  fireEvent.click(sw);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/\/rollback/));
  expect(set).toHaveBeenCalledWith("https://box.example.com", true, "t");
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
});

it("keeps the switch where it was when Hermes refuses", async () => {
  get.mockResolvedValue({ enabled: true, supported: true, error: null });
  set.mockResolvedValue({ ok: false, error: "Hermes is being updated." });
  render(<HermesRestorePoints {...props} />);
  fireEvent.click(await screen.findByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Hermes is being updated.");
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
});
