/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManageChannelWake } from "../manage/ManageChannelWake";

const mockFetch = jest.fn();

function reply(data: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(ok ? { success: true, data } : { success: false, error: data }) });
}

describe("ManageChannelWake", () => {
  const saved = { sleep: process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP, channel: process.env.NEXT_PUBLIC_HIVRA_CHANNEL_WAKE };
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
    process.env.NEXT_PUBLIC_HIVRA_CHANNEL_WAKE = "1";
  });
  afterAll(() => {
    if (saved.sleep === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = saved.sleep;
    if (saved.channel === undefined) delete process.env.NEXT_PUBLIC_HIVRA_CHANNEL_WAKE;
    else process.env.NEXT_PUBLIC_HIVRA_CHANNEL_WAKE = saved.channel;
  });

  it("renders nothing and asks nothing with its switch off", () => {
    delete process.env.NEXT_PUBLIC_HIVRA_CHANNEL_WAKE;
    const { container } = render(<ManageChannelWake agentId="agent-1" disabled={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stays hidden when the server says it does not apply", async () => {
    mockFetch.mockReturnValueOnce(reply({ available: false, enabled: false }));
    const { container } = render(<ManageChannelWake agentId="agent-1" disabled={false} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the switch with the group-room note and turns it on", async () => {
    mockFetch.mockReturnValueOnce(reply({ available: true, enabled: false }));
    const onChanged = jest.fn();
    render(<ManageChannelWake agentId="agent-1" disabled={false} onChanged={onChanged} />);
    const toggle = await screen.findByRole("switch", { name: "Wake on Matrix messages" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/encrypted group rooms, where every message wakes it/)).toBeInTheDocument();
    mockFetch.mockReturnValueOnce(reply({ available: true, enabled: true }));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(mockFetch).toHaveBeenLastCalledWith("/api/hivra/agents/agent-1/channel-wake/matrix", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true }) }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    mockFetch.mockReturnValueOnce(reply({ available: true, enabled: false }));
    render(<ManageChannelWake agentId="agent-1" disabled={false} />);
    const toggle = await screen.findByRole("switch");
    mockFetch.mockReturnValueOnce(reply("Your agent signs in to Matrix with a password.", false));
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("password");
  });
});
