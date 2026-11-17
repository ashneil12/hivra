import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
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
  slug: "vs-lobsterland",
  browserTitle: "Lobsterland vs Hivra: managed OpenClaw and Hermes hosting | Hivra",
  h1: "Lobsterland vs Hivra: two managed hosts for an always-on agent",
  metaDescription: `Lobsterland lists plans from $6.90 a month per instance; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Lobsterland and Hivra are close cousins. Both sell a managed computer for an AI agent, so you do not have to rent a server, install the agent and keep it patched. Lobsterland describes itself as managed hosting for AI agents: you launch an always-on, isolated agent and message it from a browser or a chat app. It is built around two runtimes, OpenClaw and Nous Hermes. Hivra is a managed agent computer that you open in a browser, with a wider list of supported agents.",
        "That overlap makes this a closer comparison than most. The two differ in how they price (Lobsterland by instance size, with three listed sizes; Hivra by the computer), in which agents they host, and in what surrounds the agent. Lobsterland has a lot of product built specifically around OpenClaw, and where your agent is OpenClaw it deserves a serious look. We say where it is the better choice below.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `Lobsterland prices each instance by size. As of ${AS_OF}, its homepage lists three monthly plans: Light at $6.90 for 1 CPU, 3 GB of RAM and 20 GB of storage; Medium at $14.90 for 2 CPU, 8 GB of RAM and 80 GB of storage; and Large at $29.90 for 4 CPU, 16 GB of RAM and 160 GB of storage. The page says "CPU" rather than "vCPU", and it does not say what the CPU is, so we compare the figures as stated.`,
        "Lobsterland lists two paid extras. A managed Paperclip workspace add-on is $4.90 a month for new deployments; its product-updates post describes it for OpenClaw agents. A Managed Setup Launch is $199 one time, covering one user, one OpenClaw workspace and one channel or setup path, with a one-week follow-up window; the page says it excludes custom workflow work, unlimited support and emergency response. Its Hosted Browser is described as an optional add-on, but the pages we read show no price for it, so we do not quote one.",
        "Lobsterland's pages describe a one-week trial: you add a card up front, deploy, and are charged only when the trial ends, and you can cancel at any time before then. Model usage is separate. Lobsterland says you bring your own provider keys, pay your provider directly, and that it adds no markup on LLM costs.",
        `Hivra charges for a computer: ${ENTRY_PRICE_PROSE}. ${AI_USAGE}`,
        `Set side by side, the entry prices are not the same size of computer. Lobsterland's Light plan at $6.90 is cheaper than Hivra's entry price but is a smaller machine at 1 CPU and 3 GB of RAM. Its Medium plan at $14.90 has 2 CPU and 8 GB of RAM, against ${ENTRY_PRICE_PROSE} on Hivra. Whether you would pay less depends on which size your agent needs, so measure that first. Neither side is cheaper in every case.`,
        "One more difference is how the bill is built. On Lobsterland the price is per instance, and the pages we read do not say how many agents an instance can hold or whether a plan can be changed mid-cycle, so confirm both before relying on either. Hivra's plan is the computer's size, and an agent uses what that computer has.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and sets the agent up, and you work through a browser view for that agent. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "The agent list is where Hivra differs most. Hivra hosts Hermes and OpenClaw, which Lobsterland also hosts, and it hosts other agents that Lobsterland's pages do not list, including Claude Code and Codex. If you want one place to run a coding agent next to an OpenClaw or Hermes agent, that is a reason to choose Hivra.",
        "Hivra is open source and you can read the code. You can also connect a server you run yourself and use Hivra's dashboard with it, which is a way out if you ever want to move off Hivra Cloud. Lobsterland's pages describe a workspace export instead, which we cover in the table.",
        "The trade-off is that Hivra does not match everything Lobsterland has built around OpenClaw. We do not claim that Hivra offers a Managed Setup service, ready-made agent kits or a read-only API for instances, and Hivra has no such thing to point to.",
        "Hivra is independent and is not affiliated with Lobsterland, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A Hivra account costs nothing, but every Hivra Cloud computer is a paid plan. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Lobsterland is the better choice when you want OpenClaw and want a lot of it managed. Its homepage lists a dashboard chat, a workspace editor, a skills manager, cron job management, encrypted environment variables, usage analytics, logs, WhatsApp and multi-agent management, with the heaviest of these listed for OpenClaw only (Hermes gets a narrower set: browser chat, Telegram, Slack, logs and skills). It also has a product-updates post on running multiple OpenClaw agents. If those are the things you would otherwise build or script yourself, Lobsterland has packaged them, and its product-updates page shows steady releases from February to August 2026.",
        "Lobsterland is also the better choice when the lowest monthly price matters. A $6.90 Light plan is a lower entry point than Hivra's, and for a light chat agent that fits in 1 CPU and 3 GB of RAM it will cost less. Lobsterland also publishes storage sizes (20, 80 and 160 GB) for each plan, and this page does not state a disk size for Hivra computers, so if you need to know your disk in advance, check Hivra's plan details or Lobsterland.",
        "It is better for anyone who wants help getting started. The $199 Managed Setup Launch is a paid, human-assisted setup, and its pages list human support by email or Telegram. It also offers five Agent Kits (Personal Assistant, Project Manager, Product Manager, Research Analyst and Financial Analyst) as preconfigured starting points, and a Business account where one owner is billed and members share purchased capacity. Hivra does not offer these.",
        "Choose Lobsterland as well if you want an EU-based host. Its footer states a Hetzner Kubernetes cluster in the EU, though the pages do not name data center locations, so ask before you rely on that for compliance. Finally, if you want to read your own instance data programmatically, Lobsterland has a read-only REST API with scoped tokens; writes are not available through tokens yet.",
        "Choose Hivra when you want an agent that Lobsterland does not host, such as Claude Code or Codex, when you want an open source platform you can leave with your own server, or when a single computer at a stated size suits you better than choosing among three sizes.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Lobsterland compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Monthly per instance: Light $6.90, Medium $14.90, Large $29.90, as of ${AS_OF}` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "A managed, isolated, always-on agent instance for OpenClaw or Hermes, used from a browser or chat app" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "Light 1 CPU and 3 GB RAM; Medium 2 CPU and 8 GB; Large 4 CPU and 16 GB (stated as CPU, not vCPU)" },
            { criterion: "Storage", hivra: "Disk size on the computer is not published", alternative: "20 GB on Light, 80 GB on Medium, 160 GB on Large" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Described as an always-on agent; its pages do not say whether an instance can pause" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "OpenClaw and Nous Hermes; you can run either or both on one account" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Bring your own provider keys, paid to your provider; it says it adds no markup on LLM costs" },
            { criterion: "Access method", hivra: "A browser view for the agent, which varies by agent", alternative: "Dashboard chat, Telegram, Slack and, for OpenClaw only, WhatsApp; Hosted Browser as an option" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Launch an instance and connect keys and channels; a $199 one-time Managed Setup Launch is offered" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "Lobsterland runs the platform and says it handles updates; you manage the agent and its keys" },
            { criterion: "Data and security", hivra: "Each agent runs on its own computer, isolated from other customers' computers", alternative: "No public IP and encrypted credentials (AES-256-GCM on its homepage) listed on its homepage; its security page describes separate runtimes per instance and advises restricting channels to approved users; no certifications stated on the pages we read" },
            { criterion: "Region", hivra: "Not stated on this page", alternative: "Footer: Hetzner Kubernetes cluster, EU-based; data center locations not named" },
            { criterion: "Developer access", hivra: "No public API for creating computers from code", alternative: "Read-only REST API and OpenAPI document with scoped bearer tokens; no CLI or SDK mentioned; token writes on its roadmap" },
            { criterion: "Support", hivra: "Support channel and response times are not published on this page", alternative: "Email or Telegram per its compare page; no response times or SLA stated" },
            { criterion: "Trial", hivra: "A Hivra account costs nothing, but every Hivra Cloud computer is a paid plan", alternative: "One-week trial per its pages; a card is added up front and charged when it ends" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "No refund policy found on its homepage or terms page" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "Full workspace export as a .tar.gz, which its terms say excludes secrets; terms retain metadata up to 90 days for soft-deleted accounts" },
            { criterion: "Best for", hivra: "A person who wants a coding or general agent's own computer, open and ready", alternative: "A person who wants OpenClaw or Hermes with the most dashboard features and a low entry price" },
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
            { lead: "Maya, who wants a personal assistant in WhatsApp:", text: "She wants an OpenClaw agent she can message from her phone. Pick Lobsterland. WhatsApp is listed as an OpenClaw channel, and a Personal Assistant kit is listed on a Light-tier plan, the cheapest size." },
            { lead: "Tom, who runs Claude Code on his own side projects:", text: `He wants to open it from a browser in the evening and find his repos and sessions as he left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. Lobsterland's pages describe OpenClaw and Hermes, not Claude Code.` },
            { lead: "Priya, who wants to be set up by a person:", text: "She would rather pay once for help than read documentation. Pick Lobsterland and consider its $199 Managed Setup Launch, which covers one user, one OpenClaw workspace and one channel or setup path." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: "He needs it to run while his laptop is closed. On either host he should test it. Lobsterland lists cron jobs for OpenClaw in its dashboard. Hivra's computer stays on, and for Claude Code or Codex a run started inside tmux in the Terminal tab keeps going after he closes the laptop, while Hermes, OpenClaw and Agent Zero run on the computer itself." },
            { lead: "Dana, who needs an EU-based host:", text: "She has been asked where the data lives. Lobsterland's footer says EU-based on a Hetzner cluster, so ask it for locations and any certifications in writing, since its security page names none. Hivra's region is not stated on this page, so she should ask Hivra too." },
            { lead: "Sam, a founder who wants an exit he controls:", text: "He worries about being locked in. Pick Hivra for the open source platform and the option to connect his own server. Lobsterland's workspace export is a fair exit too, but secrets are excluded from it, so he would re-enter keys elsewhere." },
            { lead: "Leo, who wants OpenClaw and Hermes side by side:", text: "Either works, because both hosts list both runtimes. Lobsterland says you can run either or both on one account and lists more OpenClaw dashboard features. Hivra suits him if he also wants a coding agent on the same platform." },
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
            { lead: "Pick one real task.", text: "Use something your agent already does, such as a scheduled report or a message it answers, so both runs do the same work." },
            { lead: "Run it on Lobsterland.", text: "Use the one-week trial its pages describe, remembering that you add a card up front and are charged when it ends. Deploy the runtime you use, connect your own key and one channel, and note when you would have to cancel." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "In the morning, check which one finished the scheduled work and whether the agent's files, memory and login were where you left them. On Hivra, start any long Claude Code or Codex run inside tmux in the Terminal tab." },
            { lead: "Compare a full month.", text: `Add up the Lobsterland plan, any Paperclip or Hosted Browser extras and the setup fee if you used it, plus model usage on either side, against ${ENTRY_PRICE_PROSE}.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Lobsterland, the security page says browser state belongs to the managed instance volume, and that browser profiles persist across sessions and can be reset when you need a clean browser. Its Hosted Browser post describes a persistent sidecar with saved profile state. The pages we read do not describe backups: no frequency, location or restore process.",
        "Lobsterland's terms say you can stop using the service at any time and should export your workspace and configuration first, and that secrets are excluded or redacted from exports. They say it retains metadata for up to 90 days for soft-deleted accounts. They do not state retention periods for active accounts or content. They also state that the service is provided as is, with no warranty of uninterrupted operation, and cap liability at what you paid in the prior 12 months, or $100 if that is greater.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, sessions and login. Hivra does not promise backups, so keep your own copy of anything you cannot lose, on either platform.`,
        "Lobsterland's FAQ answers the uptime question by saying it runs continuous monitoring for the hosting layer and that third-party dependencies and planned maintenance can still affect availability. We found no uptime percentage or SLA on its pages, and we have not published one for Hivra either.",
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "Lobsterland homepage and pricing", href: "https://lobsterland.ing/" },
      { label: "Lobsterland terms", href: "https://lobsterland.ing/terms/" },
      { label: "Lobsterland security", href: "https://lobsterland.ing/security/" },
      { label: "Lobsterland developers page", href: "https://lobsterland.ing/developers/" },
      { label: "Lobsterland compare page", href: "https://lobsterland.ing/compare/" },
      { label: "Lobsterland blog index", href: "https://lobsterland.ing/blog/" },
      { label: "Lobsterland product updates", href: "https://lobsterland.ing/blog/product-updates/" },
    ],
    [
      "Lobsterland's trial, plan sizes, add-on prices and the $199 setup fee are vendor offers that may change. The claim on its compare page that setup takes about two minutes is the vendor's own statement and we did not test it.",
      "Not stated on the pages we read: a refund policy, trial terms on its terms page, whether an instance can pause, how many agents an instance can hold, whether a plan can be changed mid-cycle, annual billing, a Hosted Browser price, data center locations, backups, compliance certifications, an uptime guarantee, and support response times. Its homepage says AES-256-GCM for stored credentials, while its security page names no algorithm.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does Lobsterland cost?",
      a: `As of ${AS_OF}, Lobsterland's homepage lists Light at $6.90 a month for 1 CPU, 3 GB of RAM and 20 GB of storage, Medium at $14.90 for 2 CPU, 8 GB and 80 GB, and Large at $29.90 for 4 CPU, 16 GB and 160 GB, per instance. A Paperclip add-on is $4.90 a month and a Managed Setup Launch is $199 one time. Hivra is ${ENTRY_PRICE_PROSE}.`,
    },
    {
      q: "Is Lobsterland cheaper than Hivra?",
      a: `At the smallest size, yes: Light at $6.90 is below Hivra's entry price, but it is 1 CPU and 3 GB of RAM against ${ENTRY_PRICE_PROSE}. Lobsterland's Medium at $14.90 has 2 CPU and 8 GB of RAM. Compare the size your agent actually needs, and add model usage on both.`,
    },
    {
      q: "Which agents does each support?",
      a: "Lobsterland's pages describe OpenClaw and Nous Hermes, and you can run either or both. Some features, such as WhatsApp, a workspace editor, cron and multi-agent management, are listed for OpenClaw only. Hivra hosts Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon (dashboard only) and DeepSeek Harness (alpha).",
    },
    {
      q: "Does Lobsterland have a trial?",
      a: `Its pages describe a one-week trial for which you add a card up front and are charged when it ends, with cancellation at any time before then. Its terms page does not mention the trial, so confirm the details when you sign up. A Hivra account costs nothing, but every Hivra Cloud computer is paid, with a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "Can I get a refund from Lobsterland?",
      a: "We could not confirm that. Neither its homepage nor its terms page states a refund policy. The pages say you can cancel at any time and that you may stop using the service at any time. Ask Lobsterland in writing before you pay if a refund matters to you.",
    },
    {
      q: "Does Lobsterland include AI usage in its price?",
      a: `No. Lobsterland says you supply your own provider keys, pay your provider directly and that it adds no markup on LLM costs. On Hivra, ${AI_USAGE}`,
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `Lobsterland describes an always-on agent, but its pages do not say whether an instance can pause or what its uptime is. On Hivra, ${STAYS_ON} For Claude Code or Codex, a run started inside tmux in the Terminal tab keeps going after you close the laptop. Test your own task on either.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On Lobsterland, you can export your workspace as a .tar.gz, with secrets excluded, and its terms say metadata is retained up to 90 days for soft-deleted accounts. Its pages do not describe backups. On Hivra, the computer keeps your files, sessions and login, but Hivra does not promise backups, so keep your own copy of anything important.",
    },
    {
      q: "Can I use Lobsterland and Hivra together?",
      a: "Yes. They are separate services, and you pay each on its own terms. For example, you could keep an OpenClaw agent on Lobsterland and run Claude Code on Hivra. Hivra is not affiliated with Lobsterland.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-xcloud", "vs-agent-37", "ai-agent-hosting-alternatives"],
    blog: ["managed-vs-self-hosted-ai-agents", "cost-of-running-ai-agent"],
    agents: ["openclaw", "hermes"],
    docs: ["openclaw", "plans-and-billing"],
    pricing: true,
  }),
};
