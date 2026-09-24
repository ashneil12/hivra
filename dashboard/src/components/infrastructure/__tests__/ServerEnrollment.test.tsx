/** @jest-environment jsdom */

/**
 * My server, command first (slice 13): the command panel and "Is this your
 * server?" (docs/superpowers/specs/2026-09-24-server-enrollment-command.md,
 * sections 4 and 8; T5, T25, T30, T32, T39, T40, T46).
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("@/lib/infrastructure/server-enrollment-client", () => ({
  issueServerEnrollment: jest.fn(),
  getServerEnrollment: jest.fn(),
  confirmServerEnrollment: jest.fn(),
  replaceServerEnrollmentAccess: jest.fn(),
  declineServerEnrollment: jest.fn(),
  cancelServerEnrollment: jest.fn(),
}));

import { InfrastructureApiError } from "@/lib/infrastructure/client";
import {
  cancelServerEnrollment,
  confirmServerEnrollment,
  declineServerEnrollment,
  getServerEnrollment,
  issueServerEnrollment,
  replaceServerEnrollmentAccess,
} from "@/lib/infrastructure/server-enrollment-client";
import type {
  KnownServer,
  ServerEnrollmentDto,
  ServerEnrollmentIssueResult,
} from "@/lib/infrastructure/server-enrollment-contracts";

import { replacementFailureCopy, ServerEnrollmentCard } from "../ServerEnrollmentCard";
import { closedCommandLine, ServerEnrollmentDialog, waitingLine } from "../ServerEnrollmentDialog";

const CODE = "hse1_abcdefghijklmnopqrstuvwxyz234567";
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const UNINSTALL = "curl -fsS --proto '=https' https://hivra.example/enroll/uninstall | sudo bash";

function enrollment(overrides: Partial<ServerEnrollmentDto> = {}): ServerEnrollmentDto {
  return {
    id: "77777777-7777-4777-8777-777777777777", phase: "issued",
    issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 15 * 60_000).toISOString(), confirmBy: null,
    scriptFetches: 0, lastFetchedAt: null, refusedReports: 0, lastRefusal: null, lastRefusedAt: null, report: null,
    knownServer: null, outcome: null, connectionId: null, decidedAt: null, replacementAttempts: 0,
    lastReplacementFailure: null, ...overrides,
  };
}

const FACTS = { hostname: "ip-172-31-4-9", osId: "ubuntu", osVersionId: "24.04", architecture: "x86_64", cpuCount: 4,
  memoryBytes: 16 * 1024 ** 3, virtualization: "kvm", proxmoxVersion: null, sshMatchRules: false };

function reported(overrides: Partial<NonNullable<ServerEnrollmentDto["report"]>> = {}, known: KnownServer | null = null) {
  return enrollment({
    phase: "reported", scriptFetches: 1, lastFetchedAt: new Date(NOW - 20_000).toISOString(),
    confirmBy: new Date(NOW + 30 * 60_000).toISOString(),
    report: { kind: "enrolled", reportedAt: new Date(NOW - 12_000).toISOString(), observedAddress: "203.0.113.24", sshPort: 22,
      hostFingerprintSha256: "SHA256:" + "X".repeat(43), facts: FACTS, consent: "terminal", words: "amber-falcon-river",
      reenrollment: false, ...overrides },
    knownServer: known,
  });
}

const ISSUED: ServerEnrollmentIssueResult = {
  enrollment: enrollment(),
  command: `curl -fsS --proto '=https' -H 'Authorization: Bearer ${CODE}' https://hivra.example/enroll | sudo bash`,
  dryRunCommand: `curl -fsS --proto '=https' -H 'Authorization: Bearer ${CODE}' https://hivra.example/enroll | bash -s -- --dry-run`,
  downloadCommand: `curl -fsS --proto '=https' -H 'Authorization: Bearer ${CODE}' https://hivra.example/enroll -o hivra-enroll.sh`,
  uninstallCommand: UNINSTALL,
  finalLine: `{ hivra_enroll_entry "$@" HIVRA_ARGS_V1 'https://hivra.example' '${CODE}' 'ssh-ed25519 AAAA' 'K7QM-2XRA' HIVRA_END_V1; }`,
  downloadSha256: "d".repeat(64), scriptVersion: "2026.09.24.1", scriptSha256: "e".repeat(64), accountCode: "K7QM-2XRA",
  origin: "https://hivra.example",
};

function known(overrides: Partial<KnownServer> = {}): KnownServer {
  return { connectionId: "88888888-8888-4888-8888-888888888888", connectionName: "web-1", connectionRevision: 3,
    provider: "host", sshUser: "hivra", sshHost: "198.51.100.7", offer: "replace_key", reason: null, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  (issueServerEnrollment as jest.Mock).mockResolvedValue(ISSUED);
  (getServerEnrollment as jest.Mock).mockResolvedValue(enrollment());
  (cancelServerEnrollment as jest.Mock).mockResolvedValue(undefined);
  (declineServerEnrollment as jest.Mock).mockResolvedValue(undefined);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => jest.useRealTimers());

function renderDialog() {
  const handlers = { onClose: jest.fn(), onUseSshDetails: jest.fn(), onConnected: jest.fn(), onAccessReplaced: jest.fn(),
    onChanged: jest.fn(), onDeclined: jest.fn(), onConnectionsChanged: jest.fn() };
  render(<ServerEnrollmentDialog {...handlers} />);
  return handlers;
}

describe("the command panel", () => {
  it("shows one command with Copy, its expiry and the account code, and never puts the code in a link or storage (T5, T25)", async () => {
    renderDialog();
    expect(await screen.findByTestId("server-enrollment-command")).toHaveTextContent(ISSUED.command);
    expect(screen.getByRole("button", { name: "Copy the setup command" })).toBeInTheDocument();
    expect(screen.getByText(/Single use · expires in 15:00/)).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(8_000); });
    expect(screen.getByText(/Single use · expires in 14:52/)).toBeInTheDocument();
    expect(screen.getByText("K7QM-2XRA")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View the script first" }));
    expect(screen.getByText("Published script sha256")).toBeInTheDocument();
    expect(screen.getByText(/The downloaded file contains your one-time code\. Delete it when/)).toBeInTheDocument();
    for (const link of document.querySelectorAll("a")) expect(link.getAttribute("href") ?? "").not.toContain(CODE);
    expect(window.location.href).not.toContain(CODE);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(CODE);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(CODE);
    // The page says Proxmox VE needs the advanced path for now.
    expect(screen.getByText(/Proxmox VE connects with a root login for now/)).toBeInTheDocument();
  });

  it("reports only what Hivra observed while it waits", () => {
    const now = NOW + 41_000;
    expect(waitingLine(enrollment(), now)).toBe("Waiting for your server… no contact yet · 0:41");
    expect(waitingLine(enrollment({ scriptFetches: 1, lastFetchedAt: new Date(NOW + 30_000).toISOString() }), now))
      .toMatch(/^The setup script was downloaded with your command at .+\. Waiting for its report · 0:11$/);
    expect(waitingLine(enrollment({ scriptFetches: 1, lastRefusal: "ipv4_required", lastRefusedAt: new Date(NOW).toISOString() }), now))
      .toMatch(/^Hivra refused a report for your command at .+: it arrived over IPv6 only\. Hosted Hivra reaches servers over IPv4 for now\.$/);
    expect(waitingLine(enrollment({ scriptFetches: 20 }), now)).toBe("Your command reached its download limit. Get a new command.");
  });

  it("turns into \"Is this your server?\" as soon as the report lands", async () => {
    renderDialog();
    await screen.findByTestId("server-enrollment-command");
    (getServerEnrollment as jest.Mock).mockResolvedValue(reported());
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(await screen.findByRole("heading", { level: 1, name: "Is this your server?" })).toBeInTheDocument();
    expect(screen.getByText("amber falcon river")).toBeInTheDocument();
  });

  it("gets a new command in place of the old one", async () => {
    renderDialog();
    await screen.findByTestId("server-enrollment-command");
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await waitFor(() => expect(issueServerEnrollment).toHaveBeenLastCalledWith(ISSUED.enrollment.id));
  });

  // The owner may copy the command, close the panel, then paste it on the
  // server: closing must not cancel it, used or not. The page lists it with
  // Cancel until it is used or expires, and the panel says so.
  it.each([
    ["a command no server has downloaded", enrollment()],
    ["a downloaded command", enrollment({ scriptFetches: 1, lastFetchedAt: new Date(NOW).toISOString() })],
  ])("never cancels %s when the panel closes", async (_label, current) => {
    const handlers = renderDialog();
    await screen.findByTestId("server-enrollment-command");
    (getServerEnrollment as jest.Mock).mockResolvedValue(current);
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(screen.getByText(/Closing this panel doesn't cancel the command\. Until it's used or expires, Capacity lists it/))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close server setup" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(cancelServerEnrollment).not.toHaveBeenCalled();
  });

  // Review (round 2): the clock re-rendered every second inside an aria-live
  // region, so a screen reader could announce it continuously.
  it("announces a change of state, never the ticking clock", async () => {
    renderDialog();
    await screen.findByTestId("server-enrollment-command");
    await act(async () => { jest.advanceTimersByTime(41_000); });
    const waiting = screen.getByTestId("server-enrollment-waiting");
    expect(waiting).toHaveTextContent("Waiting for your server… no contact yet · 0:41 — check your terminal if nothing happens.");
    const live = within(waiting).getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live.textContent).toBe("Waiting for your server… no contact yet");
    await act(async () => { jest.advanceTimersByTime(1_000); });
    expect(waiting).toHaveTextContent("no contact yet · 0:42");
    expect(live.textContent).toBe("Waiting for your server… no contact yet");
    // A download Hivra observed is a change of state: that is announced.
    (getServerEnrollment as jest.Mock).mockResolvedValue(enrollment({ scriptFetches: 1, lastFetchedAt: new Date(NOW + 43_000).toISOString() }));
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(within(screen.getByTestId("server-enrollment-waiting")).getByRole("status").textContent)
      .toMatch(/^The setup script was downloaded with your command at .+\. Waiting for its report$/);
  });

  it("never cancels the command when the owner switches to the SSH details wizard", async () => {
    const handlers = renderDialog();
    await screen.findByTestId("server-enrollment-command");
    fireEvent.click(screen.getByRole("button", { name: /Connect with SSH details instead \(advanced\)/ }));
    expect(handlers.onUseSshDetails).toHaveBeenCalledTimes(1);
    expect(cancelServerEnrollment).not.toHaveBeenCalled();
  });

});

// Review (round 2): after No the poll read the command back as rejected; the
// card unmounted and the panel said "This command expired", dropping the
// uninstall command. A command used elsewhere read as expired too.
describe("the panel after the answer", () => {
  async function reachQuestion() {
    const handlers = renderDialog();
    await screen.findByTestId("server-enrollment-command");
    (getServerEnrollment as jest.Mock).mockResolvedValue(reported());
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await screen.findByRole("heading", { level: 1, name: "Is this your server?" });
    return handlers;
  }

  it("keeps \"Cancelled.\" and the uninstall command after No, once the poll reads the command as rejected (T39)", async () => {
    const handlers = await reachQuestion();
    fireEvent.click(screen.getByRole("button", { name: "No, cancel" }));
    expect(await screen.findByText("Cancelled.")).toBeInTheDocument();
    expect(handlers.onDeclined).toHaveBeenCalledWith(expect.objectContaining({ id: reported().id, phase: "rejected" }));

    (getServerEnrollment as jest.Mock).mockResolvedValue({ ...reported(), phase: "rejected",
      decidedAt: new Date(NOW + 5_000).toISOString() });
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(screen.getByText("Cancelled.")).toBeInTheDocument();
    expect(screen.getByText(UNINSTALL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the uninstall command" })).toBeInTheDocument();
    expect(screen.queryByText(/expired/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await waitFor(() => expect(issueServerEnrollment).toHaveBeenLastCalledWith(null));
  });

  it("says a command used elsewhere connected the server, and refreshes the page's connections", async () => {
    const handlers = await reachQuestion();
    (getServerEnrollment as jest.Mock).mockResolvedValue({ ...reported(), phase: "confirmed", outcome: "connected",
      connectionId: "99999999-9999-4999-8999-999999999999", decidedAt: new Date(NOW + 5_000).toISOString() });
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(await screen.findByText("This command was used, and your server is connected. Close this panel to see it under Capacity."))
      .toBeInTheDocument();
    expect(screen.queryByText(/expired/)).not.toBeInTheDocument();
    expect(handlers.onConnectionsChanged).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(4_000); });
    expect(handlers.onConnectionsChanged).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ phase: "cancelled" as const }, "This command was cancelled. Get a new command."],
    [{ phase: "cancelled" as const, refusedReports: 10 }, "This command was cancelled after 10 refused reports. Get a new command."],
    [{ phase: "confirmed" as const, outcome: "replaced_access" as const },
      "This command was used, and your server's access was replaced. Close this panel to see it under Capacity."],
    [{ phase: "rejected" as const }, "This command was cancelled after No was chosen. Get a new command."],
    [{ phase: "expired" as const }, "This command expired. Get a new command."],
  ])("names how a command ended (%o)", (overrides, copy) => {
    expect(closedCommandLine(enrollment(overrides))).toBe(copy);
  });
});

function renderCard(item: ServerEnrollmentDto) {
  const handlers = { onConfirmed: jest.fn(), onReplaced: jest.fn(), onDeclined: jest.fn(), onNewCommand: jest.fn() };
  render(<ServerEnrollmentCard enrollment={item} uninstallCommand={UNINSTALL} {...handlers} />);
  return handlers;
}

describe("Is this your server?", () => {
  it("keeps what Hivra saw apart from what the server claims, with the words and the identity (T18, T32)", () => {
    renderCard(reported());
    const facts = screen.getByRole("heading", { name: "Is this your server?" }).closest("section")!;
    expect(within(facts).getByText("Connected from (seen by Hivra)").nextSibling).toHaveTextContent("203.0.113.24");
    expect(within(facts).getByText("Reported by the server").nextSibling)
      .toHaveTextContent("ip-172-31-4-9 · Ubuntu 24.04 · x86 · 4 CPU · 16 GB · approved at its terminal");
    expect(within(facts).getByText("amber falcon river")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the server identity" })).toBeInTheDocument();
    expect(screen.getByText(/A server used your setup command 12 seconds ago\./)).toBeInTheDocument();
    // The lost-acknowledgement and leaked-code guidance (T40).
    expect(screen.getByText(/If your terminal said Hivra didn't answer, choose No and run a new command\./)).toBeInTheDocument();
    expect(screen.getByText(/If your terminal said the command was already used, someone else has your command: choose No\./))
      .toBeInTheDocument();
    expect(screen.getByText("Hivra will connect to 203.0.113.24 on port 22 as hivra.", { exact: false })).toBeInTheDocument();
  });

  it("gives Yes and No the same weight (T32)", () => {
    renderCard(reported());
    const yes = screen.getByRole("button", { name: "Yes, this is my server" });
    const no = screen.getByRole("button", { name: "No, cancel" });
    expect(yes.className).toBe(no.className);
  });

  it("labels a run without a terminal", () => {
    renderCard(reported({ consent: "no_terminal" }));
    expect(screen.getByText(/run without a terminal \(--yes\)/)).toBeInTheDocument();
  });

  it("confirms at the observed address, or at one the owner enters when Hivra saw none", async () => {
    const connection = { id: "c" };
    (confirmServerEnrollment as jest.Mock).mockResolvedValue(connection);
    const handlers = renderCard(reported());
    fireEvent.click(screen.getByRole("button", { name: "Yes, this is my server" }));
    await waitFor(() => expect(handlers.onConfirmed).toHaveBeenCalledWith(connection));
    expect(confirmServerEnrollment).toHaveBeenCalledWith(reported().id, null);
  });

  it("asks for the address when Hivra couldn't see one", async () => {
    (confirmServerEnrollment as jest.Mock).mockResolvedValue({ id: "c" });
    renderCard(reported({ observedAddress: null }));
    expect(screen.getByText("Hivra couldn't see this server's address")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes, this is my server" }));
    expect(await screen.findByText(/Enter the server's public IPv4 address or hostname/)).toBeInTheDocument();
    expect(confirmServerEnrollment).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("The server's public IPv4 address"), { target: { value: "203.0.113.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Yes, this is my server" }));
    await waitFor(() => expect(confirmServerEnrollment).toHaveBeenCalledWith(reported().id, "203.0.113.50"));
  });

  it("No deletes Hivra's key and shows the uninstall command (T39)", async () => {
    const handlers = renderCard(reported());
    fireEvent.click(screen.getByRole("button", { name: "No, cancel" }));
    expect(await screen.findByText("Cancelled.")).toBeInTheDocument();
    expect(screen.getByText(UNINSTALL)).toBeInTheDocument();
    expect(declineServerEnrollment).toHaveBeenCalledWith(reported().id);
    expect(handlers.onDeclined).toHaveBeenCalled();
  });

  it("offers Replace instead of Yes for a server already connected, and says it signs in first (T30)", async () => {
    (replaceServerEnrollmentAccess as jest.Mock).mockResolvedValue({ id: "88888888-8888-4888-8888-888888888888" });
    const handlers = renderCard(reported({}, known()));
    expect(screen.getByText(/It reports the same SSH identity as/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, this is my server" })).not.toBeInTheDocument();
    expect(screen.getByText(/Hivra first signs in to web-1 at 198\.51\.100\.7 with the new key\./)).toBeInTheDocument();
    const replace = screen.getByRole("button", { name: "Replace web-1's access" });
    expect(replace.className).toBe(screen.getByRole("button", { name: "No, cancel" }).className);
    fireEvent.click(replace);
    await waitFor(() => expect(handlers.onReplaced).toHaveBeenCalled());
    expect(replaceServerEnrollmentAccess).toHaveBeenCalledWith(reported().id,
      { connectionId: known().connectionId, connectionRevision: 3, sshHost: null });
  });

  it("offers a switch for a login connection nobody's agents use", () => {
    renderCard(reported({}, known({ offer: "switch_user", sshUser: "root" })));
    expect(screen.getByRole("button", { name: "Switch web-1 to the hivra user" })).toBeInTheDocument();
  });

  // 8.1 step 3: a switch may sign in at an address the owner chooses.
  it("lets the owner choose the address a switch signs in at", async () => {
    (replaceServerEnrollmentAccess as jest.Mock).mockResolvedValue({ id: known().connectionId });
    const handlers = renderCard(reported({}, known({ offer: "switch_user", sshUser: "root" })));
    expect(screen.getByText(/Hivra will sign in to web-1 at 198\.51\.100\.7 as hivra\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use a different address" }));
    fireEvent.change(screen.getByLabelText("Sign in at this address instead"), { target: { value: "https://203.0.113.9/" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch web-1 to the hivra user" }));
    expect(await screen.findByText(/Enter the server's public IPv4 address or hostname/)).toBeInTheDocument();
    expect(replaceServerEnrollmentAccess).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Sign in at this address instead"), { target: { value: "203.0.113.9" } });
    expect(screen.getByText(/Hivra first signs in to web-1 at 203\.0\.113\.9 with the new key\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch web-1 to the hivra user" }));
    await waitFor(() => expect(handlers.onReplaced).toHaveBeenCalled());
    expect(replaceServerEnrollmentAccess).toHaveBeenCalledWith(reported().id,
      { connectionId: known().connectionId, connectionRevision: 3, sshHost: "203.0.113.9" });
  });

  it("keeps a key-only Replace at the connection's address, with no address control", () => {
    renderCard(reported({}, known()));
    expect(screen.queryByRole("button", { name: "Use a different address" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it.each([
    ["login_in_use", "host", "root", "web-1 is already connected as root, and its agents use that connection. Hivra didn't change it."],
    ["proxmox_needs_root", "host", "root", "web-1 runs Proxmox VE, which needs a root login for now. Hivra didn't change it."],
    ["proxmox_connection", "proxmox", "root",
      "This SSH identity belongs to web-1, a Proxmox server connected as root. Proxmox connections keep their root login, so Hivra didn't change it."],
    ["hetzner", "hetzner-cloud", null, "This SSH identity belongs to web-1, a server Hivra created on Hetzner. Manage it from its card."],
    ["multiple", "host", "root", "More than one of your connections uses this SSH identity. Remove the extra ones first."],
  ] as const)("offers only No when Replace isn't allowed (%s) (T46)", (reason, provider, sshUser, copy) => {
    renderCard(reported({}, known({ offer: "none", reason, provider, sshUser })));
    expect(screen.getByText(copy, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Replace|Switch|Yes/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No, cancel" })).toBeInTheDocument();
  });

  it("explains a failed Replace check without changing anything", async () => {
    (replaceServerEnrollmentAccess as jest.Mock).mockRejectedValue(
      new InfrastructureApiError("The server didn't accept the new key, so Hivra changed nothing.", 422, "verification_failed",
        null, { cause: "authentication_failed" }));
    renderCard(reported({}, known()));
    fireEvent.click(screen.getByRole("button", { name: "Replace web-1's access" }));
    expect(await screen.findByText(/web-1 didn't accept the new key, so Hivra changed nothing: web-1 keeps the access it had before\./))
      .toBeInTheDocument();
    expect(replacementFailureCopy("host_key_mismatch", "web-1", "198.51.100.7"))
      .toContain("If you ran the command on a copy of web-1, that server has web-1's SSH identity.");
    expect(replacementFailureCopy("proxmox_needs_root", "web-1", null))
      .toBe("web-1 runs Proxmox VE, which needs a root login for now, so Hivra didn't switch it to the hivra user and changed nothing. To remove the hivra user this command added, run the uninstall command.");
  });

  it("frames an unsupported report as a server that used the command, not as the owner's server (T39)", () => {
    const handlers = renderCard(reported({ kind: "unsupported", words: null, hostFingerprintSha256: null, sshPort: null,
      facts: { ...FACTS, osVersionId: "20.04" } }));
    expect(screen.getByRole("heading", { name: "A server used your setup command from 203.0.113.24 and reported Ubuntu 20.04 on x86." }))
      .toBeInTheDocument();
    expect(screen.getByText(/Rebuild this server with a supported image, then run a new command\./)).toBeInTheDocument();
    expect(screen.getByText("If you didn't run the command, someone else has it. That command no longer works, and nothing was connected."))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    expect(handlers.onNewCommand).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Yes, this is my server" })).not.toBeInTheDocument();
  });

  it("sends a Proxmox VE report to the root login instead of a rebuild", () => {
    renderCard(reported({ kind: "unsupported", words: null, hostFingerprintSha256: null, sshPort: null,
      facts: { ...FACTS, osId: "debian", osVersionId: "12", proxmoxVersion: "8.2.4" } }));
    expect(screen.getByText(/The setup command doesn't connect Proxmox VE yet\. Proxmox VE servers connect with a root login/))
      .toBeInTheDocument();
    expect(screen.queryByText(/Rebuild this server/)).not.toBeInTheDocument();
  });
});
