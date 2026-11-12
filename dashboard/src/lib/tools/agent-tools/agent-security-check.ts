// Agent Security Check logic (/tools/ai-agent-security-checklist). Pure data and functions: no React,
// no browser APIs.
//
// Twelve yes / no / not-sure questions, each worded so that "yes" is the safe answer. Every check has a
// weight from 1 to 3. A "no" opens the full weight and "not sure" opens half of it, because an unconfirmed
// control is not the same as a missing one. The result is a band (not a percentage) and the three open
// checks that matter most, in order.
//
// External facts (commands, settings, defaults) live in AGENT_SECURITY_FACTS and in the CHECKS table, read
// from the OpenClaw and Hermes security docs and the OWASP LLM list on 2026-11-12. Hivra facts live in
// HIVRA_SECURITY_FACTS and each one traces to a file in this repository. Nothing here is a finding about
// any agent: it is a checklist built from what the vendors themselves tell you to do.

export const AGENT_SECURITY_FACTS = {
  lastVerified: "2026-11-12",
  sources: {
    openclawSecurity: { label: "OpenClaw security overview", url: "https://docs.openclaw.ai/gateway/security" },
    openclawNetwork: { label: "OpenClaw network exposure", url: "https://docs.openclaw.ai/gateway/security/network-exposure" },
    openclawTools: { label: "OpenClaw tool permissions", url: "https://docs.openclaw.ai/gateway/security/tool-permissions" },
    openclawInjection: { label: "OpenClaw prompt injection", url: "https://docs.openclaw.ai/gateway/security/prompt-injection" },
    openclawSecrets: { label: "OpenClaw secrets and storage", url: "https://docs.openclaw.ai/gateway/security/secrets-and-storage" },
    openclawAccess: { label: "OpenClaw access control", url: "https://docs.openclaw.ai/gateway/security/access-control" },
    hermesSecurity: { label: "Hermes Agent security guide", url: "https://hermes-agent.nousresearch.com/docs/user-guide/security" },
    owasp: { label: "OWASP Top 10 for LLM Applications 2025", url: "https://genai.owasp.org/llm-top-10/" },
  },
} as const;

export type SourceKey = keyof typeof AGENT_SECURITY_FACTS.sources;

export const SOURCE_LIST = Object.values(AGENT_SECURITY_FACTS.sources);

export type CheckId =
  | "secrets"
  | "spend"
  | "ui-private"
  | "ui-auth"
  | "tools"
  | "approvals"
  | "approvers"
  | "senders"
  | "untrusted"
  | "isolation"
  | "updates"
  | "logs";

export type GroupId = "secrets" | "network" | "capabilities" | "approvals" | "strangers" | "isolation" | "updates" | "logs";

export const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: "secrets", label: "Secrets and API keys" },
  { id: "network", label: "Network exposure" },
  { id: "capabilities", label: "What the agent may do" },
  { id: "approvals", label: "Approvals" },
  { id: "strangers", label: "Messages from strangers and untrusted content" },
  { id: "isolation", label: "Isolation" },
  { id: "updates", label: "Updates" },
  { id: "logs", label: "Logs" },
];

export type Weight = 1 | 2 | 3;

/** One line to run or one setting to change. Only commands get a copy button. */
export interface FixLine {
  agent: "OpenClaw" | "Hermes" | "Either";
  kind: "command" | "setting";
  code: string;
  /** What it does, in a few words. */
  note: string;
}

export interface Check {
  id: CheckId;
  group: GroupId;
  /** Worded so that "yes" is the safe answer. */
  question: string;
  /** Why it matters, one sentence. */
  why: string;
  /** How to fix it, in words. */
  fix: string;
  /** Concrete lines, only where an upstream page states them. */
  lines: readonly FixLine[];
  /** True when the advice is common practice and neither vendor's page says it. The page labels it. */
  generalPractice?: boolean;
  /** What the upstream pages we read do not give, said plainly. */
  gap?: string;
  weight: Weight;
  sources: readonly SourceKey[];
}

