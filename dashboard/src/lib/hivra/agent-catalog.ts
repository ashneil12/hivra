// Hivra agent catalog + plan tiers.
// Pure data/logic (no deps) so it can be imported from server or client.
// This is the source of truth for the "deploy an agent onto your compute"
// picker: which agents exist, what each needs, and what each plan unlocks.
// Slot counts come from the authoritative source (subscription/agent-slots, pure data).

import { AGENT_SLOTS } from "@/lib/subscription/agent-slots";

export type AgentId = "hermes" | "claude-code" | "codex" | "aeon" | "openclaw" | "agent-zero" | "deepseek-harness" | "linux-desktop" | "linux-terminal";
export type PlanTier = "free" | "pro" | "power";

export interface AgentDef {
  id: AgentId;
  name: string;
  vendor: string;
  tagline: string;
  /** Minimum plan required to launch this agent. */
  minPlan: PlanTier;
  /** Relative resource weight — Claude Code is hungry, so it counts double. */
  weight: number;
  /** Whether this agent ships browser automation. */
  browser: boolean;
  badge?: string;
  /** Accent color (brand) for the card. */
  accent: string;
  available: boolean;
  /** Keeps operating-system profiles out of the agent picker while reusing the
   * accepted computer lifecycle and access contracts. */
  resourceKind?: "agent" | "computer";
  /** Guest installer profile. The persisted catalog identity remains `id`. */
  provisionKind?: "claude" | "linux-desktop";
  /**
   * Which CLI the box runs — selects the chat stream parser + login flow.
   * Omitted for non-CLI agents (e.g. Aeon, which hosts a web dashboard and has
   * no chat surface).
   */
  cliKind?: "claude" | "codex";
  /**
   * What the per-box page renders. "chat" = the HivraChat CLI-agent surface
   * (default). "dashboard" = embed a web dashboard the box hosts (iframe), no
   * chat. Aeon is the first "dashboard" agent.
   */
  surface?: "chat" | "dashboard" | "computer";
  /**
   * Pool-exempt agents consume an agent SLOT but not the user's shared CPU/RAM
   * budget — they host on near-zero compute (e.g. Aeon, whose real work runs on
   * the user's GitHub Actions; the box only serves a Next.js dashboard).
   */
  poolExempt?: boolean;
  /** Which connect/login flow the box uses after provisioning. */
  connect?: "anthropic" | "chatgpt" | "github";
  /** Per-agent launch/resize floor override (CPU cores / GB). Defaults to BASE_FLOOR. */
  floor?: { cpu: number; ram: number };
  /** For surface:"dashboard" — the loopback port the box hosts the dashboard on. */
  dashboardPort?: number;
  /**
   * The agent can bill its LLM usage to the user's managed Venice wallet (a
   * Hivra-minted proxy key installed during the connect step). Gates BOTH the
   * deploy-card opt-in and whether the launch route persists the choice — so an
   * agent type without working box-side wiring never shows a dead toggle.
   * Currently Aeon only; flip for claude-code/codex once their box wiring lands.
   */
  managedVenice?: boolean;
  /**
   * Alternative LLM-provider capability (orthogonal to `managedVenice`, which is
   * Aeon's managed-wallet billing opt-in). `wire` is the protocol the CLI speaks
   * (codex = OpenAI-compat chat; claude = Anthropic Messages — needs the
   * translation shim before any provider can be listed). `providers` is which
   * alternatives the user may pick (Venice via BYOK or the managed gateway);
   * empty = native vendor auth only, no picker. Drives the box-side inference
   * routing (~/.hivra/llm-provider.json + per-spawn model_providers). Hermes is
   * configured through its own lane (/api/instances) and omits this.
   */
  llm?: { wire: "openai" | "anthropic"; providers: "venice"[] };
}

/** Hard ceiling for the resize selectors (matches the box size buttons). */
export const MAX_CPU = 8;
export const MAX_RAM = 24;

// Resize floor = a free-tier base every agent can launch with, plus a surcharge while browser
// automation is on (the headful Chrome + Xvfb + VNC stack costs ~1 CPU / 2 GB).
// So: browser off -> 0.5 CPU / 1 GB; browser on -> 1.5 CPU / 3 GB.
export const BASE_FLOOR = { cpu: 0.5, ram: 1 };
export const BROWSER_ADD = { cpu: 1, ram: 2 };

