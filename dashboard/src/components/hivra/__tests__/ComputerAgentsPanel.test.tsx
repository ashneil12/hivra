/** @jest-environment jsdom */
// Computer page → Manage → "Agents on this computer" (design 5.8; threats
// T20, T21, T34, T35): the gate's rows, the Review with its isolation line,
// one request id per review, progress from receipts only, the plan limit with
// a Billing link and no Review, and the contract's "checked by Hivra" only
// after root's read-back.
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ComputerAgentsPanel } from "../ComputerAgentsPanel";

const COMPUTER = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT = "44444444-4444-4444-8444-444444444444";
const REVIEWS = { workspaceOn: "1".repeat(64), workspaceOff: "0".repeat(64) };
const POLICY = { grantPolicySha256: "a".repeat(64), servicePolicySha256: "b".repeat(64), installerSha256: "c".repeat(64) };

function gate(overrides: Record<string, unknown> = {}) {
  return { computer: { id: COMPUTER, name: "MY_UBUNTU_DESKTOP", cpu: 2, ramGb: 4, deploymentMode: "hivra-managed" }, available: true,
    reason: null, message: null, billingHref: null, reviews: REVIEWS, policy: POLICY, attachments: [], ...overrides };
}
function attachment(overrides: Record<string, unknown> = {}) {
  return { id: ATTACHMENT, phase: "attached", agentName: "Codex", runtimeId: "codex", agentIdentityId: ATTACHMENT, grants: { workspace: true },
    endReason: null, createdAt: new Date(Date.now() - 60_000).toISOString(), dispatchedAt: null, completedAt: null, endedAt: null,
    deploymentMode: "hivra-managed", installationId: "55555555-5555-4555-8555-555555555555",
    receipts: { accepted: null, staged: null, started: null, chatReady: null }, contract: null, operation: null,
    chatPath: "/agents/55555555-5555-4555-8555-555555555555", reviews: { accessChange: "d".repeat(64), remove: "e".repeat(64) }, ...overrides };
}

type Reply = { status: number; body?: unknown };
const calls: Array<{ url: string; init?: RequestInit }> = [];
function serve(...replies: Reply[]) {
  const queue = [...replies];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body } as Response;
  }) as typeof fetch;
}
const ready = (body: unknown): Reply => ({ status: 200, body: { success: true, data: body } });
const posted = () => calls.filter((call) => call.init?.method && call.init.method !== "GET");

beforeEach(() => { calls.length = 0; });

it("keeps the honest slot where attach is not offered", async () => {
  serve({ status: 404 });
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
  expect(await screen.findByText(/Adding an agent to a computer you already have isn.t available yet/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Add an agent/ })).not.toBeInTheDocument();
});

