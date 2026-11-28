import type { ComparePage } from "../types";
import {
  AI_USAGE,
  CLOSING,
  HIVRA_AGENTS_CELL as SHARED_AGENTS_CELL,
  ENTRY_PRICE_PROSE,
  PRICES_AS_OF_STAMP,
  REFUND_LINKED,
  STAYS_ON,
  cautionSection,
  paragraphs,
  relatedLinks,
} from "../shared-copy";
import { formatCheckedMonth } from "../competitor-facts";
import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT, formatPlanSize } from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { PRODUCT_FACTS_CHECKED } from "./checked";

/*
 * Hivra and Cursor cloud agents.
 *
 * The honest framing: Cursor cloud agents are tied to Cursor's product and models and run Cursor's own agent in a
 * Cursor-managed VM; Hivra gives a persistent computer for several supported agents. Every Cursor fact below comes
 * from Cursor's own pages, read for the figures dated by PRODUCT_FACTS_CHECKED. What those pages do not state (VM
 * size, run length, idle timers, region choice, a cloud agent refund policy, whether other vendors' agent CLIs run
 * inside the VM) is left out or said to be unstated.
 */

/*
 * Hermes is live on Canary only and reaches hivra.cloud with the next owner-approved production promotion
 * (docs/STATUS.md, Hermes row), so this public page leaves it out until STATUS says it is on production.
 * Re-check STATUS.md before restoring it. The Hivra negatives below (no editor integration, no Slack or pull
 * request trigger) are not confirmed by STATUS.md or lib/launch/contracts.ts, so the copy only says what
 * Hivra's own pages do not describe.
 */
const HIVRA_AGENTS_CELL = SHARED_AGENTS_CELL.replace(/^Hermes, /, "");
const LARGER_PRICE = formatPlanSize("larger");

const AS_OF = formatCheckedMonth(PRODUCT_FACTS_CHECKED);

const SOURCE_LINKS = [
  { label: "Cursor pricing", href: "https://cursor.com/pricing" },
  { label: "Models and pricing", href: "https://cursor.com/docs/models-and-pricing" },
  { label: "Cloud agents help page", href: "https://cursor.com/help/ai-features/cloud-agents" },
  { label: "Cloud agents overview", href: "https://cursor.com/docs/cloud-agent" },
  { label: "Cloud agent environment setup", href: "https://cursor.com/docs/cloud-agent/setup" },
  { label: "Cloud agent security", href: "https://cursor.com/docs/cloud-agent/security" },
  { label: "Cloud agent network and secrets", href: "https://cursor.com/docs/cloud-agent/security-network" },
  { label: "Cloud agents on web and mobile", href: "https://cursor.com/docs/cloud-agent/web-and-mobile" },
  { label: "Self-hosted cloud agents", href: "https://cursor.com/docs/cloud-agent/self-hosted" },
  { label: "Cloud agent API limits", href: "https://cursor.com/docs/cloud-agent/api/overview" },
  { label: "Cursor security", href: "https://cursor.com/security" },
  { label: "Cursor terms of service", href: "https://cursor.com/terms-of-service" },
];

