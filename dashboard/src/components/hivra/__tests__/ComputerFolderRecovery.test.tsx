/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { listAgents, type HivraAgent } from "@/lib/hivra/agent-api";
import { ComputerFolderRecovery } from "../ComputerFolderRecovery";

jest.mock("@/lib/hivra/agent-api", () => ({ listAgents: jest.fn() }));
jest.mock("../ComputerFolderRecovery.module.css", () => ({ page: "page", button: "button", input: "input" }));

beforeEach(() => jest.clearAllMocks());

it("explains where the same limited shared folder appears on both user surfaces", async () => {
  jest.mocked(listAgents).mockResolvedValue([]);
  render(<ComputerFolderRecovery />);
  await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1));
  expect(screen.getByText("/home/ubuntu/Hivra")).not.toBeNull();
  expect(screen.getByText("/home/bux/Hivra")).not.toBeNull();
  expect(screen.getByText(/the same shared folder is/).textContent).toContain("Only files inside this folder are included.");
  expect(screen.getByText(/Not a whole-computer backup/)).not.toBeNull();
  expect((screen.getByRole("button", { name: "Download encrypted folder" }) as HTMLButtonElement).disabled).toBe(true);
});

it("offers only a different destination and clears it when that computer becomes the source", async () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  jest.mocked(listAgents).mockResolvedValue([
    { id: first, name: "First", type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", status: "running" },
    { id: second, name: "Second", type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", status: "running" },
  ] as HivraAgent[]);
  render(<ComputerFolderRecovery />);
  const source = screen.getByLabelText("Original Ubuntu computer") as HTMLSelectElement;
  const destination = screen.getByLabelText("Fresh destination Ubuntu computer") as HTMLSelectElement;
  await waitFor(() => expect(within(source).getAllByRole("option")).toHaveLength(3));
  fireEvent.change(source, { target: { value: first } });
  expect(within(destination).queryByRole("option", { name: "First — running" })).toBeNull();
  fireEvent.change(destination, { target: { value: second } });
  expect(destination.value).toBe(second);
  fireEvent.change(source, { target: { value: second } });
  expect(source.value).toBe(second);
  expect(destination.value).toBe("");
  expect(within(destination).queryByRole("option", { name: "Second — running" })).toBeNull();
  expect(within(destination).getByRole("option", { name: "First — running" })).not.toBeNull();
});

describe("entered from a computer's Manage tab", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const rows = [
    { id: first, name: "First", type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", status: "running" },
    { id: second, name: "Second", type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", status: "running" },
  ] as HivraAgent[];

  beforeEach(() => window.history.replaceState(null, "", `/dashboard/computers/recovery?source=${first}`));
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("links back to that computer's Manage tab by name", async () => {
    jest.mocked(listAgents).mockResolvedValue(rows);
    render(<ComputerFolderRecovery />);
    const back = await screen.findByRole("link", { name: "Back to First" });
    expect(back.getAttribute("href")).toBe(`/dashboard/agent/${first}?tab=manage&section=recovery`);
    expect(screen.queryByRole("link", { name: "Back to computers" })).toBeNull();
  });

  it("keeps .hivra-folder files selectable on iOS and rejects other files before upload", async () => {
    jest.mocked(listAgents).mockResolvedValue(rows);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    render(<ComputerFolderRecovery />);
    const destination = screen.getByLabelText("Fresh destination Ubuntu computer") as HTMLSelectElement;
    await waitFor(() => expect(within(destination).getAllByRole("option")).toHaveLength(2));
    const fileInput = screen.getByLabelText("Encrypted Hivra-folder file") as HTMLInputElement;
    expect(fileInput.accept).toBe(".hivra-folder,application/octet-stream");

    fireEvent.change(screen.getByLabelText(/^Recovery passphrase/), { target: { value: "correct horse battery" } });
    fireEvent.change(destination, { target: { value: second } });
    fireEvent.change(fileInput, { target: { files: [new File(["not an archive"], "notes.txt")] } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Restore without overwriting" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Choose the encrypted .hivra-folder file you exported.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