it("walks the gate and the Review, sending one claim with the review the owner saw (T20, T21)", async () => {
  serve(ready(gate()), { status: 503, body: { success: false, error: "This step could not be started right now. Nothing was changed." } },
    { status: 202, body: { success: true, data: { operationId: "22222222-2222-4222-8222-222222222222", resumed: false } } }, ready(gate()));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
  fireEvent.click(await screen.findByRole("button", { name: /Add an agent/ }));

  const gateGroup = screen.getByRole("group", { name: "What can Codex use on \u201cMY_UBUNTU_DESKTOP\u201d?" });
  for (const label of ["Your Hivra folder (~/Hivra), read and write", "Its own user on this computer", "Internet",
    "This computer's other services and local network", "Chrome profile", "Desktop control", "Administrator (sudo)",
    "Your personal home folder", "Resources"]) expect(within(gateGroup).getByText(label)).toBeInTheDocument();
  expect(within(gateGroup).getByText("Never offered")).toBeInTheDocument();
  // A screen reader hears the row, not a bare "On, checkbox".
  fireEvent.click(within(gateGroup).getByRole("checkbox", { name: "Your Hivra folder (~/Hivra), read and write" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to review" }));

  const review = screen.getByRole("group", { name: "Add Codex to \u201cMY_UBUNTU_DESKTOP\u201d" });
  expect(within(review).getByText("Isolation: a separate user on this computer. That is weaker than giving Codex its own computer."))
    .toBeInTheDocument();
  expect(within(review).getByText("Codex can: use its own terminal and reach the internet. It has no shared folder.")).toBeInTheDocument();
  expect(within(review).getByText(/Isolation class: shared-kernel/)).toBeInTheDocument();

  fireEvent.click(within(review).getByRole("button", { name: /Add Codex to this computer/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was changed.");
  fireEvent.click(within(review).getByRole("button", { name: /Add Codex to this computer/ }));
  await waitFor(() => expect(posted()).toHaveLength(2));

  const [first, second] = posted().map((call) => JSON.parse(String(call.init!.body)));
  expect(first).toEqual({ grants: { workspace: false }, reviewSha256: REVIEWS.workspaceOff, requestId: expect.any(String) });
  // A retry of the same review is the same claim, never a second install.
  expect(second.requestId).toBe(first.requestId);
  expect(posted()[0].url).toBe(`/api/hivra/computers/${COMPUTER}/agents`);
});

it("at the plan's agent limit shows the plan copy and a Billing link, and no Review (T35)", async () => {
  const message = "Your Free plan allows 1 active agent and you already have 1. Upgrade for more slots, or remove an agent first.";
  serve(ready(gate({ available: false, reason: "plan_agent_limit", message, billingHref: "/dashboard/billing", reviews: null })));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" autoOpenAdd />);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("href", "/dashboard/billing");
  expect(screen.queryByRole("button", { name: /Add an agent|Continue to review|Add Codex/ })).not.toBeInTheDocument();
});

it("says a computer that can't take Codex is not available yet", async () => {
  serve(ready(gate({ available: false, reason: "unsupported_computer", message: "Not available to add to an existing computer yet", reviews: null })));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="Omarchy box" />);
  expect(await screen.findByText("Not available to add to an existing computer yet. An agent you launch gets its own computer."))
    .toBeInTheDocument();
  expect(screen.queryByText(/No agent works on this computer/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Add an agent/ })).not.toBeInTheDocument();
});

it("opens the gate from Launch's deep link, with the honest pair line", async () => {
  serve(ready(gate()));
  window.history.replaceState(null, "", `/dashboard/agent/${COMPUTER}?tab=manage&addAgent=1`);
  try {
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    const group = await screen.findByRole("group", { name: "What can Codex use on \u201cMY_UBUNTU_DESKTOP\u201d?" });
    expect(within(group).getByText("Adds a new Codex to MY_UBUNTU_DESKTOP. Your other agents stay as they are.")).toBeInTheDocument();
  } finally {
    window.history.replaceState(null, "", "/");
  }
});

it("does not open the gate without the deep link", async () => {
  serve(ready(gate()));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
  expect(await screen.findByRole("button", { name: /Add an agent/ })).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: /What can Codex use/ })).not.toBeInTheDocument();
});

it.each([
  ["computer_not_ready", "This computer isn't ready yet. Add Codex once it has finished starting."],
  ["computer_not_running", "Start the computer to add Codex."],
])("refuses Add on a computer that is not running and ready (%s), with no Review", async (reason, message) => {
  serve(ready(gate({ available: false, reason, message, reviews: null })));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" autoOpenAdd />);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Add an agent|Continue to review|Add Codex/ })).not.toBeInTheDocument();
});

it.each([
  ["computer_not_ready", "Codex wasn't added: this computer wasn't ready and didn't answer Hivra. Nothing was installed."],
  ["computer_not_running", "Codex wasn't added: this computer wasn't running. Nothing was installed."],
  ["install_failed", "Adding Codex didn't finish. Hivra removed what it had installed"],
])("ends a refused or failed add as failed with its reason (%s), and offers Add again", async (endReason, copy) => {
  serve(ready(gate({ attachments: [attachment({ phase: "failed", endReason, reviews: null, chatPath: null })] })));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
  expect(await screen.findByText((text) => text.startsWith(copy))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Add an agent/ })).toBeInTheDocument();
});

it("tells the page when an agent finished being added, so its Chat tab follows", async () => {
  const changed = jest.fn();
  window.addEventListener("hivra:attached-agents-changed", changed);
  try {
    serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment({ phase: "dispatched", reviews: null,
      chatPath: null, receipts: { accepted: new Date().toISOString(), staged: null, started: null, chatReady: null } })] })),
    ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment()] })));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    await screen.findByText("Adding Codex");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(await screen.findByRole("link", { name: /Open chat/ })).toBeInTheDocument();
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("hivra:attached-agents-changed", changed);
  }
});