export const CHECKS: readonly Check[] = [
  {
    id: "secrets",
    group: "secrets",
    question: "Are the agent's key files readable only by your user, and your keys kept out of chats, prompts and Git?",
    why: "A key typed into a chat or left in a world-readable file can be read by anything else that runs as another user on the machine.",
    fix: "Keep keys in the agent's own config or environment file, lock that folder to your user, and treat session transcripts as sensitive: OpenClaw says transcripts keep credentials exactly as they were typed.",
    lines: [
      { agent: "OpenClaw", kind: "command", code: "chmod 700 ~/.openclaw", note: "state folder, your user only" },
      { agent: "OpenClaw", kind: "command", code: "chmod 600 ~/.openclaw/openclaw.json", note: "config file, your user only" },
      { agent: "OpenClaw", kind: "command", code: "openclaw doctor", note: "warns about loose permissions and offers to tighten them" },
      { agent: "Hermes", kind: "command", code: "chmod 600 ~/.hermes/.env", note: "environment file, your user only" },
    ],
    weight: 2,
    sources: ["openclawSecrets", "hermesSecurity"],
  },
  {
    id: "spend",
    group: "secrets",
    question: "Does every model API key have a spending limit or alert set with the provider?",
    why: "An agent in a loop, or a flood of messages, can run up a model bill before you notice, and OWASP lists unbounded consumption as one of the ten main risks for LLM apps.",
    fix: "Set a monthly limit and an email alert in the model provider's billing settings, and use a key created only for this agent so you can revoke it without touching anything else.",
    lines: [],
    generalPractice: true,
    gap: "Neither the OpenClaw nor the Hermes security pages we read give a spending setting, so this lives with your model provider.",
    weight: 2,
    sources: ["owasp"],
  },
  {
    id: "ui-private",
    group: "network",
    question: "Is the agent's control or web UI kept off the public internet, on localhost or behind a VPN or tunnel?",
    why: "A control UI that anyone can reach is a control panel for your agent, its tools and its keys.",
    fix: "Bind to loopback and reach it through a private route. OpenClaw's gateway binds to loopback by default on a regular install, but its container images default to an exposed bind, so set it yourself there. Then test from outside.",
    lines: [
      { agent: "OpenClaw", kind: "setting", code: 'gateway.bind: "loopback"', note: "the default on a regular install, set it explicitly in a container" },
      { agent: "OpenClaw", kind: "command", code: "openclaw security audit", note: "reports where your config has drifted from the defaults" },
      { agent: "OpenClaw", kind: "command", code: "nmap -sT -p 1-65535 <public-ip> --open", note: "run from another machine to list open ports on your public address" },
    ],
    gap: "The Hermes security guide does not list a bind setting, so check how your Hermes install is served and test it from outside the same way.",
    weight: 3,
    sources: ["openclawNetwork", "openclawSecurity"],
  },
  {
    id: "ui-auth",
    group: "network",
    question: "Does the control UI ask for a token or password from anyone who can reach it?",
    why: "If the UI is ever reachable from another machine, authentication is the only thing standing between that machine and your agent.",
    fix: "Turn on token auth and generate a long random token. OpenClaw refuses to start on a non-loopback address without configured auth, and its audit flags blank tokens and warns on short ones.",
    lines: [
      { agent: "OpenClaw", kind: "setting", code: 'gateway.auth.mode: "token"', note: "recommended for most setups" },
      { agent: "OpenClaw", kind: "command", code: "openclaw doctor --generate-gateway-token", note: "makes a token for you" },
      { agent: "OpenClaw", kind: "command", code: "openclaw security audit", note: "flags blank values and warns below 24 characters" },
    ],
    gap: "The Hermes security guide covers who may message the agent but gives no setting for a web UI login, so check Hermes's own docs for your install.",
    weight: 3,
    sources: ["openclawNetwork"],
  },
  {
    id: "tools",
    group: "capabilities",
    question: "Have you limited the agent to the tools its job needs, with no shell, file writes or browser if it does not need them?",
    why: "OWASP calls giving an agent more capability than it needs excessive agency, and every extra tool is something a bad instruction can use.",
    fix: "Start from the least. OpenClaw lets you allow and deny tools per agent, and gives a read-only example. In Hermes, set the working directory so the agent does not start in a sensitive folder, and run the gateway as a non-root user.",
    lines: [
      { agent: "OpenClaw", kind: "setting", code: 'tools: { allow: ["read"], deny: ["write", "edit", "apply_patch", "exec", "process", "browser"] }', note: "the docs' read-only agent" },
      { agent: "Hermes", kind: "setting", code: "terminal.cwd", note: "set it to the project folder, not your home folder" },
    ],
    weight: 2,
    sources: ["openclawTools", "hermesSecurity", "owasp"],
  },
  {
    id: "approvals",
    group: "approvals",
    question: "Does a risky shell command wait for your approval instead of running on its own?",
    why: "An approval step is the last chance to stop a command you did not intend, whether the model got it wrong or was told to.",
    fix: "In Hermes keep approvals on smart (the default) or manual, and avoid off and the --yolo flag outside disposable machines. OpenClaw's docs describe full security with approvals off as its trusted-operator default, so tighten its exec approvals if anyone else can reach the agent.",
    lines: [
      { agent: "Hermes", kind: "setting", code: "approvals.mode: smart", note: "the default, or use manual for stricter prompts" },
      { agent: "Hermes", kind: "setting", code: 'approvals.deny: ["git push --force*"]', note: "blocks a pattern in every mode, quote each pattern" },
      { agent: "OpenClaw", kind: "setting", code: "exec.approvals.node.*", note: "per-node policy for system.run" },
    ],
    weight: 3,
    sources: ["hermesSecurity", "openclawTools"],
  },
  {
    id: "approvers",
    group: "approvals",
    question: "If other people can message the agent, is the list of people who may run commands or approve actions limited by name? If only you use it, answer yes.",
    why: "In a shared chat, a wide-open approver list lets any member approve what the agent wants to run.",
    fix: "Name the approvers. Hermes defaults approvers to everyone, so narrow it to user IDs. In OpenClaw, set command permission per provider, because an empty channel allowlist, or one containing a star, leaves commands effectively open.",
    lines: [
      { agent: "Hermes", kind: "setting", code: "approvals.approvers", note: "default is everyone, narrow it to specific user IDs" },
      { agent: "OpenClaw", kind: "setting", code: "commands.allowFrom", note: "an explicit list of who can run commands, per provider" },
    ],
    weight: 2,
    sources: ["hermesSecurity", "openclawAccess"],
  },
  {
    id: "senders",
    group: "strangers",
    question: "Can only people you have approved message the agent, through pairing or an allowlist and not open to everyone?",
    why: "Anyone who can message the agent can try to steer it, so the list of who may is your first line of defence.",
    fix: "Keep the default of pairing or use an allowlist, never open access. Both projects pair unknown senders by default and give a command to approve and revoke.",
    lines: [
      { agent: "OpenClaw", kind: "command", code: "openclaw pairing list <channel>", note: "see who is waiting" },
      { agent: "OpenClaw", kind: "command", code: "openclaw pairing approve <channel> <code>", note: "codes expire after 1 hour" },
      { agent: "Hermes", kind: "setting", code: "TELEGRAM_ALLOWED_USERS=<your-user-id>", note: "in ~/.hermes/.env, an explicit allowlist" },
      { agent: "Hermes", kind: "command", code: "hermes pairing revoke telegram <user-id>", note: "removes someone you approved" },
    ],
    weight: 3,
    sources: ["openclawAccess", "hermesSecurity"],
  },
  {
    id: "untrusted",
    group: "strangers",
    question: "When the agent reads web pages, email or documents from outside, are its shell, file-write and send-message tools restricted or approval-gated for that work?",
    why: "A web page or email can contain instructions written to the model, and OpenClaw's docs say the content itself is a threat surface even when only the owner can message the bot.",
    fix: "Limit what a hijacked agent could do, since no setting removes the risk. OpenClaw suggests restricting exec, browser and web tools to trusted agents, using a read-only agent to summarise untrusted content, and keeping its unsafe-content bypass flags off. Hermes can block sites and keeps private addresses blocked by default.",
    lines: [
      { agent: "OpenClaw", kind: "setting", code: 'tools: { deny: ["gateway", "cron", "sessions_spawn", "sessions_send"] }', note: "the docs' example for an agent that handles untrusted content" },
      { agent: "OpenClaw", kind: "setting", code: "hooks.mappings[].allowUnsafeExternalContent", note: "leave it off outside tightly scoped debugging" },
      { agent: "Hermes", kind: "setting", code: "security.website_blocklist", note: "a list of domains the agent must not browse" },
      { agent: "Hermes", kind: "setting", code: "security.allow_private_urls: false", note: "the default, keep it on a public-facing gateway" },
    ],
    weight: 3,
    sources: ["openclawInjection", "hermesSecurity", "owasp"],
  },
  {
    id: "isolation",
    group: "isolation",
    question: "Does the agent run on its own computer, VM or container, not on the laptop that holds your personal files and logins?",
    why: "Whatever the agent can run, it can run as the user it runs as, with that user's files, browser sessions and keys in reach.",
    fix: "Give it a machine or a container of its own. Hermes can run commands in a Docker container, and its docs say the container is then the boundary, so keep sensitive host paths out of it. OpenClaw's sandboxing is opt-in. For people who do not trust each other, its docs say to use a separate gateway and credentials, ideally separate OS users or hosts.",
    lines: [
      { agent: "Hermes", kind: "setting", code: "terminal.backend: docker", note: "the docs' recommendation for gateway deployments" },
      { agent: "OpenClaw", kind: "setting", code: 'sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" }', note: "the docs' example for a restricted agent" },
    ],
    weight: 3,
    sources: ["hermesSecurity", "openclawTools", "openclawSecurity"],
  },
  {
    id: "updates",
    group: "updates",
    question: "Do you know which version the agent runs, and do you apply its updates and read its security advisories?",
    why: "Both projects change quickly, and a fix you never install protects nobody.",
    fix: "In Hermes, update with one command and let doctor report supply-chain advisories. For OpenClaw, follow the Updating section of its docs, and re-run the audit after a change to see whether anything has drifted.",
    lines: [
      { agent: "Hermes", kind: "command", code: "hermes update", note: "updates Hermes" },
      { agent: "Hermes", kind: "command", code: "hermes doctor", note: "lists supply-chain advisories, acknowledge only after acting on one" },
      { agent: "OpenClaw", kind: "command", code: "openclaw security audit", note: "run it again after an update" },
    ],
    weight: 2,
    sources: ["hermesSecurity", "openclawSecurity"],
  },
  {
    id: "logs",
    group: "logs",
    question: "Do you know where the agent keeps its logs, and does someone look at them now and then?",
    why: "Logs are how you notice an unknown sender, a failed approval or a command you did not expect.",
    fix: "Read the logs on a schedule you will keep. Hermes keeps logs under ~/.hermes/logs/ and says to watch them for unauthorized access attempts. OpenClaw masks secrets in its status output, so share that and not raw logs or transcripts.",
    lines: [
      { agent: "OpenClaw", kind: "command", code: "openclaw status --all", note: "diagnostics with secrets redacted, safer to share than raw logs" },
      { agent: "Hermes", kind: "setting", code: "~/.hermes/logs/", note: "where to look" },
    ],
    weight: 1,
    sources: ["hermesSecurity", "openclawSecrets"],
  },
];

