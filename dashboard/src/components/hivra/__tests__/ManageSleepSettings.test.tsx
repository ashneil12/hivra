/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManageSleepSettings } from "../manage/ManageSleepSettings";
import type { HivraAgent } from "@/lib/hivra/agent-api";

const mockHold = jest.fn();
const mockRelease = jest.fn();
jest.mock("../useAgentWake", () => ({
  holdAutoWake: (...args: unknown[]) => mockHold(...args),
  releaseAutoWake: (...args: unknown[]) => mockRelease(...args),
}));

const mockSave = jest.fn();
const mockSleep = jest.fn();
const mockWake = jest.fn();
const mockGetTelegram = jest.fn();
const mockSaveTelegram = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  getTelegramWakeSetting: (...args: unknown[]) => mockGetTelegram(...args),
  saveTelegramWakeSetting: (...args: unknown[]) => mockSaveTelegram(...args),
  saveAgentSleepSettings: (...args: unknown[]) => mockSave(...args),
  sleepAgentNow: (...args: unknown[]) => mockSleep(...args),
  wakeAgent: (...args: unknown[]) => mockWake(...args),
}));

const agent = (extra: Record<string, unknown> = {}) => ({
  id: "agent-1", type: "claude-code", name: "NAP", status: "running", cpu: 2, ram: 4,
  sleep_state: "awake", sleep_policy: "off", always_on: false, ...extra,
}) as unknown as HivraAgent;