const ALL_AGENTS: AgentDef[] = [
  {
    id: "hermes",
    name: "Hermes",
    vendor: "Nous Research",
    tagline: "Lightweight, general-purpose agent. The free-tier default.",
    minPlan: "free",
    weight: 1,
    browser: false,
    badge: "Free tier",
    accent: "var(--gold-leaf)",
    available: true,
    cliKind: "claude",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    tagline: "Coding agent with a live self-hosted browser. Use your own login.",
    minPlan: "free",
    weight: 2,
    browser: true,
    badge: "Browser",
    accent: "#d97757",
    available: true,
    cliKind: "claude",
    // Speaks Anthropic Messages only — providers stays empty until the
    // Anthropic↔OpenAI gateway shim ships (managed-Venice translation boundary).
    llm: { wire: "anthropic", providers: [] },
  },
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    tagline: "OpenAI's coding agent. Use your own ChatGPT login.",
    minPlan: "free",
    weight: 2,
    // Same box-level browser stack as Claude Code: CDP Chrome + the cdp
    // (browser-harness-js) skill, surfaced to codex via ~/.agents/skills.
    browser: true,
    badge: "BYO login",
    accent: "#10a37f",
    available: true,
    cliKind: "codex",
    connect: "chatgpt",
    // codex supports custom model_providers (OpenAI-compat base_url + env_key),
    // injected per-spawn by the box chat server — no CLI or config.toml changes.
    llm: { wire: "openai", providers: ["venice"] },
  },
  {
    id: "aeon",
    name: "Aeon",
    vendor: "Aeon",
    tagline: "Autonomous agent framework. Runs on your GitHub — set it once, forget it.",
    minPlan: "free",
    // Near-zero footprint: the box only serves Aeon's Next.js dashboard; the real
    // work runs on the user's own GitHub Actions. Slot-only, never charges the pool.
    weight: 1,
    browser: false,
    badge: "GitHub-hosted",
    accent: "#7c5cff",
    available: true,
    surface: "dashboard",
    poolExempt: true,
    connect: "github",
    // Hosts a Next.js 16 dashboard; the build + runtime need ~1 GB. Pool-exempt,
    // so this never charges the user's compute budget (only an agent slot).
    floor: { cpu: 0.5, ram: 1 },
    dashboardPort: 5555,
    managedVenice: true,
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    vendor: "OpenClaw",
    tagline: "Always-on agent you reach from your messaging apps. Set it once, it runs.",
    // Runs a persistent agent daemon + heartbeat ON the box (not pool-exempt like
    // Aeon) — so it needs a real footprint and a paid tier.
    minPlan: "pro",
    weight: 2,
    // Opt-in browser (like the coding agents): OpenClaw attaches to the box's
    // existing CDP Chrome (browser.cdpUrl + browser.profiles.chrome.cdpUrl →
    // 127.0.0.1:9222), so the user logs into their accounts in the live VNC view
    // and the agent acts in that session. Off → 1/2 (pro); on → +1/2 → 2/4.
    browser: true,
    badge: "Always-on",
    accent: "#ff7a45",
    available: true,
    // `openclaw gateway` serves its Control UI (chat/config/exec-approvals) on a
    // single loopback port; we token-proxy it under /openclaw. No chat-CLI surface.
    surface: "dashboard",
    // NOT pool-exempt: the agent loop runs on-box, so it charges the compute pool.
    floor: { cpu: 1, ram: 2 },
    dashboardPort: 18789,
    // No box-managed login flow: the gateway runs gateway.auth.mode="none" bound to
    // loopback (validated live on openclaw 2026.6.10 — its own `security audit`
    // permits none for a trusted-local, single-operator box as long as bind stays
    // loopback, which it does). The box token-proxy on /openclaw is the only access
    // boundary; the user configures messaging channels inside the Control UI.
    // Inference bills the user's managed-Venice wallet via a custom OpenAI-compatible
    // provider (models.providers.venice, api "openai-completions") pointed at our
    // managed-Venice gateway — the key+baseUrl are minted at LAUNCH and written into
    // ~/.openclaw/openclaw.json by the provisioner over the generic HIVRA_MODEL_* env
    // (no connect step like Aeon).
    managedVenice: true,
    llm: { wire: "openai", providers: ["venice"] },
  },
  {
    id: "agent-zero",
    name: "Agent Zero",
    vendor: "Agent Zero",
    tagline: "A general autonomous agent with its own dashboard, browser and computer. Give it a goal — it plans, runs, and reports.",
    // Runs the full Agent Zero stack (agent loop + tools + its own browser) in a
    // Docker container ON the box — NOT pool-exempt like Aeon — so it needs a real
    // footprint and a paid tier.
    minPlan: "pro",
    weight: 2,
    // Agent Zero ships its OWN browser + computer inside the container; we do NOT
    // wire the box's CDP Chrome stack (browser:false in the Hivra sense).
    browser: false,
    badge: "Autonomous",
    accent: "#e0a038",
    available: true,
    // Agent Zero serves its web UI (chat + browser + computer canvas) on container
    // port 80, published to the box loopback at :50080 (8080 is the hivra-chat
    // gate); we token-proxy it under /agent-zero. No chat-CLI surface.
    surface: "dashboard",
    // NOT pool-exempt: the agent loop + tools run on-box, so it charges the pool.
    // Floor footprint set to 1 vCPU / 2 GB RAM.
    floor: { cpu: 1, ram: 2 },
    dashboardPort: 50080,
    // No box-managed vendor login: Agent Zero gates its OWN web UI with a basic-auth
    // login we seed at provision (AUTH_LOGIN/AUTH_PASSWORD in /a0/.env), reachable
    // only through our token-proxy on /agent-zero. Inference defaults to the user's
    // managed-Venice wallet via an OpenAI-compatible provider written into /a0/.env
    // at LAUNCH over the generic HIVRA_MODEL_* env (same mint path as OpenClaw — no
    // connect step); the user can still change providers inside Agent Zero's Settings.
    managedVenice: true,
    llm: { wire: "openai", providers: ["venice"] },
  },
  {
    id: "linux-desktop",
    name: "Ubuntu Desktop",
    vendor: "Hivra",
    tagline: "A contained Ubuntu desktop workspace with terminal and files on an isolated cloud VM.",
    minPlan: "pro",
    weight: 2,
    browser: false,
    badge: "Computer",
    accent: "#ff4244",
    available: true,
    resourceKind: "computer",
    // The first alpha reuses the mature Ubuntu guest base, but it is installed
    // and reported as a computer profile rather than impersonating Claude.
    provisionKind: "linux-desktop",
    surface: "computer",
    floor: { cpu: 2, ram: 4 },
  },
  {
    id: "linux-terminal",
    name: "Linux Sandbox",
    vendor: "Hivra",
    tagline: "A lightweight Python and terminal workspace isolated by gVisor on a Linux host you connected.",
    minPlan: "free",
    weight: 1,
    browser: false,
    badge: "Computer",
    accent: "#ff4244",
    available: true,
    resourceKind: "computer",
    surface: "computer",
    floor: { cpu: 0.5, ram: 1 },
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    vendor: "DeepSeek",
    tagline: "Developer-preview coding harness with its complete native interface.",
    minPlan: "pro",
    weight: 2,
    browser: false,
    badge: "Experimental",
    accent: "#4f7cff",
    // The runtime is fully described so retained/private acceptance rows render
    // their native surface correctly. Keep it out of AGENTS until the exact
    // disposable provider UI/model/restart/revocation/teardown gate passes.
    available: false,
    surface: "dashboard",
    floor: { cpu: 2, ram: 3 },
  },
];