export const CHECK_IDS: readonly CheckId[] = CHECKS.map((c) => c.id);

export const ANSWERS = ["yes", "no", "unsure"] as const;
export type Answer = (typeof ANSWERS)[number];
export type MaybeAnswer = Answer | null;
export type SecurityAnswers = Record<CheckId, MaybeAnswer>;

export const ANSWER_LABELS: Record<Answer, string> = { yes: "Yes", no: "No", unsure: "Not sure" };

export const EMPTY_ANSWERS: SecurityAnswers = Object.fromEntries(CHECK_IDS.map((id) => [id, null])) as SecurityAnswers;

export function answersFrom(partial: Partial<SecurityAnswers>): SecurityAnswers {
  return { ...EMPTY_ANSWERS, ...partial };
}

export function getCheck(id: CheckId): Check {
  const check = CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`Unknown check ${id}`);
  return check;
}

export function answeredCount(answers: SecurityAnswers): number {
  return CHECK_IDS.filter((id) => answers[id] !== null).length;
}

export function isComplete(answers: SecurityAnswers): boolean {
  return answeredCount(answers) === CHECK_IDS.length;
}

/** Weight points a check leaves open: a "no" the full weight, "not sure" half of it (in half points, so integers). */
export function openPoints(check: Check, answer: MaybeAnswer): number {
  if (answer === "no") return check.weight * 2;
  if (answer === "unsure") return check.weight;
  return 0;
}

