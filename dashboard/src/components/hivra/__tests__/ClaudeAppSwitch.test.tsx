/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  claudeAppInstall,
  claudeAppRemove,
  claudeAppSetView,
  claudeAppStatus,
  type ClaudeAppStatus,
} from "@/lib/hivra/agent-api";
import { ClaudeAppSwitch } from "../ClaudeAppSwitch";

jest.mock("@/lib/hivra/agent-api", () => ({
  claudeAppStatus: jest.fn(),
  claudeAppInstall: jest.fn(),
  claudeAppSetView: jest.fn(),
  claudeAppRemove: jest.fn(),
}));
jest.mock("../ClaudeAppSwitch.module.css", () => new Proxy({}, { get: (_target, key) => String(key) }));

const base: ClaudeAppStatus = {
  enabled: true, desktopRunning: true, installedVersion: "2.26454.0", pinnedVersion: "2.26454.0", updateAvailable: false,
  appRunning: true, mode: "app", profileSaved: true, installing: false, lastError: null,
};
const showing = (status: Partial<ClaudeAppStatus>) =>
  jest.mocked(claudeAppStatus).mockResolvedValue({ available: true, status: { ...base, ...status }, error: null });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(claudeAppInstall).mockResolvedValue({ ok: true, error: null });
  jest.mocked(claudeAppSetView).mockResolvedValue({ ok: true, applied: true, error: null });
  jest.mocked(claudeAppRemove).mockResolvedValue({ ok: true, error: null });
});

const mount = (active = true) => render(<ClaudeAppSwitch boxUrl="https://box.example" token="t" active={active} />);

it("renders nothing on a computer that does not offer the Claude app", async () => {
  jest.mocked(claudeAppStatus).mockResolvedValue({ available: false, status: null, error: null });
  const { container } = mount();
  await waitFor(() => expect(claudeAppStatus).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});

it("renders nothing while the status cannot be read, rather than guessing", async () => {
  jest.mocked(claudeAppStatus).mockResolvedValue({ available: true, status: null, error: "HTTP 502" });
  const { container } = mount();
  await waitFor(() => expect(claudeAppStatus).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});

it("does not poll while the desktop tab is not shown", () => {
  showing({});
  mount(false);
  expect(claudeAppStatus).not.toHaveBeenCalled();
});

describe("before the app is added", () => {
  it("explains what it downloads, from whom, and that the sign-in is the owner's, before adding anything", async () => {
    showing({ enabled: false, installedVersion: null, appRunning: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add Claude app" }));
    const dialog = screen.getByRole("dialog", { name: "Add the Claude app" });
    expect(dialog.textContent).toContain("from Anthropic");
    expect(dialog.textContent).toContain("about 180 MB");
    expect(dialog.textContent).toContain("with your own Claude account");
    expect(dialog.textContent).toContain("Hivra never sees or stores that sign-in");
    expect(claudeAppInstall).not.toHaveBeenCalled();
  });

  it("adds the app only after the owner confirms, then shows progress", async () => {
    showing({ enabled: false, installedVersion: null, appRunning: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add Claude app" }));
    showing({ enabled: false, installing: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Add Claude app" })[1]);
    await waitFor(() => expect(claudeAppInstall).toHaveBeenCalledWith("https://box.example", "t"));
    expect(await screen.findByText("Adding the Claude app…")).not.toBeNull();
  });

  it("says why an add failed", async () => {
    showing({ enabled: false, installedVersion: null, appRunning: false, lastError: "downloaded package does not match the pinned size and SHA-256" });
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("does not match the pinned size");
  });

  it("surfaces a refusal from the computer", async () => {
    showing({ enabled: false, installedVersion: null, appRunning: false });
    jest.mocked(claudeAppInstall).mockResolvedValue({ ok: false, error: "the Claude app is not available on this computer" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add Claude app" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Add Claude app" })[1]);
    expect((await screen.findByRole("alert")).textContent).toContain("not available on this computer");
  });
});

describe("with the app added", () => {
  it("shows the saved view as the selected one", async () => {
    showing({ mode: "desktop" });
    mount();
    const desktop = await screen.findByRole("radio", { name: "Desktop" });
    expect(desktop.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Claude app" }).getAttribute("aria-checked")).toBe("false");
  });

  it("switches the view and keeps the choice", async () => {
    showing({ mode: "app" });
    mount();
    fireEvent.click(await screen.findByRole("radio", { name: "Desktop" }));
    await waitFor(() => expect(claudeAppSetView).toHaveBeenCalledWith("https://box.example", "desktop", "t"));
    expect(screen.getByRole("radio", { name: "Desktop" }).getAttribute("aria-checked")).toBe("true");
  });

  it("puts the selection back and says so when the switch fails", async () => {
    showing({ mode: "app" });
    jest.mocked(claudeAppSetView).mockResolvedValue({ ok: false, error: "The view could not be switched." });
    mount();
    fireEvent.click(await screen.findByRole("radio", { name: "Desktop" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be switched");
    expect(screen.getByRole("radio", { name: "Claude app" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says the app is starting until it is running", async () => {
    showing({ appRunning: false });
    mount();
    expect(await screen.findByText("Starting…")).not.toBeNull();
  });

  it("offers an update only when the pinned version differs, and warns that it restarts the app", async () => {
    showing({ updateAvailable: true, pinnedVersion: "2.30000.0" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    const dialog = screen.getByRole("dialog", { name: "Update the Claude app" });
    expect(dialog.textContent).toContain("2.30000.0");
    expect(dialog.textContent).toContain("restarts to apply it");
    expect(claudeAppInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
    await waitFor(() => expect(claudeAppInstall).toHaveBeenCalledTimes(1));
  });

  it("shows no update button when current", async () => {
    showing({});
    mount();
    await screen.findByRole("radio", { name: "Desktop" });
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("removes the app and its saved sign-in only after a confirmation", async () => {
    showing({});
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Claude app options" }));
    expect(screen.getByRole("dialog").textContent).toContain("deletes the app and its saved sign-in");
    expect(claudeAppRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove the Claude app" }));
    await waitFor(() => expect(claudeAppRemove).toHaveBeenCalledWith("https://box.example", "t"));
  });
});
