/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockGetWithExpiry = jest.fn();
const mockForget = jest.fn();
const mockList = jest.fn();
const mockChange = jest.fn();
const mockChatProps = jest.fn();
const mockContractFetch = jest.fn();
const mockContractAction = jest.fn();
const mockRename = jest.fn();
const mockEvents = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  renameAgent: (...args: unknown[]) => mockRename(...args),
  getAgentEvents: (...args: unknown[]) => mockEvents(...args),
}));

jest.mock("@/components/hivra/ManagedSessionChat", () => ({
  ManagedSessionChat: (props: Record<string, unknown>) => {
    mockChatProps(props);
    return <div>chat surface</div>;
  },
}));
// The real Manage panel, over a stand-in for its API client.
jest.mock("@/lib/hivra/computer-contract-client", () => ({
  fetchComputerContract: (...args: unknown[]) => mockContractFetch(...args),
  runComputerContractAction: (...args: unknown[]) => mockContractAction(...args),
}));
jest.mock("@/lib/hivra/managed-session-client", () => {
  const actual = jest.requireActual("@/lib/hivra/managed-session-client");
  return {
    ...actual,
    getManagedSessionWithExpiry: (...args: unknown[]) => mockGetWithExpiry(...args),
    forgetManagedSession: (...args: unknown[]) => mockForget(...args),
    listManagedWorkspace: (...args: unknown[]) => mockList(...args),
    changeManagedSession: (...args: unknown[]) => mockChange(...args),
  };
});

import { DigitalOceanAgentWorkspace, setupNoteReminder } from "../DigitalOceanAgentWorkspace";
import { formatContractTime } from "../ComputerContractPanel";
import { ManagedSessionApiError } from "@/lib/hivra/managed-session-client";
import type { ManagedSessionDto } from "@/lib/hivra/managed-session-contracts";

const AGENT = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const session: ManagedSessionDto = {
  agentId: AGENT, name: "Builder", harness: "codex", size: "mars-2vcpu-4gb",
  status: "ready", providerStatus: "SESSION_STATUS_READY", pauseReason: null, sessionId: "sess_1",
  connectionId: CONNECTION, error: null, createdAt: "2026-09-23T10:00:00Z",
};

function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const SENT_AT = new Date().toISOString();
function note(overrides: Record<string, unknown> = {}) {
  return { kind: "tracked", channel: "do-setup-message", revision: 1, content: "<!-- HIVRA:COMPUTER:START v1 rev=1 -->\n## Your computer\n<!-- HIVRA:COMPUTER:END -->",
    state: "sent", deliveredAt: SENT_AT, checkedAt: SENT_AT, lastAttemptAt: SENT_AT, lastError: null, lastDelivered: null,
    appliesTo: "new-chats", ...overrides };
}

beforeEach(() => {
  for (const mock of [mockGetWithExpiry, mockForget, mockList, mockChange, mockChatProps, mockContractFetch, mockContractAction, mockRename, mockEvents]) mock.mockReset();
  mockRename.mockResolvedValue(undefined);
  mockEvents.mockResolvedValue([]);
  mockContractFetch.mockResolvedValue(note());
  window.localStorage.clear();
});

