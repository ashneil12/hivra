/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockGetWithExpiry = jest.fn();
const mockForget = jest.fn();
const mockList = jest.fn();
const mockChange = jest.fn();

jest.mock("@/components/hivra/ManagedSessionChat", () => ({
  ManagedSessionChat: () => <div>chat surface</div>,
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

import { DigitalOceanAgentWorkspace } from "../DigitalOceanAgentWorkspace";
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

beforeEach(() => {
  for (const mock of [mockGetWithExpiry, mockForget, mockList, mockChange]) mock.mockReset();
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