export const page: ComparePage = {
  slug: "vs-cursor-cloud-agents",
  browserTitle: "Cursor cloud agents vs Hivra: a Cursor run or a computer | Hivra",
  h1: "Cursor cloud agents vs Hivra: a Cursor run in the cloud or a computer of its own",
  metaDescription: `Cursor cloud agents need a plan from $30 a month; Hivra is ${ENTRY_PRICE_PROSE}, AI separate on both. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "These two products are less alike than the names suggest. Cursor cloud agents run Cursor's own coding agent, on a curated set of models, inside a virtual machine that Cursor manages. You start a run from the editor, the web, a phone, Slack, a pull request comment or the API, the agent works on its own branch, and you review what it pushes. Hivra gives you a computer that stays on, and lets you run one of several supported agents on it, then open the computer and look at its files and terminal.",
        "So the question is not which one has the better agent. It is whether the thing you want is a Cursor workflow or a place to keep an agent living. If your work is a stream of well-defined repository tasks that end in a pull request, Cursor's design fits that directly. If you want an agent that keeps a working directory, a dev server, logins and history from one day to the next, or you want to choose between Claude Code, Codex, OpenClaw and others, that is what a computer is for.",
        "Hivra is not affiliated with or endorsed by Cursor, Anysphere or any other agent maker. Where Hivra runs another maker's agent, it runs the agent that maker publishes, and you use your own account or key with it, or pay with Hivra credits. You can use both, and the sections below say which job suits which.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `With Cursor you are paying for a Cursor subscription, and cloud agents are one thing it unlocks. As of ${AS_OF}, Cursor's pricing page lists a Free plan, Plus at $8 a month, Premium at $30 a month, Super at $100 a month and Ultra at $200 a month, with Teams from $30 a user a month and Enterprise by contact. Annual billing is listed in Cursor's docs at $80, $300, $1,000 and $2,000 a year for the four paid individual plans. Cursor's help page says cloud agents are not included on Free or Plus: you need Premium or above, Teams, Enterprise, or one of the older plans that remain for existing customers. Cursor's pricing page says subscriptions are sold directly through X Subscription Corp, its models and pricing docs send billing to grok.com, and its terms of service name Anysphere, Inc. as the contracting party. Confirm the seller before you pay.`,
        "The monthly price is not the whole bill. Cursor says cloud agents draw from the same weekly usage pool as the editor and the command line tool, and that the pool refreshes weekly. Third-party models such as Claude, GPT and Gemini sit outside the pool. On Premium and above they are billed at the model's API list price from prepaid credit that you top up, with an optional automatic top-up and a monthly cap on additional usage. Cursor's docs give example rates per million tokens, such as $2 input and $10 output for Claude Sonnet 5.5. On Teams and Enterprise, Cursor adds a $0.25 per million token rate on some third-party models on top of the API price. On the older request-based plans, cloud agents run in Max Mode, which is billed at the model's API rate plus 20 percent.",
        "Cursor's cloud agent overview says you will be asked to set a spend limit when you first start using cloud agents, in the passage about request-based plans; it does not say whether this applies to the weekly pool plans. Cursor also says that when the pool runs out, requests are not downgraded in quality or speed: you wait for the reset, use credit, or upgrade. Cursor publishes no separate charge for the virtual machine, and says managed cloud agents include their execution infrastructure. It does not publish a dollar value for the weekly pool on each plan, only multiples such as four, fifteen and fifty times Plus.",
        `With Hivra you are paying for a computer. ${ENTRY_PRICE_PROSE}. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} A Hivra account itself costs nothing, and it works with a server you connect yourself. ${AI_USAGE} That keeps two lines on the bill: the computer, and the model usage, which comes from whichever account or key you point the agent at.`,
        `As a labelled illustration with no token volumes assumed: Cursor Premium at $30 a month plus whatever third-party tokens you buy at list price, such as $2 input and $10 output per million for Claude Sonnet 5.5, against ${ENTRY_PRICE_PROSE} plus your own model account. Hivra also has a larger size at ${LARGER_PRICE}. Cursor does not publish its VM size, so the two are not a like for like hardware comparison.`,
        "Neither number is the cost of your work until you know what the work is. A Cursor subscription that you already hold for the editor may make cloud agents cheap to add, though heavy runs on third-party models draw on prepaid credit. A Hivra computer is an extra bill, but a flat one for the machine, and an agent that sits mostly idle does not change it.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra fits when you want the environment to outlast the task. ${STAYS_ON} Files, repositories, logins and session history stay on the computer, and you open it from the dashboard to use its terminal, files and browser rather than receiving only a summary of what changed.`,
        `It also fits when the agent matters. Hivra supports ${HIVRA_AGENTS_CELL}, each on a computer of its own, so you can run Claude Code or Codex on the same footing as a general agent such as OpenClaw. Cursor's docs describe Cursor's own agent in cloud agents. They do not describe running other makers' agent command line tools inside a cloud agent VM, so if that is what you need, ask Cursor before you plan around it. Hivra does not run Cursor's agent.`,
        "It fits less well when your whole workflow already lives in Cursor. Hivra's own pages do not describe an editor integration, starting an agent from a Slack message or pull request comment, or a fleet of parallel branch workers, so if that workflow matters, check before you plan around it. A Hivra computer is a machine that you, and the agent you choose, use together.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Choose Cursor cloud agents when you already pay for Cursor and the work is repository tasks. They start from where you already are: the desktop agent menu, the web, Cursor's iOS app, Slack, comments on GitHub or Bitbucket pull requests, Linear, or the API, which Cursor lists as a public beta. Each agent clones the repository, works on its own branch and pushes back, and many can run at once without your laptop staying online. Cursor says each virtual machine has a full desktop and can control a browser, and that repositories can come from GitHub, GitLab, Bitbucket Cloud or Azure DevOps.",
        "Cursor is also the better choice when a security review matters. Cursor states a SOC 2 Type II attestation and ISO/IEC 27001:2022, ISO/IEC 42001:2023 and AIUC-1 certifications for the company, with certificates and reports on request at trust.cursor.com. These are company-level statements, so ask Cursor what they cover for cloud agents. Its pages also state encryption in transit and at rest, signed commits, and that cloud agents run in Privacy Mode (Legacy Privacy Mode is not supported), with Cursor saying that with Privacy Mode on it never trains on code accessed by cloud agents. Its network settings let you allow everything, add an allowlist or allow only an allowlist, and it offers private networking through Tailscale or Cloudflare Tunnel. Hivra does not claim a security attestation. If your employer needs one, Hivra cannot give you that today.",
        "And choose Cursor when you want agents that are managed for you at team scale: shared secrets, Enterprise administration, and a managed setup that does not leave a computer for you to look after. Cursor also offers Self-Hosted Machines, where tools run on a machine you operate while Cursor runs the agent loop; you pay for and maintain that machine.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Cursor cloud agents compared",
          rows: [
            { criterion: "Price model", hivra: "A flat monthly price for a computer, from $9.99/month, 2 vCPU and 4 GB RAM", alternative: "A Cursor subscription; cloud agents need Premium at $30/month or above, Teams or Enterprise" },
            { criterion: "What you get", hivra: "A full computer of its own that you open: terminal, files, browser", alternative: "A managed workspace: runs of Cursor's agent in a Cursor-managed VM with a shared terminal, ending in a branch and a draft pull request" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Not a standing machine: the VM is hibernated, then deleted on timers once a run is idle; Cursor does not publish the durations" },
            { criterion: "Persistence", hivra: "Files, repositories, logins and session history stay on the computer", alternative: "Disk state saved by an environment build; running processes do not carry over. Conversation history and artifacts kept by default" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "Cursor's own agent on a curated set of models; Cursor's docs do not describe other makers' agent CLIs inside the VM" },
            { criterion: "Models and AI cost", hivra: "Not in the plan: your own account or key where the agent supports it, or Hivra credits", alternative: "A weekly pool for Cursor's models; third-party models at API list price from prepaid credit on Premium and above; spend limit asked at first use on request-based plans (per Cursor's cloud agent overview)" },
            { criterion: "Access method", hivra: "Dashboard, with the agent's chat, terminal, files and browser", alternative: "Cursor desktop, cursor.com/agents, iOS app (iOS 26.0 or later; admin, billing and usage are web only), Slack, pull request comments, Linear, API (public beta)" },
            { criterion: "Terminal into the machine", hivra: "Yes, a Terminal tab on the computer", alternative: "A shared terminal with the agent, and an editor and file browser on cursor.com/agents; Cursor does not describe direct SSH to a managed VM" },
            { criterion: "Setup effort", hivra: "Pick an agent and open the computer; install your own tools on it", alternative: "Agent-led setup, a Dockerfile in .cursor/environment.json, or a saved environment; repositories from four providers" },
            { criterion: "Size and limits", hivra: `Stated per size: ${formatPlanSize("entry", "compact")}; ${formatPlanSize("larger", "compact")}`, alternative: "Default VM has limited memory and CPU, with no figures; custom size listed as coming soon" },
            { criterion: "Who maintains it", hivra: "Hivra runs the computer; you keep the agent and your tools up to date", alternative: "Cursor runs the VM and the agent; you maintain the environment definition" },
            { criterion: "Data and security", hivra: "Your computer, behind your sign-in; no security attestation claimed", alternative: "TLS 1.2+ and AES-256, runs in Privacy Mode (Legacy not supported), company-level SOC 2 Type II attestation and ISO 27001 certification stated; runs on Cursor's AWS infrastructure" },
            { criterion: "Regions", hivra: "No region choice stated here", alternative: "No region or data residency published for cloud agents" },
            { criterion: "Exit and portability", hivra: "Your files and repositories are on the computer; use git and copy files out", alternative: "Work leaves as branches and pull requests; saved disk state is deleted after 30 days of inactivity" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Terms say fees are non-refundable except as required by law; nothing specific to cloud agents" },
            { criterion: "Best for", hivra: "A persistent environment and a choice of agents", alternative: "Parallel repository tasks inside a Cursor workflow" },
          ],
        },
      ],
    },
    {
      heading: "Who should pick which",
      blocks: [
        {
          kind: "entries",
          items: [
            { lead: "Priya, a backend developer who already pays for Cursor Premium.", text: "She wants to tag a bug in a Slack thread and get a draft pull request back. **Cursor cloud agents.** The workflow she wants is the one Cursor built, and a computer would be a machine to look after that her workflow does not need." },
            { lead: "Marcus, who uses Claude Code every day and wants it running while he sleeps.", text: `He needs the agent's own terminal, his repository and his login to still be there in the morning. **Hivra.** ${CLI_RUN_LIFETIME}` },
            { lead: "Dana, an engineering lead whose security team asks for SOC 2 reports.", text: "She needs something she can put in front of an auditor. **Cursor cloud agents.** Cursor states a SOC 2 Type II attestation and ISO 27001 certification and offers certificates and reports on request, and Hivra claims no attestation, so Hivra cannot give her that today. She should ask for the certificates at trust.cursor.com and check the scope." },
            { lead: "Tom, who wants a personal agent that runs scheduled tasks and keeps a memory.", text: "His work is not a pull request, and Cursor's docs describe a coding agent for repositories. **Hivra**, running OpenClaw or Agent Zero as a general agent on a computer that stays on." },
            { lead: "Lena, who wants ten independent fixes across several repositories at once.", text: "Each should be its own branch, reviewed separately. **Cursor cloud agents.** Cursor describes many agents running in parallel, each on its own branch, and Hivra's pages do not describe a parallel branch workflow." },
            { lead: "Kofi, who keeps a dev server, a database and a half-finished investigation around for weeks.", text: "He cannot rebuild that state for each run, and Cursor says builds keep disk state only, not running processes. **Hivra.** A computer is the place where that state simply stays." },
            { lead: "Sam, a developer who wants both.", text: "He sends clear repository tasks to Cursor and keeps a Hivra computer for exploratory work and the agents Cursor does not run. **Both.** Nothing about one stops the other, and each bill is separate." },
          ],
        },
      ],
    },
    {
      heading: "How to try both",
      blocks: [
        {
          kind: "steps",
          items: [
            { lead: "Pick one real task.", text: "Choose a bug or small feature in a repository you know, with a clear way to check it worked. Use the same task on both sides." },
            { lead: "Run it on Cursor.", text: "Commit or stash first. Cursor's help page says Move to Cloud does not carry local uncommitted changes, so the agent starts from a clean state on the remote. On plans where Cursor asks for it, set the spend limit, and note how much of the weekly pool or prepaid credit the run used." },
            { lead: "Run it on Hivra.", text: "Open a paid Hivra Cloud computer with the agent you prefer, clone the repository and give it the same task. Add your own account or key for the model, or use Hivra credits, and note what that usage cost." },
            { lead: "Leave both overnight.", text: "Come back the next day. Check what is still there: the files, the dev server, the login, the history." },
            { lead: "Add up a month.", text: "Count the subscription or computer, plus model usage, for the number of tasks you really run. Then keep the one that matches how you work, or keep both." },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Cursor, the unit is the run. Cursor says a run ends by saving conversation state and artifacts to Cursor-managed storage, handing off a branch and a draft pull request, and then the virtual machine is hibernated and later deleted on lifecycle timers once the run is idle. Sending a follow-up prompt refreshes the timer. Cursor does not publish how long those timers are. Saved disk copies used to resume without cloning again are deleted after 30 days of inactivity, each start or resume restarts the 30 days, and Cursor says they cannot be deleted on demand. Environment builds keep disk state only: running processes, exported shell variables and in-memory caches do not carry over. Conversation history, tool calls and artifacts are kept by default, and secrets stay until you delete them. Conversation history and artifacts can be deleted on demand with Cursor's Delete Agent API, and Enterprise admins can cap retention at 90 days.",
        `On Hivra, the unit is the computer. ${STAYS_ON} Your files, repositories, logins and session history stay on it, because it is a machine you keep, not a run that finishes. Work started inside tmux in the Terminal tab keeps going when you close the laptop, which is the approved wording in full: ${CLI_RUN_LIFETIME}`,
        "Neither side replaces source control. Hivra does not promise backups, so keep work you cannot lose in a git remote. On Cursor, treat the branch and pull request as the lasting record and the saved environment as a convenience.",
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: {
    checked: PRODUCT_FACTS_CHECKED,
    intro: `Cursor's figures on this page come from its own pricing, documentation, security and terms pages, as of ${AS_OF}. Plans, usage pools and model rates change, so check the source before you rely on them.`,
    notes: [
      "Cursor's pricing page says prices exclude taxes and are subject to change, and its own pages disagree on Android: one says it is supported through a web app, another says it is planned. This page does not rely on either.",
      "Hivra's figures come from its pricing page and terms. The pricing page text read showed monthly prices only. Annual prices come from Cursor's models and pricing docs page. Its model rate table says it can show more models, so the rates quoted here may be a partial list.",
      "Not stated on the pages read: a maximum run time for a cloud agent, the idle and delete timers, exact VM CPU, RAM and disk, a limit on parallel agents for individual plans, the dollar size of the weekly pool, a region choice, a refund policy for cloud agents, and whether other makers' agents such as Claude Code or Codex can run inside a cloud agent VM. No price on the pages read needed a sign-in.",
    ],
    links: SOURCE_LINKS,
  },
  faqs: [
    {
      q: "How much do Cursor cloud agents cost?",
      a: "As of November 2026, Cursor's help page says cloud agents are not included on Free or Plus. Premium at $30 a month is the lowest current plan for new subscribers; the legacy Start, Pro, Pro+ and Ultra plans also include cloud agents for existing customers, billed differently. Higher plans are listed at $100 and $200 a month, and Teams from $30 a user a month. Usage draws from a weekly pool, and third-party models are billed at API list price from prepaid credit on Premium and above. Cursor publishes no separate VM charge. Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM, with a larger size at $19.99 a month for 4 vCPU and 8 GB of RAM, and does not include AI usage.",
    },
    {
      q: "Is Hivra a replacement for Cursor cloud agents?",
      a: "No. Cursor cloud agents run Cursor's own agent in a managed virtual machine and hand back branches and pull requests. Hivra gives you a computer that stays on, and lets you run agents such as Claude Code, Codex or OpenClaw on it. They overlap when you want an agent working while your laptop is closed, and differ in almost everything else.",
    },
    {
      q: "Can I use Cursor cloud agents and Hivra together?",
      a: "Yes. Nothing about one stops the other. Some teams will want both: Cursor for clear repository tasks, Hivra for a persistent environment or an agent Cursor does not run. Hivra is not affiliated with or endorsed by Cursor or Anysphere.",
    },
    {
      q: "Can I run Cursor's agent on a Hivra computer?",
      a: "No. Hivra supports OpenClaw, Agent Zero, Claude Code, Codex and Aeon, which hosts its dashboard only. Cursor's cloud agents run in Cursor's own infrastructure. Cursor also offers self-hosted machines, where tools run on a machine you operate while Cursor still runs the agent loop and inference, but that is a Cursor feature and not something Hivra provides.",
    },
    {
      q: "Does a Cursor cloud agent keep running when I close my laptop?",
      a: "Yes for the run. Cursor says agents keep working in the cloud even if your device disconnects. The virtual machine is then hibernated and later deleted on timers once the run is idle, and Cursor does not publish how long those timers are. A paid Hivra Cloud computer stays on and is not paused for inactivity.",
    },
    {
      q: "What happens to my data on Cursor cloud agents?",
      a: "Cursor states that data is encrypted in transit and at rest, that cloud agents run in Privacy Mode (Legacy Privacy Mode is not supported), and that with Privacy Mode on it never trains on code accessed by cloud agents. It also says conversation history, tool calls and artifacts are kept by default but can be deleted on demand with its Delete Agent API, Enterprise admins can cap retention at 90 days, and saved disk copies are deleted after 30 days of inactivity and cannot be deleted on demand. Its network page warns that terminal commands run without per-command approval, which creates data exfiltration risk from prompt injection.",
    },
    {
      q: "Which is better for running an AI coding agent 24/7?",
      a: "A computer that stays on is the closer fit for an agent that keeps its own working state. Hivra offers that, and a paid computer is not paused for inactivity. Cursor cloud agents are built for runs that end in a branch and pull request, and their machines are not a standing server. For a stream of repository tasks, Cursor's design is a fit.",
    },
    {
      q: "Does Hivra include AI model usage?",
      a: "No. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Cursor's model usage works differently, with a weekly pool for some models and prepaid credit at API list price for third-party models on Premium and above.",
    },
    {
      q: "What is the refund policy on each?",
      a: "Hivra has a 7-day money-back guarantee on card payments. Cursor's terms of service say fees are non-refundable except as required by law, and its pages do not describe a refund policy specific to cloud agents. Read the current terms before you pay.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-claude-code-on-the-web", "vs-openai-codex-cloud", "vs-github-codespaces", "ai-agent-hosting-alternatives"],
    agents: ["claude-code"],
    docs: ["claude-code"],
    pricing: true,
    extra: [{ label: "Blog: Cursor cloud agents explained", href: "/blog/cursor-cloud-agents" }],
  }),
};