it("shows progress only as each receipt arrives", async () => {
  const accepted = new Date(Date.now() - 30_000).toISOString();
  serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment({ phase: "dispatched", reviews: null,
    chatPath: null, receipts: { accepted, staged: null, started: null, chatReady: null } })] })));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
  const list = await screen.findByRole("list");
  const items = within(list).getAllByRole("listitem");
  expect(items.map((item) => [item.querySelector("span")!.textContent, item.getAttribute("data-done")])).toEqual([
    ["Request accepted", "true"], ["Codex installed", "false"], ["Codex started", "false"], ["Chat is ready", "false"]]);
  expect(items[0].querySelector("time")).toHaveAttribute("dateTime", accepted);
  // "Request accepted 0:30 ago" (5.8), give or take the render.
  expect(items[0].querySelector("time")!.textContent).toMatch(/^0:3\d ago$/);
  expect(items[3].querySelector("time")).toBeNull();
  expect(screen.queryByText(/couldn't confirm this step yet/)).not.toBeInTheDocument();
  // The step holds the computer, and Manage says so.
  expect(screen.getByText("While this step runs, this computer can't be started, stopped or restarted.")).toBeInTheDocument();
});

it("says what ends a step that never answers: a stopped computer is let go, and a delete ends it", async () => {
  const accepted = new Date(Date.now() - 60 * 60_000).toISOString();
  serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment({ phase: "dispatched", reviews: null,
    chatPath: null, createdAt: accepted, receipts: { accepted, staged: null, started: null, chatReady: null } })] })));
  render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
  expect(await screen.findByText(/couldn't confirm this step yet/)).toBeInTheDocument();
  expect(screen.getByText("While this step runs, this computer can't be started, stopped or restarted. "
    + "If this computer has stopped, Hivra lets it go once it sees that, so you can start it again. "
    + "Deleting the computer also ends this step.")).toBeInTheDocument();
  expect(screen.queryByText(/only way/)).not.toBeInTheDocument();
});

describe("a step the computer stopped under (T3)", () => {
  const accepted = new Date(Date.now() - 5 * 60_000).toISOString();
  const adding = (overrides: Record<string, unknown>) => ready(gate({ available: false, reason: "agent_present", reviews: null,
    attachments: [attachment({ phase: "dispatched", reviews: null, chatPath: null, createdAt: accepted,
      receipts: { accepted, staged: accepted, started: null, chatReady: null }, ...overrides })] }));

  it("says the install is paused, the computer is free to start, and never that it is held", async () => {
    serve(adding({ leaseReleased: true, interruptReason: "computer_not_running", interruptedAt: accepted }));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText("Adding Codex is paused: this computer stopped. Start it and Hivra removes what was installed, "
      + "and you can add Codex again. You can also delete the computer.")).toBeInTheDocument();
    expect(screen.queryByText(/can't be started, stopped or restarted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't confirm this step yet/)).not.toBeInTheDocument();
  });

  it("says a delete stopped the install", async () => {
    serve(adding({ leaseReleased: true, interruptReason: "pending_delete", interruptedAt: accepted }));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText("Adding Codex stopped because this computer is being deleted. "
      + "If the delete hasn't finished, delete the computer again.")).toBeInTheDocument();
  });

  it("says Hivra is removing it once the computer runs again, and that the computer is held meanwhile", async () => {
    serve(adding({ leaseReleased: false, interruptReason: "computer_not_running", interruptedAt: accepted }));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText("This computer stopped while Codex was being added. Hivra is removing what was installed."))
      .toBeInTheDocument();
    expect(screen.getByText("While this step runs, this computer can't be started, stopped or restarted.")).toBeInTheDocument();
  });

  it("says how it ended once the cleanup was observed", async () => {
    serve(ready(gate({ attachments: [attachment({ phase: "failed", endReason: "install_failed", interruptReason: "computer_not_running",
      reviews: null, chatPath: null })] })));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText("Adding Codex didn't finish because this computer stopped. Hivra removed what it had installed; "
      + "your files in ~/Hivra were not touched.")).toBeInTheDocument();
  });

  it("says a Remove is paused and still disables the other actions", async () => {
    serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment({ operation: {
      id: "22222222-2222-4222-8222-222222222222", kind: "detach", phase: "dispatched", grants: { workspace: true },
      createdAt: accepted, dispatchedAt: accepted, completedAt: null, failureCode: null,
      leaseReleased: true, interruptReason: "computer_not_running", interruptedAt: accepted } })] })));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText("Removing Codex is paused: this computer stopped. Start it and Hivra finishes removing Codex. "
      + "You can also delete the computer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.queryByText(/can't be started, stopped or restarted/)).not.toBeInTheDocument();
  });
});