export const MAX_POINTS = CHECKS.reduce((sum, c) => sum + c.weight * 2, 0);

export type BandId = "covered" | "gaps" | "several" | "many";

export interface Band {
  id: BandId;
  label: string;
  /** What the band means, one or two plain sentences. */
  meaning: string;
}

export const BANDS: Record<BandId, Band> = {
  covered: {
    id: "covered",
    label: "Well covered",
    meaning: "You can say yes to nearly everything here. Keep it that way: re-run this after you add a channel, a tool or a new person.",
  },
  gaps: {
    id: "gaps",
    label: "A few gaps",
    meaning: "The basics are mostly in place. Close the open items below, starting with the first.",
  },
  several: {
    id: "several",
    label: "Several gaps",
    meaning: "Some of the controls the vendors ask for are missing or unconfirmed. Work through the top three before you give the agent more access.",
  },
  many: {
    id: "many",
    label: "Many open questions",
    meaning: "Most of the controls here are missing or unconfirmed. That is a long list, not a verdict: do the top three first, then run this again.",
  },
};

const BAND_ORDER: readonly BandId[] = ["covered", "gaps", "several", "many"];

function atLeast(a: BandId, b: BandId): BandId {
  return BAND_ORDER.indexOf(a) >= BAND_ORDER.indexOf(b) ? a : b;
}

