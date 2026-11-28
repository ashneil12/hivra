import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT, ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
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
  slug: "vs-orgo",
  browserTitle: "Orgo vs Hivra: agent desktops you program or a ready computer | Hivra",
  h1: "Orgo vs Hivra: cloud desktops you program or a ready agent computer",
  metaDescription: `Orgo sells agent cloud desktops from $29 a month; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Orgo and Hivra both give an AI agent a cloud computer that is not your laptop, but they start from different ends. Orgo's own pages describe cloud computers for AI agents: each one is an isolated virtual machine with its own disk, a full desktop, a browser and a terminal, which an agent can operate the way a person would, by looking at the screen, then clicking, typing or running shell commands. You create them from a dashboard, a CLI, an HTTP API, Python and TypeScript SDKs or an MCP server. Orgo says plainly that it provides the computer, not the agent: you bring Claude Computer Use, OpenAI's computer-use agent, Hermes Agent, OpenClaw or a loop of your own.",
        "Hivra is a managed computer for one agent. You pick a supported agent, Hivra provisions the machine and sets the agent up, and you open it in a browser and use it. The two products overlap more than most comparisons in this space, because Orgo also lets you run an agent such as Claude Code, Codex, Hermes or OpenClaw inside one of its computers. The question is who is meant to drive and how you want to pay. If your own code creates and manages many desktops, possibly Windows, Mac or iPhone ones, Orgo is built for that. If a person wants one Linux computer that an agent lives on and that is there each time they come back, Hivra is built for that.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `Orgo has two ways to pay, and its pages describe both. As of ${AS_OF}, you can pay by the hour from credit you add, with auto top-up so the balance does not run out, or you can take a monthly plan that keeps computers on and adds credit. Its pricing page lists Starter at $29 a month, Growth at $99 a month, Scale at $399 a month, and Enterprise on request with volume pricing, dedicated hosts and an SLA.`,
        "Each plan buys always-on capacity. Starter covers one Medium computer, which the page sizes at 2 vCPU, 8 GB of RAM and 40 GB of disk, with $5 a month of platform credit, 1 GB a month of residential IP data and room for you plus 5 teammates. Growth covers 4 Medium, or 2 Large, or 1 XL computer (8 vCPU, 32 GB RAM and 160 GB of disk in total), with $10 a month of credit, 5 GB of residential data and 1 custom domain. Scale covers 16 Medium, 8 Large or 4 XL (36 vCPU, 128 GB RAM and 640 GB of disk in total), with $50 a month of credit, 20 GB of residential data, 3 custom domains and room for you plus 25 teammates. Orgo lists the hourly equivalent of each plan's capacity as $40, $161 and $642, which is its way of showing what the same machines would cost running all month by the hour.",
        "By the hour, the Linux sizes on its pricing page are: Small at $0.023 an hour (0.5 vCPU, 4 GB RAM, 20 GB disk, API only), Medium at $0.055 (2 vCPU, 8 GB, 40 GB), Large at $0.11 (4 vCPU, 16 GB, 80 GB) and XL at $0.202 (6 vCPU, 32 GB, 150 GB). A stopped computer is billed at a lower rate, listed at $0.0027 an hour for Medium, so a disk you keep is not free. A 2XL size at $0.368 an hour is listed as available on request. The same page lists Linux sizes as a monthly add-on, for example $32 a month for Medium.",
        "Windows adds a licence charge. On Starter and Growth, the page lists a Windows computer at $15 a month plus the cost of its size, so a Windows Medium is $47 a month, and says Windows is included on Scale. Mac and iPhone are priced separately: a Mac mini M4 virtual machine starts at $100 a month, a physical iPhone 12 is $65 a month and an iPhone 17 is $129 a month by request, subject to stock. Orgo's pages do not list GPU prices where we looked.",
        "As our own arithmetic from those rates, one Medium computer running for a 730-hour month at $0.055 an hour comes to about $40, which matches the $40 hourly equivalent Orgo shows for Starter. So the $29 entry plan is cheaper than the same machine by the hour if it runs all month, and the hourly route is cheaper if the machine runs less than roughly 530 hours. Orgo's pricing calculator shows 48 computers each running 3 hours a day at about $241 a month by the hour, against $1,339 a month if all 48 stay on all day. The page does not name the size, though the figure is consistent with the Medium rate. Those are the vendor's illustrations, not quotes for your workload.",
        "Orgo's terms say that unless the law requires otherwise or something else is stated, payments are non-refundable, and that purchased residential data is not refunded once added. The terms also say pricing may change going forward with notice and do not give the notice period. We could not find whether credits expire.",
        `Hivra charges for one computer rather than for hours or desktops: ${ENTRY_PRICE_PROSE}. ${AI_USAGE}`,
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and runs the agent's own installer, and you work through a browser view for that agent. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "The price is simple to forecast. It is one flat monthly figure, there is no per-hour meter, and the plan does not change with how hard the agent works. AI usage is paid separately and does change with it.",
        "The trade-off is reach. A Hivra computer is a Linux computer for an agent, not a fleet of desktops for your code to create and tear down. We know of no public Hivra API or SDK for creating computers from code, and Hivra does not describe per-user workspaces to resell, live-resize, clone or fork operations, or Mac or iPhone targets. If your product needs those, Orgo covers ground Hivra does not.",
        "Hivra is independent and is not affiliated with Orgo, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A free Hivra account does not include managed compute. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Orgo is the better choice when the agent needs a real desktop to operate. Its model is a loop of screenshot, decide, act, and its API exposes screenshots, clicks, typing and shell commands directly, and it lists support for OpenAI-compatible models. If you are building a computer-use agent, automating a website that has no API, or testing software on Windows, Mac or a physical iPhone, Orgo is built for that. Hivra is not. Orgo's pages also describe a person watching and taking over: you can click and type on an agent's screen while it runs, and embed a computer's live screen in your own app.",
        "Orgo is also better when you need to work at fleet scale or as a platform. Its docs say a paid plan can hold 50 computers, with hourly computers beyond that up to 999 per account and larger fleets by contacting Orgo. It describes templates that define a computer in a file, workspaces and keys per user that you can bill directly or under your own name, scoped API keys with expiry, roles for teammates and guest links that expire. It lists suspend and resume with memory saved, live resize of CPU, memory and disk, cloning and forking a running computer, an end time after which a computer is deleted, SSH with your own key, public URLs for apps and custom domains. Hivra offers none of these as an API.",
        "It is better for bursty or short-lived work too. Billing by the hour means a computer you run for 3 hours costs a few cents for the compute, and Orgo's home page says desktops boot in about 500 ms and that there is no time limit, so you can create and discard them as needed. We have not measured that and Hivra makes no comparable claim.",
        "Orgo also lists a backup feature for Linux and Windows computers on its home page. Its pricing page and docs do not describe a backup service, so we cannot say what that covers.",
        "Choose Hivra when you want the agent itself to have a place to live, without writing the code that creates, resizes and reconnects it, and when one fixed monthly figure matters more than the lowest possible bill or the widest set of operating systems.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Orgo compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Pay by the hour from credit, or monthly plans: Starter $29/mo, Growth $99/mo, Scale $399/mo, Enterprise on request, as of ${AS_OF}` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "Isolated cloud computers with a desktop, browser and terminal that an agent or a person operates; the agent is yours to bring" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "Linux sizes from Small (0.5 vCPU, 4 GB) to XL (6 vCPU, 32 GB), with 2XL on request; Starter is one Medium (2 vCPU, 8 GB, 40 GB disk)" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Plans keep their always-on capacity on; hourly computers run until stopped, and its home page says there is no time limit" },
            { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer", alternative: "Its docs say files, installed software and configuration on disk survive stops and restarts; a stopped computer is billed at a lower hourly rate" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "Provides the computer, not the agent; its docs have guides for Claude Computer Use, OpenAI Computer Use, Gemini Computer Use, Hermes Agent, OpenClaw and Agent S3, and say you can run Claude Code or Codex inside one" },
            { criterion: "Operating systems", hivra: "Linux computer", alternative: "Linux and Windows self-serve; Mac and iPhone 12 in the app while in stock, iPhone 17 by request" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Its home page says it works with Claude, OpenAI and Gemini models or your own, and its docs list a bring-your-own-key guide; its pricing covers computers, and we did not find model usage described as included" },
            { criterion: "Access method", hivra: "A browser view for the agent, which varies by agent", alternative: "Dashboard, CLI, HTTP API, Python and TypeScript SDKs, MCP, SSH, and HTTP and VNC access to the desktop" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Create a computer from the dashboard, CLI or API, then bring and configure your agent or loop" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "Orgo runs the platform; you manage the agent and software on each computer" },
            { criterion: "Data and security", hivra: "Hivra provisions a computer for your agent; see Hivra's security docs for isolation details", alternative: "Each computer is an isolated VM with its own disk; encrypted secrets, scoped API keys, roles and a trust centre link; certifications were not confirmed" },
            { criterion: "Limits", hivra: "Set by the plan's total CPU and RAM, shared by the agents on it; no per-run or per-minute cap", alternative: "Plan capacity decides how many run at once; up to 50 computers on a paid plan, 999 per account by the hour; API rate limits depend on plan" },
            { criterion: "Fleet and team features", hivra: "Not a fleet product; no public API for creating computers that we know of", alternative: "Templates, workspaces per user, invoicing, roles, embedding, clone and fork" },
            { criterion: "Support", hivra: "Support channel and response times are not published on this page", alternative: "SLA listed for Enterprise only; other support terms not confirmed" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Terms say payments are non-refundable unless the law or something else says otherwise; purchased residential data is not refunded once added" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "SSH with your own key and file endpoints in the API; its pages do not describe a bulk export, and dedicated hosts are Enterprise" },
            { criterion: "Best for", hivra: "A developer who wants an agent's own computer, open and ready", alternative: "A team building computer-use agents or products on many programmable desktops" },
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
            { lead: "Maya, building a computer-use agent that fills in forms on websites with no API:", text: "She needs real desktops that her code creates, watches and discards, and screenshots and clicks as an API. Pick Orgo. Hivra does not offer a programmable desktop fleet." },
            { lead: "Tom, who runs one Claude Code agent on his own side projects:", text: `He wants to open it from a browser in the evening and find his repos and sessions as he left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. He is not writing code to create, stop and reconnect a desktop.` },
            { lead: "Priya, who runs an agent for a few hours each week:", text: "Most of the month it sits idle, and she is comfortable with an API. Pick Orgo by the hour. Paying only for hours of use is likely to cost less than a monthly plan, and a stopped computer is listed at a small hourly rate for its disk." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: "He wants the work to continue when he closes his laptop. Pick Hivra, with one condition on how he starts the run. If he runs Claude Code or Codex, a run he starts inside tmux in the computer's Terminal tab keeps going after he closes the laptop, and on Claude Code, work he sends through Telegram runs on the computer, not in his browser. A run started in the browser chat or the agent's session tab is not certain to continue on every computer. Hermes, OpenClaw and Agent Zero run on the computer itself. On Orgo, a computer runs until stopped, so a scheduled agent can work there too, but he would build and manage it himself." },
            { lead: "Dana, a QA engineer testing a Windows desktop application:", text: "She needs a Windows machine, with a person able to watch it. Pick Orgo, which lists Windows as self-serve, with HTTP and VNC access and the ability to click and type on the screen while the agent works." },
            { lead: "Sam, a founder who would rather not forecast a bill:", text: "A flat figure is easier to approve than hourly rates, a plan plus a Windows licence, credit top-ups and residential data. Pick Hivra, and put model usage on the account or key he already pays for." },
            { lead: "Noor, an agency that gives each client their own agent computers and bills them:", text: "She needs workspaces, per-client keys and invoicing. Pick Orgo, whose docs describe workspaces and clients and invoicing. Hivra has no such reseller layer." },
            { lead: "Leo, who wants both a desktop for tasks and a home for his agent:", text: "Use both. Keep the agent on a Hivra computer. In principle, since Orgo has a public HTTP API, an agent with network access and an Orgo key could create a desktop when it needs one. We have not tested that." },
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
            { lead: "Run it on Orgo.", text: "Orgo's lowest published plan is $29 a month, and its full pricing page mentions $3 of starting credit for a new account that we could not confirm, so budget for credit or a plan. Create a computer from the dashboard or CLI, install or connect your agent, run the task, and note what you pay for while it is stopped." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "Start the Hivra run inside tmux in the Terminal tab (or send it through Telegram on Claude Code), because a browser chat or session-tab run is not certain to continue. In the morning, check which one finished the scheduled work and whether the files, repos and login were where you left them." },
            { lead: "Compare a full month.", text: `Add up the Orgo plan or hourly usage, any licence charge, residential data and credit top-ups, plus model usage on either side. Then compare the total with ${ENTRY_PRICE_PROSE}.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Orgo, the docs say files, installed software and configuration on disk survive stops and restarts, that a new computer is online in seconds and runs until you stop it, and that the API can start, stop, fork, clone and resize computers. The home page also lists suspend and resume with memory saved. You can set an end time in hours, after which the computer is deleted, so a computer with an end time is not meant to last.",
        "Orgo's full pricing page describes a case at the edge of billing: with no plan, a computer's files are kept for one week, after which the computer and its files are deleted if there is still no plan or credit. The same page mentions that a new account can get $3 of starting credit, about 54 running hours of a Medium computer, and we could not confirm who qualifies. Residential IP data does not roll over at month end, and credit expiry is not stated.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, sessions and login. Hivra makes no promise of backups, so keep your own copy of anything you cannot lose, on either platform. Orgo's home page lists a backup feature for Linux and Windows computers, which we could not confirm in its docs or pricing page.`,
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "Orgo home page", href: "https://www.orgo.ai/" },
      { label: "Orgo pricing", href: "https://www.orgo.ai/pricing" },
      { label: "Orgo pricing (full, markdown)", href: "https://www.orgo.ai/pricing.md" },
      { label: "Orgo terms", href: "https://www.orgo.ai/terms" },
      { label: "Orgo docs introduction", href: "https://docs.orgo.ai/introduction" },
      { label: "Orgo docs index", href: "https://docs.orgo.ai/llms.txt" },
    ],
    [
      "Orgo's plan prices, included credit and hourly rates are vendor figures that may change. Its pages disagree about the Small size: the home page lists the 2 vCPU, 8 GB, 40 GB figures against Medium, while one pricing view lists them against Small and its full pricing page lists Small as 0.5 vCPU and 4 GB. We quote the full pricing page.",
      "Not stated on the pages we read: regions, GPU prices, whether credits expire, what the backups listed on its home page cover, a refund policy beyond the terms' non-refundable lines, the notice period for price changes, compliance certifications, support channels outside Enterprise, and which agents beyond those named in its docs it supports.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does Orgo cost?",
      a: `As of ${AS_OF}, Orgo lists monthly plans of $29 for Starter (one Medium computer), $99 for Growth and $399 for Scale, with Enterprise on request, and pay-by-the-hour sizes from $0.023 an hour for Small to $0.202 for XL. Windows adds $15 a month on Starter and Growth. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is Orgo cheaper than Hivra?",
      a: "For a machine that runs a few hours a month, by the hour it can be, because you pay for hours of use. For an always-on agent, Orgo's lowest plan is $29 a month for one 2 vCPU, 8 GB computer, which is a different size from Hivra's entry computer, so compare like for like. Then add model usage on either side, plus any Orgo licence charge and credit top-ups.",
    },
    {
      q: "Can I use Orgo and Hivra together?",
      a: "Yes. They overlap but do different jobs. An agent on a Hivra computer with network access and an Orgo key could in principle create an Orgo desktop through its HTTP API when it needs one, but we have not tested that. You would pay each on its own terms.",
    },
    {
      q: "Does an Orgo computer keep running when I close my laptop?",
      a: "Yes, because it runs in Orgo's cloud. Its home page says there is no time limit and computers run until stopped, unless you set an end time. A stopped computer keeps its disk and is billed at a lower hourly rate.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `On Hivra, ${STAYS_ON} For Claude Code or Codex, a run started inside tmux in the Terminal tab, or Claude Code work sent through Telegram, keeps going after you close the laptop, while a browser chat or session-tab run is not certain to. On Orgo, a plan keeps its always-on capacity running, and hourly computers run until stopped, but you bring and manage the agent.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On Orgo, files, installed software and configuration on disk survive stops and restarts, and the home page lists a backup feature for Linux and Windows computers, which we could not confirm elsewhere. On Hivra, the computer keeps your files, sessions and login, but Hivra makes no promise of backups, so keep your own copy of anything important.",
    },
    {
      q: "Which one is better for running Claude Code or Codex?",
      a: "Both can run them. Orgo's docs say you can run your own agent such as Claude Code or Codex inside a computer, and Hivra hosts both. Choose Orgo if the agent must operate a desktop or you create computers from code, and Hivra if you want to open one computer and leave the agent on it. Hivra is not affiliated with Orgo, Anthropic or OpenAI.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} Orgo's pricing covers computers, and the pages we read do not say model usage is included.`,
    },
    {
      q: "Is there a free way to try each?",
      a: `Orgo's lowest published plan is $29 a month, and its full pricing page mentions $3 of starting credit for a new account that we could not confirm. You can also pay by the hour from credit you add. A Hivra account costs nothing. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} Paid plans come with a ${MONEY_BACK_GUARANTEE}. A free account works with a server you connect yourself.`,
    },
    {
      q: "Does Orgo support Windows, Mac and iPhone?",
      a: "Per its docs, Linux and Windows are self-serve, Mac and iPhone 12 are available in the app while in stock, and iPhone 17 is by request. Hivra's managed computers are Linux, and it offers no Mac or iPhone targets.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-e2b", "vs-fly-sprites", "ai-agent-hosting-alternatives"],
    blog: ["ai-agent-hosting-guide", "cost-of-running-ai-agent"],
    agents: ["claude-code"],
    docs: ["linux-computer"],
    pricing: true,
  }),
};