describe("ManageSleepSettings", () => {
  const previous = process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = previous;
  });

  it("explains Sleep when idle in one plain line and reflects the saved policy", () => {
    render(<ManageSleepSettings agent={agent({ sleep_policy: "full" })} onChanged={jest.fn()} />);
    expect(screen.getByText("Your agent naps when no one is using it and wakes when you open it.")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Sleep when idle" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Keep awake" })).toHaveAttribute("aria-checked", "false");
  });

  it("turns Sleep when idle on and off through the policy", async () => {
    const onChanged = jest.fn();
    mockSave.mockResolvedValueOnce({ sleep_policy: "full", always_on: false }).mockResolvedValueOnce({ sleep_policy: "off", always_on: false });
    render(<ManageSleepSettings agent={agent()} onChanged={onChanged} />);
    const toggle = screen.getByRole("switch", { name: "Sleep when idle" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(mockSave).toHaveBeenLastCalledWith("agent-1", { sleep_policy: "full" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(mockSave).toHaveBeenLastCalledWith("agent-1", { sleep_policy: "off" });
  });

  it("turns Keep awake on, which holds Sleep when idle off", async () => {
    mockSave.mockResolvedValue({ sleep_policy: "full", always_on: true });
    render(<ManageSleepSettings agent={agent({ sleep_policy: "full" })} onChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Keep awake" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Keep awake" })).toHaveAttribute("aria-checked", "true"));
    expect(mockSave).toHaveBeenCalledWith("agent-1", { always_on: true });
    expect(screen.getByRole("switch", { name: "Sleep when idle" })).toBeDisabled();
  });

  it("says plainly when a setting could not be saved, and keeps the old one", async () => {
    mockSave.mockRejectedValue(new Error("Could not save this setting."));
    render(<ManageSleepSettings agent={agent()} onChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Keep awake" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this setting.");
    expect(screen.getByRole("switch", { name: "Keep awake" })).toHaveAttribute("aria-checked", "false");
  });

  it("puts the agent to sleep by hand for a test, and says how it went", async () => {
    const onChanged = jest.fn();
    mockSleep.mockResolvedValueOnce({ outcome: "slept", reason: null }).mockResolvedValueOnce({ outcome: "not_idle", reason: "active_runs" });
    render(<ManageSleepSettings agent={agent()} onChanged={onChanged} />);
    expect(screen.getByRole("button", { name: "Wake" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Nap now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your agent is napping.");
    expect(mockSleep).toHaveBeenLastCalledWith("agent-1", "nap");
    expect(onChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Hibernate now" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("busy right now"));
    expect(mockSleep).toHaveBeenLastCalledWith("agent-1", "hibernate");
  });

  it("tells the agent page not to wake the agent again after a sleep the owner asked for", async () => {
    mockSleep.mockResolvedValueOnce({ outcome: "slept", reason: null }).mockResolvedValueOnce({ outcome: "not_idle", reason: "active_runs" });
    render(<ManageSleepSettings agent={agent()} onChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Nap now" }));
    await screen.findByText("Your agent is napping.");
    expect(mockHold).toHaveBeenCalledWith("agent-1");
    mockHold.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Hibernate now" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("busy right now"));
    // It stayed awake, so there is nothing to hold.
    expect(mockHold).not.toHaveBeenCalled();
  });

  it("lets the page wake the agent again once the owner presses Wake", async () => {
    mockWake.mockResolvedValue({ state: "awake", wakeMs: 900 });
    render(<ManageSleepSettings agent={agent({ sleep_state: "napping" })} onChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await screen.findByText("Your agent is awake.");
    expect(mockRelease).toHaveBeenCalledWith("agent-1");
  });

  it("offers Wake, and not the sleep buttons, while the agent is asleep", async () => {
    mockWake.mockResolvedValue({ state: "awake", wakeMs: 1200 });
    render(<ManageSleepSettings agent={agent({ sleep_state: "napping" })} onChanged={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Nap now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hibernate now" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your agent is awake.");
    expect(mockWake).toHaveBeenCalledWith("agent-1");
  });

  it("uses no dashes in its copy", () => {
    const { container } = render(<ManageSleepSettings agent={agent()} onChanged={jest.fn()} />);
    expect(container.textContent).not.toMatch(/[-–—]/);
  });
});

describe("ManageSleepSettings: Wake on Telegram messages", () => {
  const saved = { sleep: process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP, tg: process.env.NEXT_PUBLIC_HIVRA_TELEGRAM_WAKE };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
    process.env.NEXT_PUBLIC_HIVRA_TELEGRAM_WAKE = "1";
    mockGetTelegram.mockResolvedValue({ available: true, enabled: false, armed: false });
  });
  afterAll(() => {
    for (const [name, value] of [["NEXT_PUBLIC_HIVRA_AGENT_SLEEP", saved.sleep], ["NEXT_PUBLIC_HIVRA_TELEGRAM_WAKE", saved.tg]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("asks nothing and shows nothing with its switch off", async () => {
    delete process.env.NEXT_PUBLIC_HIVRA_TELEGRAM_WAKE;
    render(<ManageSleepSettings agent={agent()} onChanged={jest.fn()} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockGetTelegram).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch", { name: "Wake on Telegram messages" })).toBeNull();
  });

  it("stays hidden for an agent without Telegram", async () => {
    mockGetTelegram.mockResolvedValue({ available: false, enabled: false, armed: false });
    render(<ManageSleepSettings agent={agent()} onChanged={jest.fn()} />);
    await waitFor(() => expect(mockGetTelegram).toHaveBeenCalledWith("agent-1"));
    expect(screen.queryByRole("switch", { name: "Wake on Telegram messages" })).toBeNull();
  });

  it("shows one plain switch with one sentence, and turns it on", async () => {
    mockSaveTelegram.mockResolvedValue({ available: true, enabled: true, armed: false });
    const onChanged = jest.fn();
    render(<ManageSleepSettings agent={agent()} onChanged={onChanged} />);
    const toggle = await screen.findByRole("switch", { name: "Wake on Telegram messages" });
    expect(screen.getByText("Your agent can sleep while connected to Telegram, and a new message wakes it in a few seconds.")).toBeVisible();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(mockSaveTelegram).toHaveBeenCalledWith("agent-1", true);
    expect(onChanged).toHaveBeenCalled();
  });

  it("says plainly why it could not be turned on", async () => {
    mockSaveTelegram.mockRejectedValue(new Error("Your agent needs to be awake to turn this on. Open it and try again."));
    render(<ManageSleepSettings agent={agent()} onChanged={jest.fn()} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Wake on Telegram messages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your agent needs to be awake");
  });
});