export interface OpenCheck {
  check: Check;
  answer: "no" | "unsure";
  points: number;
}

export interface SecurityResult {
  band: Band;
  openPoints: number;
  maxPoints: number;
  /** Every open check, most important first. */
  open: OpenCheck[];
  /** The first three of `open`. */
  topThree: OpenCheck[];
  /** True when the band was raised above what the points alone give. */
  raisedBy: string | null;
}

/** Open checks, ordered by points, then weight, then the order of the list. */
export function openChecks(answers: SecurityAnswers): OpenCheck[] {
  const rows: OpenCheck[] = [];
  for (const check of CHECKS) {
    const answer = answers[check.id];
    if (answer === "no" || answer === "unsure") rows.push({ check, answer, points: openPoints(check, answer) });
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.points - a.row.points || b.row.check.weight - a.row.check.weight || a.index - b.index)
    .map(({ row }) => row);
}

/** The result once all twelve are answered, otherwise null. */
export function assess(answers: SecurityAnswers): SecurityResult | null {
  if (!isComplete(answers)) return null;
  const open = openChecks(answers);
  const points = open.reduce((sum, row) => sum + row.points, 0);
  const ratio = points / MAX_POINTS;
  let band: BandId = ratio <= 0.1 ? "covered" : ratio <= 0.3 ? "gaps" : ratio <= 0.55 ? "several" : "many";
  let raisedBy: string | null = null;

  // A "no" on a weight-3 check is never "well covered", whatever the total.
  if (open.some((row) => row.answer === "no" && row.check.weight === 3)) {
    const raised = atLeast(band, "gaps");
    if (raised !== band) raisedBy = "a no on a check that matters most";
    band = raised;
  }
  // A reachable control UI with no login, or with a login nobody has confirmed, is the one pairing that must not be left.
  // Not sure on the login counts: an exposed UI with unconfirmed auth is treated as a real gap until it is checked.
  if (answers["ui-private"] === "no" && (answers["ui-auth"] === "no" || answers["ui-auth"] === "unsure")) {
    const raised = atLeast(band, "several");
    if (raised !== band) {
      raisedBy = answers["ui-auth"] === "no" ? "a control UI that is reachable and has no login" : "a control UI that is reachable and may have no login";
    }
    band = raised;
  }

  return {
    band: BANDS[band],
    openPoints: points,
    maxPoints: MAX_POINTS,
    open,
    topThree: open.slice(0, 3),
    raisedBy,
  };
}

/** The plain-text summary for the copy button. No link and nothing typed by the reader. */
export function summaryText(result: SecurityResult): string {
  const lines = [`Agent security check: ${result.band.label}`];
  if (result.topThree.length === 0) {
    lines.push("No open items.");
  } else {
    lines.push("Top fixes, in order:");
    result.topThree.forEach((row, i) => {
      lines.push(`${i + 1}. ${row.check.question}${row.answer === "unsure" ? " (not confirmed)" : ""}`);
    });
  }
  const rest = result.open.length - result.topThree.length;
  if (rest > 0) lines.push(`${rest} more open ${rest === 1 ? "item" : "items"}.`);
  return lines.join("\n");
}

// ---- Share links ------------------------------------------------------------------------------

/** The one query key this tool owns. */
export const AGENT_SECURITY_PARAM_KEYS: readonly string[] = ["a"];

const CODE: Record<Answer, string> = { yes: "y", no: "n", unsure: "u" };
const FROM_CODE: Record<string, Answer> = { y: "yes", n: "no", u: "unsure" };