describe("an attached agent", () => {
  it("says checked by Hivra only after root's read-back (T34), and applies from its next message", async () => {
    const deliveredAt = new Date().toISOString();
    serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment({ contract: { revision: 1,
      content: "## Your computer", grants: { workspace: true }, renderedAt: deliveredAt, deliveredAt, lastDelivered: null } })] })));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText(/^Delivered .* · checked by Hivra · applies from its next message$/)).toBeInTheDocument();
    expect(screen.getByText(/Hivra read the file back as the computer.s administrator/)).toBeInTheDocument();
  });

  it("never says delivered while the read-back is missing", async () => {
    serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment({ contract: { revision: 2,
      content: "## Your computer", grants: { workspace: false }, renderedAt: new Date().toISOString(), deliveredAt: null,
      lastDelivered: { revision: 1, deliveredAt: new Date().toISOString() } } })] })));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText("Update pending")).toBeInTheDocument();
    expect(screen.queryByText(/checked by Hivra/)).not.toBeInTheDocument();
    expect(screen.getByText(/Last delivered: rev 1/)).toBeInTheDocument();
  });

  it("changes access and removes Codex each through its own review and button", async () => {
    serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment()] })),
      { status: 202, body: { success: true, data: { operationId: "22222222-2222-4222-8222-222222222222" } } },
      ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment()] })));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByRole("link", { name: /Open chat/ })).toHaveAttribute("href", `/dashboard/agent/${COMPUTER}?tab=chat`);
    expect(screen.getByText(/Restoring is unavailable while Codex is on this computer/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change access" }));
    const access = screen.getByRole("group", { name: "Change what Codex can use on \u201cMY_UBUNTU_DESKTOP\u201d" });
    expect(within(access).getByText(/Files Codex added to ~\/Hivra stay, and can still run as you/)).toBeInTheDocument();
    fireEvent.click(within(access).getByRole("button", { name: /Stop sharing ~\/Hivra/ }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].init!.method).toBe("PATCH");
    expect(JSON.parse(String(posted()[0].init!.body))).toEqual({ grants: { workspace: false }, reviewSha256: "d".repeat(64), requestId: expect.any(String) });

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const remove = screen.getByRole("group", { name: "Remove Codex from \u201cMY_UBUNTU_DESKTOP\u201d" });
    expect(within(remove).getByText("Files Codex added to ~/Hivra stay after it's removed, and can still run as you if you run them."))
      .toBeInTheDocument();
    fireEvent.click(within(remove).getByRole("button", { name: /Remove Codex/ }));
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1].init!.method).toBe("DELETE");
    expect(posted()[1].url).toBe(`/api/hivra/computers/${COMPUTER}/agents/${ATTACHMENT}`);
    expect(JSON.parse(String(posted()[1].init!.body))).toEqual({ reviewSha256: "e".repeat(64), requestId: expect.any(String) });
  });

  it("disables both while a step runs, and says Remove keeps ~/Hivra", async () => {
    serve(ready(gate({ available: false, reason: "agent_present", reviews: null, attachments: [attachment({ operation: {
      id: "22222222-2222-4222-8222-222222222222", kind: "detach", phase: "dispatched", grants: { workspace: true },
      createdAt: new Date().toISOString(), dispatchedAt: new Date().toISOString(), completedAt: null, failureCode: null } })] })));
    render(<ComputerAgentsPanel computerId={COMPUTER} computerName="MY_UBUNTU_DESKTOP" />);
    expect(await screen.findByText(/Removing Codex. Your files in ~\/Hivra stay./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change access" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByText("While this step runs, this computer can't be started, stopped or restarted.")).toBeInTheDocument();
  });
});