// Launch catalog for the welcome/deploy picker. All available agents are
// launchable from the first-run flow — claude-code and codex are both BYO-login
// coding boxes; codex simply ships no browser stack.
export const AGENTS: AgentDef[] = ALL_AGENTS.filter(
  (agent) => agent.available && agent.resourceKind !== "computer",
);

// Resize floor for an agent type at a given browser-automation state. Starts
// from the agent's own floor override (Aeon hosts a tiny dashboard → 0.5/0.5)
// or BASE_FLOOR, plus the browser surcharge for agents that ship one.
export function resizeFloor(id: AgentId | string, browserOn: boolean): { cpu: number; ram: number } {
  const def = ALL_AGENTS.find((a) => a.id === id);
  const base = def?.floor ?? BASE_FLOOR;
  const withBrowser = browserOn && Boolean(def?.browser);
  return {
    cpu: base.cpu + (withBrowser ? BROWSER_ADD.cpu : 0),
    ram: base.ram + (withBrowser ? BROWSER_ADD.ram : 0),
  };
}

// Whether an agent type consumes a slot but NOT the user's shared CPU/RAM pool.
export function isPoolExempt(id: AgentId | string): boolean {
  return Boolean(ALL_AGENTS.find((a) => a.id === id)?.poolExempt);
}