/** Read the answers from a query string: one character per check (y, n, u or a dash). Anything else is unanswered. */
export function parseSecurityParams(search: string): SecurityAnswers {
  const raw = new URLSearchParams(search).get("a") ?? "";
  const answers: SecurityAnswers = { ...EMPTY_ANSWERS };
  if (raw.length > CHECK_IDS.length || !/^[ynu-]*$/.test(raw)) return answers;
  CHECK_IDS.forEach((id, i) => {
    const answer = FROM_CODE[raw.charAt(i)];
    if (answer) answers[id] = answer;
  });
  return answers;
}

/** The query string (no leading "?"). Empty when nothing is answered, so the default page has no query. */
export function serializeSecurityParams(answers: SecurityAnswers): string {
  if (answeredCount(answers) === 0) return "";
  const code = CHECK_IDS.map((id) => {
    const a = answers[id];
    return a ? CODE[a] : "-";
  }).join("");
  return new URLSearchParams({ a: code }).toString();
}

// ---- What a Hivra computer changes ----------------------------------------------------------------

/**
 * Statements about Hivra, each one read from a file in this repository. If a statement cannot be found in
 * the file named beside it, it does not belong here. Plain words about what Hivra does NOT do sit in
 * HIVRA_DOES_NOT.
 */
export const HIVRA_SECURITY_FACTS = {
  lastVerified: "2026-11-12",
  does: [
    {
      text: "Each agent runs on its own private virtual machine, so it is separate from your laptop and its files.",
      from: "dashboard/src/lib/hivra/agent-catalog.ts (hostingDisclaimer)",
    },
    {
      text: "The OpenClaw Control UI is bound to localhost on that machine and reached through Hivra's authenticated gateway. Agent Zero's dashboard is set up the same way, and Hermes's own web UI opens behind the Hivra sign-in.",
      from: "dashboard/src/lib/hivra/agent-catalog.ts and docs/STATUS.md",
    },
    {
      // STATUS.md: Hermes on a Hivra computer is live on Canary only and reaches hivra.cloud with the next owner-approved
      // production promotion. The wording is conditional ("where it is offered") so it stays true on production before that
      // promotion; the tools flag should still only go on for production once it has shipped.
      text: "Where Hermes is offered on Hivra, it is the official Hermes Agent, unmodified, installed with Hermes's own installer and updated with hermes update or the Update Hermes button.",
      from: "docs/STATUS.md",
    },
  ],
  doesNot: [
    "It does not choose your agent's tools, approvals or who may message it. You set those inside the agent's own settings, the same ones the checks above cover.",
    "It does not set a spending limit with your model provider.",
    "It does not stop prompt injection. An agent on its own computer can still be told to do something by a web page or an email it reads, and then it can use whatever that computer holds, including keys.",
    "Credentials may be stored on the agent computer, and Hivra administrators retain infrastructure access on Hivra-managed hosts.",
    "Hivra's own security model says it cannot guarantee that capable agents are harmless or that compromise is impossible. This page makes no claim of an audit, a certification or a penetration test.",
  ],
  stillYours:
    "Isolation answers one question on this list. Secrets, approvals, who can message the agent, what it may read and your model bill stay your responsibility on any machine.",
} as const;

/** A short name for each check, for lists and the worked examples. */
export const CHECK_TITLES: Record<CheckId, string> = {
  secrets: "Lock down key files and keep keys out of chats",
  spend: "Set a spending limit on every API key",
  "ui-private": "Keep the control UI off the public internet",
  "ui-auth": "Require a token or password on the control UI",
  tools: "Limit the agent to the tools it needs",
  approvals: "Make risky commands wait for approval",
  approvers: "Name who may approve or run commands",
  senders: "Let only approved people message the agent",
  untrusted: "Restrict tools while reading untrusted content",
  isolation: "Run the agent away from your main laptop",
  updates: "Apply updates and read advisories",
  logs: "Know where the logs are and read them",
};

/** What the tool prints for a set of answers: the band, then the top three fixes. Used by the worked examples. */
export function resultText(result: SecurityResult): string {
  const lines = [result.band.label];
  result.topThree.forEach((row, i) => lines.push(`${i + 1}. ${CHECK_TITLES[row.check.id]}${row.answer === "unsure" ? " (confirm)" : ""}`));
  return lines.join("\n");
}
