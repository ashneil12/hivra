// T19: the contract, the agent page tabs and the launch Review come from one
// decision (agentSurfacesFor), so what the agent is told, what the owner can
// open and what Review promises cannot drift apart.
import { agentLaunchWatchRow, agentSurfacesFor, type AgentSurfaceId } from "../agent-surfaces";
import { renderComputerContract } from "../computer-contract";
import { computerContractPlanFor } from "../computer-contract-input";
import { attachAccessRows, attachedContractInput, attachReview } from "../attach-plan";

const FIXTURES = {
  "Hivra Cloud Codex (browser stack)": { type: "codex", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", browser: true },
  "Free Codex without a browser": { type: "codex", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", browser: false },
  "Hivra Cloud Claude Code": { type: "claude-code", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", browser: true },
  "My server Claude Code": { type: "claude-code", computer_substrate: "proxmox-kvm", deployment_mode: "self-managed", browser: true },
  "Hetzner Codex (catalog tools unavailable)": { type: "codex", computer_substrate: "provider-vm", deployment_mode: "self-managed", browser: false },
  "DigitalOcean Codex": { type: "codex", computer_substrate: "do-managed-session", deployment_mode: "self-managed", browser: false },
} as const;

// What each surface is called in the contract, per placement.
const OWN_COMPUTER_PHRASE: Partial<Record<AgentSurfaceId, string>> = {
  chat: "the Chat tab", terminal: "session tab", box: "The Terminal tab", files: "The Files tab", git: "The Git tab", browser: "The Browser tab",
};
const DIGITALOCEAN_PHRASE: Partial<Record<AgentSurfaceId, string>> = { chat: "They chat with you in Hivra", files: "Files view" };
const REVIEW_LABEL: Partial<Record<AgentSurfaceId, RegExp>> = {
  chat: /\bChat\b/, terminal: /\b(Codex|Claude Code) session\b/, box: /\bTerminal\b/, files: /\bFiles\b/, git: /\bGit\b/, browser: /\bBrowser \(view-only\)/,
};

describe.each(Object.entries(FIXTURES))("%s", (_name, fixture) => {
  const row = { ...fixture, name: "Parity agent", status: "running", cpu: 2, ram: 4, chat_url: "https://box.example.com" };
  const surfaces = agentSurfacesFor(row);
  const plan = computerContractPlanFor(row);
  if (plan.status === "not_applicable") throw new Error("every fixture is an agent with a contract");
  const contract = renderComputerContract(plan.input, 1);
  const phrases = fixture.computer_substrate === "do-managed-session" ? DIGITALOCEAN_PHRASE : OWN_COMPUTER_PHRASE;
  const watch = agentLaunchWatchRow(row, { browser: fixture.browser });

  it("builds the contract from exactly the tabs the page shows", () => {
    expect(plan.input.surfaces).toEqual(surfaces);
  });

  it.each(Object.keys(OWN_COMPUTER_PHRASE) as AgentSurfaceId[])("mentions %s in the contract only when the page shows it", (surface) => {
    const phrase = phrases[surface];
    if (surfaces.includes(surface) && phrase) expect(contract).toContain(phrase);
    else expect(contract).not.toContain(OWN_COMPUTER_PHRASE[surface]!);
  });

  it.each(Object.keys(REVIEW_LABEL) as AgentSurfaceId[])("lists %s in Review only when the page shows it", (surface) => {
    // A browser switched off at launch has nothing to watch yet, although its
    // tab stays on the page to explain how to turn it on.
    const watchable = surfaces.includes(surface) && (surface !== "browser" || fixture.browser);
    if (watchable) expect(watch).toMatch(REVIEW_LABEL[surface]!);
    else expect(watch).not.toMatch(REVIEW_LABEL[surface]!);
  });

  it("only offers a browser where the computer can run one", () => {
    const browserCapable = fixture.computer_substrate !== "do-managed-session";
    expect(contract.includes("Chrome runs on this computer only while browser automation is on")).toBe(browserCapable);
    expect(surfaces.includes("browser")).toBe(browserCapable);
  });
});

it("gives dashboard runtimes and computers no contract, but still pins their tabs", () => {
  expect(computerContractPlanFor({ type: "openclaw" })).toEqual({ status: "not_applicable", reason: "own_instructions" });
  expect(computerContractPlanFor({ type: "linux-desktop", computer_profile: "ubuntu-desktop" })).toEqual({ status: "not_applicable", reason: "computer" });
  expect(agentSurfacesFor({ type: "openclaw" })).toEqual(["aeon", "browser", "box", "files", "manage"]);
});

describe("attached Codex", () => {
  // An agent added to a computer is reached from that computer's page: the
  // Chat tab appears there once it is ready, and the gate's rows are what it
  // is told it can and cannot use.
  const computer = { type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
    name: "MY_UBUNTU_DESKTOP", status: "running", cpu: 2, ram: 4, chat_url: "https://box.example.com" };
  const installationId = "00000000-0000-4100-8000-000000000004";
  const render = (workspace: boolean) => renderComputerContract(attachedContractInput({ agentName: "Codex",
    computer: { ...computer, ramGb: computer.ram }, installationId, grants: { workspace } }), 1);

  it("puts a Chat tab on the computer's page only once the agent is ready", () => {
    expect(agentSurfacesFor({ ...computer, attached_agent_ready: true })).toContain("chat");
    expect(agentSurfacesFor(computer)).not.toContain("chat");
  });

  it.each([true, false])("with ~/Hivra %s, tells the agent the surfaces the owner has and the Review promises", (workspace) => {
    const contract = render(workspace);
    const review = attachReview({ computerName: computer.name, grants: { workspace }, deploymentMode: computer.deployment_mode,
      servicePolicySha256: "f".repeat(64) }).lines.join(" ");
    expect(contract).toContain("the Chat tab");
    expect(review).toContain("the Chat tab");
    for (const surface of ["session tab", "The Terminal tab", "The Git tab", "The Browser tab"]) expect(contract).not.toContain(surface);
    expect(contract.includes("the Files tab")).toBe(workspace);
    expect(review.includes("read and write ~/Hivra")).toBe(workspace);
    const rows = attachAccessRows({ workspace }, { name: computer.name, cpu: computer.cpu, ramGb: computer.ram });
    const off = rows.filter((row) => ["always-off", "not-available", "never"].includes(row.state)).map((row) => row.id);
    expect(off).toEqual(["localNetwork", "chromeProfile", "desktopControl", "sudo", "personalHome"]);
    expect(contract).toContain("**What you cannot use.** Your user's desktop, their browser or Chrome profile, administrator access, this computer's other services, and the local network.");
    expect(contract).toContain("You cannot see your user's personal home folder.");
  });
});
