// T19: the contract, the agent page tabs and the launch Review come from one
// decision (agentSurfacesFor), so what the agent is told, what the owner can
// open and what Review promises cannot drift apart.
import { agentLaunchReviewRows, agentSurfacesFor, type AgentSurfaceId } from "../agent-surfaces";
import { renderComputerContract } from "../computer-contract";
import { computerContractPlanFor } from "../computer-contract-input";

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
  const review = agentLaunchReviewRows(row, { browser: fixture.browser });

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
    if (watchable) expect(review.canSee).toMatch(REVIEW_LABEL[surface]!);
    else expect(review.canSee).not.toMatch(REVIEW_LABEL[surface]!);
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
