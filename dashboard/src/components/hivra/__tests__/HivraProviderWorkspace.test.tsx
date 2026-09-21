/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HivraProviderWorkspace } from "../HivraProviderWorkspace";
import { listBoxFiles, writeBoxFile } from "@/lib/hivra/agent-api";
import type { WorkspacePhase } from "@/lib/hivra/workspace-browser-bridge";

let mockStatus: (phase: WorkspacePhase) => void;
let mockConnected = false;
const mockList = jest.fn(), mockRead = jest.fn(), mockWrite = jest.fn(), mockDispose = jest.fn(), mockConnect = jest.fn();
jest.mock("@/lib/hivra/agent-api", () => ({ listBoxFiles: jest.fn(), readBoxFile: jest.fn(), writeBoxFile: jest.fn() }));
jest.mock("@/lib/hivra/workspace-browser-bridge", () => ({ createWorkspaceBrowserBridge: (_id: string, _origin: string, _surface: string,
  ports: { status: (phase: WorkspacePhase) => void }) => {
  mockStatus = ports.status;
  return { files: { list: mockList, read: mockRead, write: mockWrite }, receive: () => undefined,
    connect: () => { mockConnect(); mockConnected = true; ports.status("connected"); },
    disconnect: () => { mockConnected = false; ports.status("disconnected"); }, dispose: mockDispose };
} }));
const props = { computerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boxOrigin: "https://box.hermesos.cloud", surface: "files" as const, active: true };
beforeEach(() => {
  jest.clearAllMocks(); mockConnected = false;
  mockList.mockResolvedValue({ path: ".", entries: [{ name: "draft.txt", type: "file", size: 3, mtime: 1 }], error: null });
  mockRead.mockResolvedValue({ content: "old", error: null });
  mockWrite.mockImplementation(async () => mockConnected ? { ok: true, error: null } : { ok: false, error: "Reconnect before saving" });
});
it("preserves unsaved edits across expiry, tab hiding and an explicit reconnect", async () => {
  const view = render(<HivraProviderWorkspace {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /draft.txt/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "my unsaved draft" } });
  act(() => { mockConnected = false; mockStatus("disconnected"); });
  expect(screen.getByRole("textbox")).toHaveValue("my unsaved draft");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Reconnect before saving")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("my unsaved draft");
  view.rerender(<HivraProviderWorkspace {...props} active={false} />);
  expect(screen.getByRole("textbox", { hidden: true })).toHaveValue("my unsaved draft");
  view.rerender(<HivraProviderWorkspace {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Reconnect Files" }));
  expect(screen.getByRole("textbox")).toHaveValue("my unsaved draft");
  expect(mockList).toHaveBeenCalledTimes(1); expect(mockConnect).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  expect(screen.getByText("my unsaved draft")).toBeInTheDocument();
  expect(mockWrite).toHaveBeenLastCalledWith("draft.txt", "my unsaved draft");
  expect(listBoxFiles).not.toHaveBeenCalled(); expect(writeBoxFile).not.toHaveBeenCalled();
  view.unmount(); expect(mockDispose).toHaveBeenCalledTimes(1);
});
it("opens lazily and closes authority on pagehide without auto-reconnecting", async () => {
  const view = render(<HivraProviderWorkspace {...props} active={false} />);
  expect(mockConnect).not.toHaveBeenCalled();
  view.rerender(<HivraProviderWorkspace {...props} />);
  await screen.findByRole("button", { name: /draft.txt/ });
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(screen.getByRole("button", { name: "Reconnect Files" })).toBeInTheDocument();
  expect(mockConnect).toHaveBeenCalledTimes(1);
});