describe("Hivra's setup note (ATT-13)", () => {
  const lastChatProps = () => mockChatProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;

  it("gives a DigitalOcean agent a Manage tab where the owner sends the setup note, and the chat reloads to show it", async () => {
    mockGetWithExpiry.mockResolvedValueOnce({ session, credentialExpiry: null });
    mockContractFetch.mockReset().mockResolvedValue({ kind: "not_started", channel: "do-setup-message" });
    render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
    await screen.findByText("chat surface");
    expect(lastChatProps().historyVersion).toBe(0);

    fireEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.getByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/runs on its own computer \(My cloud · DigitalOcean · 2 CPU \/ 4 GB\)/)).toBeInTheDocument();
    expect(screen.getByText("Not sent yet")).toBeInTheDocument();
    expect(screen.getByText(/uses a little of your DigitalOcean and model usage/)).toBeInTheDocument();
    expect(mockContractAction).not.toHaveBeenCalled();

    mockContractAction.mockResolvedValueOnce(note());
    fireEvent.click(screen.getByRole("button", { name: "Send setup note" }));
    await waitFor(() => expect(mockContractAction).toHaveBeenCalledWith(AGENT, "send"));
    expect(await screen.findByText(`Sent in chat ${formatContractTime(SENT_AT)}`)).toBeInTheDocument();
    expect(lastChatProps().historyVersion).toBe(1);
  });

  it("offers the owner's own Send update after what Hivra would say changed", async () => {
    mockGetWithExpiry.mockResolvedValueOnce({ session, credentialExpiry: null });
    mockContractFetch.mockReset().mockResolvedValue(note({ revision: 2, state: "pending", deliveredAt: null, lastDelivered: { revision: 1, deliveredAt: SENT_AT } }));
    render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
    expect(await screen.findByText("What Hivra tells Builder about its computer changed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review in Manage" }));
    expect(screen.getByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
    mockContractAction.mockResolvedValueOnce(note({ revision: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Send update to Builder" }));
    await waitFor(() => expect(mockContractAction).toHaveBeenCalledWith(AGENT, "send"));
  });

  it("says in the chat when the launch's setup note didn't reach the agent", async () => {
    mockGetWithExpiry.mockResolvedValueOnce({ session, credentialExpiry: null });
    mockContractFetch.mockReset().mockResolvedValue(note({ state: "pending", deliveredAt: null, lastError: "send_failed" }));
    render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
    expect(await screen.findByText("Hivra's setup note didn't reach Builder.")).toBeInTheDocument();
    expect(screen.getByText("DigitalOcean didn't accept it. You can send it again from Manage.")).toBeInTheDocument();
    // Nothing is sent from the reminder itself.
    expect(mockContractAction).not.toHaveBeenCalled();
  });

  it("hides the reminder for that revision when the owner says Not now, and shows the next one", async () => {
    mockGetWithExpiry.mockResolvedValue({ session, credentialExpiry: null });
    mockContractFetch.mockReset().mockResolvedValue(note({ state: "pending", deliveredAt: null }));
    const { unmount } = render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Hivra hasn't sent Builder its setup note.")).not.toBeInTheDocument();
    unmount();

    render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
    await screen.findByText("chat surface");
    await waitFor(() => expect(mockContractFetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Hivra hasn't sent Builder its setup note.")).not.toBeInTheDocument();
  });

  it("shows no reminder once the note was sent", async () => {
    mockGetWithExpiry.mockResolvedValueOnce({ session, credentialExpiry: null });
    render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
    await screen.findByText("chat surface");
    await waitFor(() => expect(mockContractFetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Review in Manage" })).not.toBeInTheDocument();
  });

  it("hands the launch's first task to the chat, which offers it back only if it was never sent", async () => {
    mockGetWithExpiry.mockResolvedValueOnce({ session, credentialExpiry: null });
    render(<DigitalOceanAgentWorkspace agentId={AGENT} firstTask="Summarize the repo" onDeleted={jest.fn()} />);
    await screen.findByText("chat surface");
    expect(lastChatProps().firstTask).toBe("Summarize the repo");
  });
});

describe("setupNoteReminder", () => {
  it("names nothing for a note that was sent, a Hivra Cloud agent, or an unknown status", () => {
    expect(setupNoteReminder(note() as never, "Builder")).toBeNull();
    expect(setupNoteReminder(note({ channel: "proxmox-seed", state: "pending" }) as never, "Builder")).toBeNull();
    expect(setupNoteReminder(null, "Builder")).toBeNull();
    expect(setupNoteReminder({ kind: "not_started", channel: "do-setup-message" }, "Builder")).toMatchObject({ revision: 0 });
  });
});

it("offers Replace token and a confirmed Forget when the saved token is rejected", async () => {
  mockGetWithExpiry
    .mockRejectedValueOnce(new ManagedSessionApiError("DigitalOcean rejected the saved token.", 422, "invalid_credentials"))
    .mockResolvedValueOnce({ session, credentialExpiry: null });
  mockForget.mockResolvedValueOnce({ ...session, status: "deleted" });
  const onDeleted = jest.fn();
  render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={onDeleted} />);

  expect(await screen.findByText(/can't reach Builder's DigitalOcean session/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Replace token/ })).toHaveAttribute("href", `/dashboard/infrastructure?replaceToken=${CONNECTION}`);

  fireEvent.click(screen.getByRole("button", { name: /Forget this agent in Hivra/ }));
  expect(mockForget).not.toHaveBeenCalled();
  expect(screen.getByText(/won't delete the session at\s+DigitalOcean \(sess_1\)/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Forget in Hivra/ }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(mockForget).toHaveBeenCalledWith(AGENT);
});

it("reminds the owner a week before the token date they entered", async () => {
  mockGetWithExpiry.mockResolvedValueOnce({
    session,
    credentialExpiry: { source: "owner-declared", noExpiry: false, expiresOn: isoDaysFromNow(3), declaredAt: new Date().toISOString() },
  });
  render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
  expect(await screen.findByText(/token for Builder expires in 3 days/)).toBeInTheDocument();
  expect(screen.queryByText(/can't reach/)).not.toBeInTheDocument();
});

it("shows no reminder when the token has no expiry", async () => {
  mockGetWithExpiry.mockResolvedValueOnce({
    session,
    credentialExpiry: { source: "owner-declared", noExpiry: true, expiresOn: null, declaredAt: new Date().toISOString() },
  });
  render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
  await screen.findByText("chat surface");
  expect(screen.queryByText(/expires/)).not.toBeInTheDocument();
});

it("browses /workspace read-only and downloads through Hivra", async () => {
  mockGetWithExpiry.mockResolvedValueOnce({ session, credentialExpiry: null });
  mockList
    .mockResolvedValueOnce({ path: "", entries: [
      { name: "src", kind: "directory", sizeBytes: null, modifiedAt: null },
      { name: "notes.md", kind: "file", sizeBytes: 2048, modifiedAt: "2026-09-24T09:00:00.000Z" },
    ], truncated: false })
    .mockResolvedValueOnce({ path: "src", entries: [], truncated: false });
  render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Files" }));

  const download = await screen.findByRole("link", { name: "Download notes.md" });
  expect(download).toHaveAttribute("href", `/api/hivra/managed-sessions/${AGENT}/workspace/download?path=notes.md`);
  expect(screen.getByText("2.0 KB")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "src" }));
  expect(await screen.findByText("This folder is empty.")).toBeInTheDocument();
  expect(mockList).toHaveBeenLastCalledWith(AGENT, "src", expect.anything());
});

it("asks before resuming a paused session to read its files", async () => {
  mockGetWithExpiry.mockResolvedValueOnce({ session: { ...session, status: "paused" }, credentialExpiry: null });
  mockList
    .mockRejectedValueOnce(new ManagedSessionApiError("This session is paused.", 409, "session_paused"))
    .mockResolvedValueOnce({ path: "", entries: [], truncated: false });
  mockChange.mockResolvedValueOnce({ ...session, status: "ready" });
  render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={jest.fn()} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Files" }));
  expect(await screen.findByText(/Resuming starts DigitalOcean compute billing/)).toBeInTheDocument();
  expect(mockChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Resume session/ }));
  await waitFor(() => expect(mockChange).toHaveBeenCalledWith(AGENT, "resume"));
  expect(await screen.findByText(/Nothing in \/workspace yet/)).toBeInTheDocument();
});

describe("Manage on the shared sections", () => {
  const lastChatProps = () => mockChatProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  async function openManage() {
    mockGetWithExpiry.mockResolvedValue({ session, credentialExpiry: null });
    render(<DigitalOceanAgentWorkspace agentId={AGENT} onDeleted={onDeleted} />);
    await screen.findByText("chat surface");
    fireEvent.click(screen.getByRole("tab", { name: "Manage" }));
  }
  const onDeleted = jest.fn();
  beforeEach(() => {
    onDeleted.mockReset();
    // Manage remembers its open section in the address; each test starts clean.
    window.history.replaceState(null, "", "/dashboard/agent/do-agent");
  });

  it("shows Overview, a fixed-size Resources and Advanced, and keeps the chat header's own controls", async () => {
    await openManage();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Chat", "Files", "Manage", "Overview", "Resources", "Advanced"]);
    expect(screen.getByText("Codex · My cloud · DigitalOcean")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    expect(screen.getByTestId("manage-fixed-size")).toHaveTextContent("Fixed size · 2 CPU / 4 GB");
    // The chat still gets the session, and hears about changes Manage makes.
    expect(lastChatProps().session).toEqual(session);
    expect(typeof lastChatProps().onSessionChange).toBe("function");
  });

  it("renames the agent in place", async () => {
    await openManage();
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Reviewer" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(mockRename).toHaveBeenCalledWith(AGENT, "Reviewer"));
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeInTheDocument();
    expect((lastChatProps().session as { name: string }).name).toBe("Reviewer");
  });

  it("pauses from Overview and tells the chat", async () => {
    await openManage();
    mockChange.mockResolvedValueOnce({ ...session, status: "paused" });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(mockChange).toHaveBeenCalledWith(AGENT, "pause"));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect((lastChatProps().session as { status: string }).status).toBe("paused");
  });

  it("deletes from Advanced only after the acknowledgement and the typed name", async () => {
    await openManage();
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand this is irreversible/ }));
    const confirm = screen.getByRole("button", { name: "Permanently destroy" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Type Builder to confirm" }), { target: { value: "Builder" } });
    mockChange.mockResolvedValueOnce({ ...session, status: "deleted" });
    fireEvent.click(confirm);
    await waitFor(() => expect(mockChange).toHaveBeenCalledWith(AGENT, "delete"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });
});
