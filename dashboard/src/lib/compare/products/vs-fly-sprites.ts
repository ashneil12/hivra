import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "@/lib/blog/plan-facts";
import type { ComparePage } from "../types";
import { formatCheckedMonth } from "../competitor-facts";
import {
  AI_ACCESS_CELL,
  AI_USAGE,
  CLOSING,
  ENTRY_PRICE_PROSE,
  HIVRA_AGENTS_CELL,
  PRICES_AS_OF_STAMP,
  REFUND_LINKED,
  STAYS_ON,
  cautionSection,
  paragraphs,
  priceSources,
  relatedLinks,
} from "../shared-copy";
import { PRODUCT_FACTS_CHECKED } from "./checked";

const AS_OF = formatCheckedMonth(PRODUCT_FACTS_CHECKED);

export const page: ComparePage = {
  slug: "vs-fly-sprites",
  browserTitle: "Fly.io Sprites vs Hivra: sandboxes you program or a computer | Hivra",
  h1: "Fly.io Sprites vs Hivra: programmable sandboxes or a ready agent computer",
  metaDescription: `Sprites bills compute by the hour of use; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits an agent. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Fly.io Sprites and Hivra both give an agent a Linux computer that is not your laptop, but they are different kinds of product. Sprites is a developer-facing sandbox platform: you create environments from a CLI, an API or an SDK, and you pay for the compute and storage they actually use. Hivra is a managed, ready-to-open agent computer: you pick a supported agent, Hivra provisions the machine, and you open it in a browser at a flat monthly price.",
        "So the question is less which one is cheaper and more who is meant to drive. If you want to script a fleet of disposable or semi-persistent environments, Sprites is built for that. If you want one computer of its own for an agent, that is simply there when you come back, Hivra is built for that.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `Fly.io bills Sprites by usage, hourly, with nothing charged per Sprite. As of ${AS_OF} its page lists CPU at $0.0385 per CPU-hour (cumulative CPU usage), memory at $0.021875 per GB-hour (actual usage), hot storage at $0.000683 per GB-hour (about $0.50 per GB-month) and cold storage at $0.000027 per GB-hour. Bandwidth is not metered for Sprites. There is no base fee on pay-as-you-go, so an environment that is mostly paused costs very little.`,
        "Fly.io also sells optional monthly plans that bundle allowances, with usage above them billed at the standard rates. Its page shows Hero at $100 a month with 1,200 CPU-hours, 4,800 GB-hours of memory and 150 GB of storage, and Mythic at $2,000 a month with 28,000 GB-hours of memory. Other plan names appear without a price or allowance on the page we read. Plan fees are billed separately from Fly.io credits, which apply only to Sprites usage.",
        "Fly.io gives two examples of its own: a 4-hour Claude Code session that bursts to 100% of 8 CPUs and 8 GB but averages 30% of 2 CPUs and 1.5 GB costs $0.23, and a web app awake for 30 hours in the month with about 5 concurrent users costs $1.05 a month. These are the vendor's illustrations, not guarantees. As our own arithmetic, one CPU kept fully busy for a 730-hour month would be about $28 on the CPU rate alone, before memory and storage. Our own worked line for 2 CPUs and 4 GB busy all month is about $56.21 for CPU plus about $63.88 for memory, roughly $120 before storage, so a fully busy always-on Sprite of that size costs more than $9.99, while a mostly idle one costs far less. Real figures depend on how hard the agent works.",
        "A meter rewards workloads that are idle most of the time and punishes ones that are busy all the time. It also asks you to forecast. Fly.io says the invoice is authoritative and the dashboard usage meter may differ, and that bills finalize at month end. Fly.io's general Terms of Service, which do not name Sprites, say fees are billed in advance on a monthly basis, so the monthly plan fees likely fall under that. For Sprites usage, the pricing page says resources are billed hourly on actual usage.",
        `Hivra charges for a computer rather than for use: ${ENTRY_PRICE_PROSE}. ${AI_USAGE}`,
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and runs the agent's own installer, and you work through a browser view with chat, a terminal and files. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "That has a price: it is a flat fee even in a week when the agent does little, and Hivra is not a place to create hundreds of throwaway environments from code. There is no per-minute meter, so the plan price does not change with how hard the agent works. AI usage is paid separately and does change with it.",
        "Hivra is independent and is not affiliated with Fly.io, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A Hivra account costs nothing, but every Hivra Cloud computer is a paid plan. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Sprites is the better choice when you are building something with it. If you want to create environments from code, hand an agent a fresh sandbox per task, expose each one on its own HTTPS URL, or restore one from a checkpoint after an experiment goes wrong, Sprites has an API, a CLI and SDKs in JavaScript, Go, Elixir and Python for exactly that. We have not published a public API or SDK for creating Hivra computers from code, so that kind of scripting is not what Hivra offers today.",
        "Sprites is also better when the workload is bursty. Fly.io says idle Sprites incur no compute charges and pause after about 30 seconds of inactivity, so a few active hours a month can cost far less than a flat subscription, as the vendor's own $0.23 example shows. And if you need an environment that scales out past one machine, Fly.io lists limits of 100 concurrently running Sprites on the Hero plan, with higher tiers raising the ceiling.",
        "Choose Hivra when you want the agent itself to live somewhere without you writing the keep-alive logic, and when a fixed monthly figure matters more than the lowest possible bill.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Fly.io Sprites compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Pay-as-you-go by the hour of use, no base fee; optional monthly plans (Hero $100/mo, Mythic $2,000/mo), as of ${AS_OF}` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "A sandbox environment created from a CLI, API or SDK" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "8 vCPUs per Sprite; memory is assigned per Sprite and can autoscale, with no fixed figure published" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Pauses after about 30 seconds of inactivity; a held task, open connection or Service keeps it active" },
            { criterion: "Persistence", hivra: "Files, repos, logins and CLI session history stay on the computer", alternative: "Files, packages, Git repos and SQLite-style databases survive a pause; running processes, memory and open connections do not" },
            { criterion: "Storage", hivra: "Disk size on the computer is not published", alternative: "100 GB per Sprite, billed on bytes written; no resizing yet" },
            { criterion: "Agents", hivra: HIVRA_AGENTS_CELL, alternative: "Its page lists Claude Code, Codex, Cursor, OpenCode, OpenClaw, Hermes, any MCP client and others" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Its pricing covers compute and storage; its pages do not say model usage is included" },
            { criterion: "Access method", hivra: "Browser view with chat, terminal and files", alternative: "CLI, REST API, SDKs and a per-Sprite HTTPS URL; no browser desktop is described" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Install the CLI or call the API, then add your own keep-alive handling for long runs" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "Fly.io runs the platform; you manage what runs inside the Sprite" },
            { criterion: "Data and security", hivra: "Each agent runs on its own computer, isolated from other customers' computers", alternative: "Hardware-isolated microVMs, connectors that keep provider credentials outside the Sprite, and an optional org-private URL" },
            { criterion: "Limits", hivra: "Set by the plan's total CPU and RAM, shared by the agents on it; no per-run or per-minute cap", alternative: "100 concurrently running Sprites on Hero; creation capped at 10 a minute on pay-as-you-go" },
            { criterion: "Support", hivra: "Support channel and response times are not published on this page", alternative: "Community on pay-as-you-go; email and premium tiers on higher plans" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Not stated in its terms or on the Sprites page" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "Terms say you can export data and that Fly.io is not obliged to back it up" },
            { criterion: "Best for", hivra: "A developer who wants an agent's own computer, open and ready", alternative: "A developer who wants programmable environments billed by use" },
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
            { lead: "Maya, building a coding product with an agent per task:", text: "She needs to create hundreds of short-lived environments from her own backend and tear them down. Pick Sprites. Its API, SDKs and per-use billing fit that shape, and a flat monthly computer does not." },
            { lead: "Tom, who runs one Claude Code agent for his own side projects:", text: `He wants to open it from his phone in the evening and find his repos and CLI session history as he left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. He is not writing code to keep the agent alive.` },
            { lead: "Priya, who runs an agent a few hours each week:", text: "Most of the month it sits idle, and she is comfortable with a CLI. Pick Sprites. Paying for the hours of use, as in the vendor's $0.23 four-hour example, is likely to cost less than a monthly fee." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: "It must keep going when he closes his laptop and be there each morning. Pick Hivra, with one condition on how he starts the run. If he runs Claude Code or Codex, a run he starts inside tmux in the computer's Terminal tab keeps going after he closes the laptop, and on Claude Code, work he sends through Telegram runs on the computer, not in his browser. A run started in the browser chat or the agent's session tab is not certain to continue on every computer. If he runs Hermes, OpenClaw or Agent Zero, they run on the computer itself and need no open browser. On Sprites he would need a task, a Service or a heartbeat to stop it pausing." },
            { lead: "Dana, an engineer testing untrusted generated code:", text: "She wants a disposable, locked-down sandbox. Pick Sprites. Fly.io lists egress-locked, disposable VMs for untrusted code, and separately offers checkpoints that roll files back. A restore ends active sessions and does not back up the state it replaces, so she should checkpoint first." },
            { lead: "Sam, a founder who would rather not forecast a bill:", text: "A flat figure is easier to approve than an hourly meter that may differ from the final invoice. Pick Hivra, and put model usage on the account or key you already pay for." },
            { lead: "Leo, who wants both a sandbox API and a home for his agent:", text: "Use both. Keep the agent on a Hivra computer. In principle, since Sprites has a public REST API, an agent with network access and a Fly.io token could create Sprites when it needs a clean environment. We have not tested that." },
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
            { lead: "Pick one real task.", text: "Use something your agent already does, such as a scheduled report or a repo it keeps up to date, so both runs do the same work." },
            { lead: "Run it on Sprites.", text: `Fly.io's page lists a $1 trial credit for new Fly.io accounts, valid for a week and shared across Sprites, Machines and Managed Postgres, which is an offer that may change. Create a Sprite from the CLI, run the task, and note what keeps it awake and what the usage meter shows.` },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "Start the Hivra run inside tmux in the Terminal tab (or send it through Telegram on Claude Code), because a browser chat or session-tab run is not certain to continue. In the morning, check which one finished the scheduled work and whether the files, repos, login and CLI session history were where you left them." },
            { lead: "Compare a full month.", text: `Add up the Sprites invoice, which Fly.io says is authoritative, plus model usage on either side, against ${ENTRY_PRICE_PROSE}.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Sprites, Fly.io says files and directories, installed packages, Git repos and SQLite-style databases survive a pause. Running processes, in-memory state and open network connections do not, which matters for websockets and streaming API calls. A warm pause preserves process state, a cold pause does not, and /tmp is not a durable location. Services are restarted by the runtime after boot, crashes and cold wakes. Its docs give about 30 seconds of inactivity before pausing and do not state how long warm lasts before going cold.",
        "Fly.io's working-with-Sprites docs list what counts as activity: active exec or console commands, open TCP connections, running TTY sessions and Services with open connections. Its keeping-Sprites-running docs add the Tasks API, which holds a Sprite active. A task lasts at most an hour and can be renewed with a heartbeat, for example a 5-minute expiry refreshed every minute, and a forgotten heartbeat loop keeps billing.",
        "Checkpoints capture the writable filesystem copy-on-write, so they are fast and the Sprite keeps running. Restoring rolls files back and restarts the environment, ends sessions, and does not resume a paused process or back up the state it replaces. The last five checkpoints are mounted read-only, and automatic ones are pruned over time.",
        `${STAYS_ON} The computer keeps your files, repos, logins and CLI session history. Hivra makes no promise of backups, so keep your own copy of anything you cannot lose, on either platform.`,
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "Fly.io Sprites product and pricing page", href: "https://fly.io/sprites" },
      { label: "Sprites docs overview", href: "https://docs.fly.io/sprites" },
      { label: "Sprites lifecycle docs", href: "https://docs.fly.io/sprites/concepts/lifecycle.md" },
      { label: "Working with Sprites docs (idle detection)", href: "https://docs.fly.io/sprites/working-with-sprites.md" },
      { label: "Keeping Sprites running docs", href: "https://docs.fly.io/sprites/keeping-sprites-running.md" },
      { label: "Sprites checkpoints docs", href: "https://docs.fly.io/sprites/concepts/checkpoints.md" },
      { label: "Fly.io Terms of Service", href: "https://fly.io/legal/terms-of-service" },
    ],
    [
      "Fly.io's $1 introductory credit and the plan allowances are vendor offers that may change. Several plan names (Adventurer, Veteran, Champion, Legend and Epic) appear on its page without a price or allowance, so they are not quoted here.",
      "Not stated on the pages we read: regions for Sprites, a refund policy, a guaranteed memory size, how long a Sprite stays warm before going cold, compliance certifications, and a Sprites-specific terms of service.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does Fly.io Sprites cost?",
      a: `Fly.io bills Sprites by usage, with no base fee on pay-as-you-go. As of ${AS_OF} its page lists $0.0385 per CPU-hour, $0.021875 per GB-hour of memory and about $0.50 per GB-month of hot storage, plus optional monthly plans such as Hero at $100 a month. Its own example puts a 4-hour Claude Code session at $0.23. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is Sprites cheaper than Hivra?",
      a: "For an agent that is idle most of the time, it can be, because idle Sprites incur no compute charges. As a rule of thumb from our own arithmetic on Fly.io's published rates, a 2 CPU, 4 GB Sprite that is actively busy costs about $0.16 per hour for CPU and memory, so usage reaches about $9.99 after roughly 60 busy hours in a month, before storage. Below that Sprites tends to be cheaper, above it Hivra does. Fly.io's own examples are far lower because they average low use.",
    },
    {
      q: "Can I use Sprites and Hivra together?",
      a: "They do different jobs, and nothing stops you using both. In principle, since the Sprites API is a public REST API, an agent on a Hivra computer with network access and a Fly.io token could call it, but we have not tested that. You would pay each on its own terms.",
    },
    {
      q: "Does a Sprite keep running when I close my laptop?",
      a: "Not on its own. Fly.io says a Sprite pauses after about 30 seconds of inactivity unless something keeps it active, such as a request, an open connection, a task or a Service. Files survive a pause, but running processes and open connections do not.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `${STAYS_ON} That is the computer: for Claude Code or Codex, a run started inside tmux in the Terminal tab, or Claude Code work sent through Telegram, keeps going after you close the laptop, while a browser chat or session-tab run is not certain to. Hermes, OpenClaw and Agent Zero run on the computer itself. On Sprites you design for it with tasks, Services or a heartbeat, and a task lasts at most an hour before it needs renewing. Compute is billed while it is active.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On Sprites, files, packages and Git repos survive pauses and checkpoints can roll files back. Fly.io's terms say it is not obligated to back up customer data and that you can export it. On Hivra, the computer keeps your files, repos, logins and CLI session history, but Hivra makes no promise of backups, so keep your own copy of anything important.",
    },
    {
      q: "Which one is better for running Claude Code or Codex?",
      a: "Both can run them. Fly.io's page lists Claude Code and Codex among supported agents, and Hivra hosts both. Choose Sprites if you want to create environments from code or run short bursts, and Hivra if you want to open one computer and leave the agent on it, starting long runs in tmux or through Telegram on Claude Code. Hivra is not affiliated with Fly.io, Anthropic or OpenAI.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} Fly.io's Sprites pricing covers compute and storage, and its pages do not say model usage is included.`,
    },
    {
      q: "Is there a free way to try each?",
      a: "Fly.io's page lists a $1 trial credit for new Fly.io accounts, valid for a week, as an offer that may change. A Hivra account costs nothing, but every Hivra Cloud computer is paid, with a 7-day money-back guarantee on card payments. A free account works with a server you connect yourself.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-e2b", "ai-agent-hosting-alternatives", "vs-railway"],
    blog: ["ai-agent-hosting-guide", "cost-of-running-ai-agent"],
    agents: ["claude-code"],
    docs: ["linux-computer"],
    pricing: true,
  }),
};