interface PlanDef {
  id: PlanTier;
  name: string;
  /** Max concurrent agents (by weight budget). */
  maxAgents: number;
  cpu: number;
  ramGb: number;
  blurb: string;
}

export const PLANS: Record<PlanTier, PlanDef> = {
  free: { id: "free", name: "Free", maxAgents: AGENT_SLOTS.free, cpu: 0.5, ramGb: 1, blurb: "One lean agent, within limits. No browser automation." },
  pro: { id: "pro", name: "Pro", maxAgents: AGENT_SLOTS.operator, cpu: 2, ramGb: 4, blurb: "Up to 3 agents. Full capability." },
  power: { id: "power", name: "Power", maxAgents: AGENT_SLOTS.fleet, cpu: 4, ramGb: 8, blurb: "Up to 5 agents. No capability caps." },
};

const TIER_RANK: Record<PlanTier, number> = { free: 0, pro: 1, power: 2 };

export interface LaunchCheck {
  ok: boolean;
  reason?: string;
}

export function canLaunchAgent(agent: AgentDef, plan: PlanTier): LaunchCheck {
  if (!agent.available) {
    return { ok: false, reason: "Coming soon" };
  }
  if (TIER_RANK[plan] < TIER_RANK[agent.minPlan]) {
    return { ok: false, reason: `Needs ${PLANS[agent.minPlan].name}` };
  }
  return { ok: true };
}

export function getAgent(id: AgentId | string): AgentDef | undefined {
  return ALL_AGENTS.find((a) => a.id === id);
}

// Factual runtime and credential guidance shared by launch and Manage views.
// Native authentication is not a promise that a managed host operator cannot
// access guest storage. Keep the infrastructure boundary explicit.
export function hostingDisclaimer(def?: AgentDef, deploymentMode: "hivra-managed" | "self-managed" = "hivra-managed"): string {
  if (!def) return "";
  const credentialNotice = deploymentMode === "self-managed"
    ? "Credentials may be stored on the agent computer. Whoever controls the connected host can access its infrastructure; Hivra does not become the host operator."
    : "Credentials may be stored on the agent computer. Hivra administrators retain infrastructure access on Hivra-managed hosts.";
  if (def.resourceKind === "computer") {
    return `This creates an isolated Linux VM with Hivra's contained authenticated desktop plus shared terminal, files, lifecycle, and recovery surfaces. ${credentialNotice}`;
  }
  if (def.id === "hermes") {
    return `This runs Hermes (${def.vendor}) on the agent's private virtual machine, with Hivra's chat, terminal, files and skills interfaces. ${credentialNotice} Hivra is an independent hosting service and isn't affiliated with or endorsed by ${def.vendor}.`;
  }
  if (def.id === "aeon") {
    return `This hosts the Aeon dashboard on the agent's private virtual machine. Aeon's automated tasks run on your own GitHub Actions using the GitHub credentials you connect. ${credentialNotice} Hivra is an independent hosting service and isn't affiliated with or endorsed by the Aeon project.`;
  }
  if (def.id === "openclaw") {
    return `This hosts OpenClaw on the agent's private virtual machine. Its Control UI is bound to localhost and reached through Hivra's authenticated gateway. Configure your model providers and messaging channels inside that UI. ${credentialNotice} Hivra is an independent hosting service and isn't affiliated with or endorsed by the OpenClaw project.`;
  }
  if (def.id === "agent-zero") {
    return `This hosts Agent Zero in a container on the agent's private virtual machine. Its dashboard is bound to localhost and reached through Hivra's authenticated gateway. Configure your own model provider in Agent Zero's Settings, or use a supported managed model option. ${credentialNotice} Hivra is an independent hosting service and isn't affiliated with or endorsed by the Agent Zero project.`;
  }
  const views = def.browser ? "chat, terminal, files, skills, and browser" : "chat, terminal, files, and skills";
  const authentication = def.id === "codex"
    ? "Sign in with ChatGPT or provide your own OpenAI API key inside Codex."
    : `Sign in with your own ${def.vendor} account inside the CLI.`;
  return `This runs the official ${def.name} CLI from ${def.vendor} on the agent's private virtual machine. ${authentication} ${credentialNotice} The ${views} tabs connect to that runtime. Hivra is independent and isn't affiliated with, sponsored by, or endorsed by ${def.vendor}.`;
}
