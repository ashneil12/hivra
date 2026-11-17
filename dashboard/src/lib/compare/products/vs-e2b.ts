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
  slug: "vs-e2b",
  browserTitle: "E2B sandboxes vs Hivra: a sandbox API or a computer to open | Hivra",
  h1: "E2B sandboxes vs Hivra: an API for sandboxes or a computer to open",
  metaDescription: `E2B is a sandbox API from $150 a month plus usage; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "E2B and Hivra both give an AI agent a Linux machine that is not your laptop, but they are built for different people. E2B is an API: its docs describe a sandbox as a fast, secure Linux VM created on demand for your agent, which you create from a JavaScript, TypeScript or Python SDK and can pause and resume. Hivra is a managed computer: you pick a supported agent, Hivra provisions the machine, and you open it in a browser and use it.",
        "So the question is less which one is cheaper and more who is meant to drive. If your own code creates sandboxes, hands them to an agent and tears them down, E2B is built for that. If a person wants one computer that an agent lives on, that is there each time they come back, Hivra is built for that.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `E2B has three plans. As of ${AS_OF}, E2B lists Hobby at no charge with a one-time $100 usage credit, sessions of up to 1 hour and 10 concurrent sandboxes; Pro at $150 a month plus usage, billed per second, with sessions of up to 24 hours and 100 concurrent sandboxes; and Enterprise from a $2,000 a month commitment, with 500 concurrent sandboxes per E2B (its rate-limits documentation lists 1,100 or more), multi-day and persistent sessions and custom sizes. Its pages do not say whether the Hobby credit expires.`,
        "Usage is metered by the second. The page lists $0.000014 per second for each vCPU, so a 2 vCPU sandbox is $0.000028 per second and a 4 vCPU one is $0.000056. Memory is listed at $0.0000180 per second for 4 GiB and $0.0000360 for 8 GiB. Disk is included: 10 GiB on Hobby and 20 GiB on Pro.",
        `As our own arithmetic from those rates, a 2 vCPU sandbox with 4 GiB of memory comes to about $0.17 for each hour it runs, or about $121 across a 730-hour month, before the $150 Pro base fee. That is about $271 a month for one always-on 2 vCPU, 4 GiB sandbox on Pro at list rates, against ${ENTRY_PRICE_PROSE} for Hivra. Because E2B can pause an idle sandbox, a bursty workload costs far less. E2B's own example on the page is $166 of usage plus the $150 base for $316 a month at up to 100 concurrent sandboxes, though the inputs behind that example are not stated. Real figures depend on how many sandboxes you run and for how long.`,
        "Concurrency can cost more: the pricing page lists add-ons of 600 concurrent sandboxes for $500 a month and 1,100 for $1,000 a month on Pro. E2B's terms describe charges as non-cancellable and non-refundable, say it may add or increase fees with at least 30 days notice, and charge late payments 1.5% a month (or the legal maximum if lower). Cancellation is by emailing support, with fees due through termination.",
        `Hivra charges for a computer rather than for sandboxes: ${ENTRY_PRICE_PROSE}. ${AI_USAGE}`,
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and sets the agent up, and you open it through a browser view for that agent. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "The trade-off is cost. It is a flat fee even in a month when the agent does little, so a bursty workload can be cheaper on E2B, and Hivra is not a place to create hundreds of throwaway environments from code.",
        "Hivra is independent and is not affiliated with E2B, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A Hivra account costs nothing, but every Hivra Cloud computer is a paid plan. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "E2B is the better choice when you are building a product on top of sandboxes. If your backend needs to create environments from code, run untrusted or generated code in isolation, start many of them at once and shut them down when the work ends, E2B has the SDKs, templates and concurrency limits for exactly that. Hivra has none of that surface and is not meant to.",
        "E2B is also better when the work is spiky. Billing by the second means a short-lived sandbox costs only for the seconds it runs, and the Hobby plan lets you try the API without paying. Its pages also describe things Hivra does not offer: pause and resume that keeps memory and running processes, templates whose start command is already running when a sandbox starts, and compliance statements (SOC 2 and HIPAA, per its pricing page) for teams that need them.",
        "If you need to host the sandbox infrastructure yourself, E2B publishes its infra repository under Apache-2.0 with a self-hosting guide, and offers BYOC on AWS, GCP and Azure for Enterprise customers. Hivra can host the computer for you or connect a server you run, but it is not a sandbox platform.",
        "Choose Hivra when you want the agent itself to have a place to live, without writing the code that creates, pauses and reconnects it, and when a fixed monthly figure matters more than the lowest possible bill.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and E2B sandboxes compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Hobby at no charge with a one-time $100 credit; Pro $150/mo plus per-second usage; Enterprise from $2,000/mo, as of ${AS_OF}` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "Sandboxes (Linux VMs) created on demand from an SDK, plus templates" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "Billed per vCPU and GiB per second; Hobby uses default sizes, Pro allows custom CPU and RAM" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Runs up to 1 hour on Hobby or 24 hours on Pro; by default it is killed at timeout, or can be set to pause" },
            { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer", alternative: "A paused sandbox keeps filesystem and memory, and is kept until you kill it, per its docs; a sandbox killed at timeout is gone, and paused sandboxes are unreachable until resumed" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "Its docs list goose, OpenCode and Claude Code with ready templates; other ACP agents once installed in a custom template; Codex is not listed there" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Billed for compute; you supply model keys such as ANTHROPIC_API_KEY for Claude Code" },
            { criterion: "Access method", hivra: "A browser view for the agent, which varies by agent", alternative: "JavaScript, TypeScript and Python SDKs with an API key; its docs overview does not mention a browser terminal or IDE" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Write code against the SDK, build or pick a template, and handle timeouts and reconnects" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "E2B runs the platform; you manage templates and what runs inside each sandbox" },
            { criterion: "Data and security", hivra: "Your own computer on Hivra Cloud, with files and sessions kept on it", alternative: "Isolated VMs; outbound internet on by default and can be disabled or filtered; its pricing page states SOC 2 and HIPAA compliance" },
            { criterion: "Limits", hivra: "Set by the size of the computer", alternative: "Concurrent sandboxes capped at 10 on Hobby and at 100 for Pro, expandable with paid add-ons; creation rate of 1 a second on Hobby and 5 a second on Pro" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Terms call charges non-cancellable and non-refundable; Hobby needs no payment, so there is nothing to refund there; cancellation is by emailing support" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "Apache-2.0 infra repository with a self-hosting guide (GCP supported, AWS in beta per its README); BYOC for Enterprise" },
            { criterion: "Best for", hivra: "A developer who wants an agent's own computer, open and ready", alternative: "A team that creates sandboxes from code, often short-lived, at scale" },
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
            { lead: "Maya, building a data tool that runs generated code for each user request:", text: "She needs a clean, isolated environment per request, created and killed from her backend. Pick E2B. The SDK, templates and per-second billing fit that shape, and a flat monthly computer does not." },
            { lead: "Tom, who runs one Claude Code agent on his own side projects:", text: `He wants to open it from a browser in the evening and find his repos and sessions as he left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. He is not writing code to create and reconnect a sandbox.` },
            { lead: "Priya, who wants to try an agent API without paying first:", text: "She is comfortable with Python and wants to prototype. Pick E2B. The Hobby plan has no charge and a one-time usage credit, so she can try it before deciding." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: "He wants a scheduled job on a computer that stays on, so it is there each morning. Pick Hivra, where the computer stays on; E2B can pause and resume, and Enterprise offers persistent sessions, but on Hobby or Pro he would set a timeout policy and reconnect, as sessions are capped at 1 hour and 24 hours." },
            { lead: "Dana, a platform engineer whose company requires compliance reports and its own cloud:", text: "She needs a vendor with stated certifications and a bring-your-own-infrastructure path. Pick E2B. Its pricing page states SOC 2 and HIPAA compliance, and BYOC is offered to Enterprise customers." },
            { lead: "Sam, a founder who would rather not forecast a bill:", text: "A flat figure is easier to approve than a base fee plus per-second usage and optional concurrency add-ons. Pick Hivra, and put model usage on the account or key he already pays for." },
            { lead: "Leo, who wants both a sandbox API and a home for his agent:", text: "Use both. Keep the agent on a Hivra computer, and have it call E2B when it must run untrusted generated code in a clean, disposable sandbox." },
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
            { lead: "Run it on E2B.", text: "Sign up for the Hobby plan, install the SDK, create a sandbox from a template and run the task. Note how you handle the session limit, and whether you pause or kill the sandbox at timeout." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "In the morning, check which one finished the scheduled work and whether the agent's session, files and login were where you left them." },
            { lead: "Compare a full month.", text: `Add up the E2B usage and any Pro base fee, plus model usage on either side, against ${ENTRY_PRICE_PROSE}.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On E2B, the persistence docs say that pausing a sandbox saves both its filesystem and its memory, and that paused sandboxes are kept indefinitely until you kill them. Running processes and loaded variables are preserved on resume. A filesystem-only pause is also possible, and it reboots on resume. The docs give about 4 seconds per GiB of RAM to pause and about 1 second to resume. Services in a paused sandbox are unreachable, so clients must reconnect.",
        "A running sandbox has a session limit. Sandboxes can run continuously for up to 24 hours on Pro or 1 hour on Hobby, and pausing and resuming resets that window. The onTimeout setting defaults to kill, so a sandbox is deleted at timeout unless you set it to pause. Connecting to a sandbox extends its lifetime, by default by 5 minutes. The pages we read do not state a default timeout value, since the examples set 60 seconds explicitly.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, sessions and login. Hivra makes no promise of backups, so keep your own copy of anything you cannot lose, on either platform.`,
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "E2B pricing", href: "https://e2b.dev/pricing" },
      { label: "E2B docs home", href: "https://docs.e2b.dev/" },
      { label: "E2B sandbox docs", href: "https://docs.e2b.dev/docs/sandbox" },
      { label: "E2B persistence docs", href: "https://docs.e2b.dev/docs/sandbox/persistence" },
      { label: "E2B rate limits", href: "https://docs.e2b.dev/docs/sandbox/rate-limits" },
      { label: "E2B templates quickstart", href: "https://docs.e2b.dev/docs/template/quickstart" },
      { label: "E2B ACP agents", href: "https://docs.e2b.dev/agents/acp.md" },
      { label: "E2B BYOC", href: "https://docs.e2b.dev/docs/byoc" },
      { label: "E2B internet access", href: "https://docs.e2b.dev/docs/sandbox/internet-access" },
      { label: "E2B terms", href: "https://e2b.dev/terms" },
      { label: "E2B infra repository (self-hosting)", href: "https://github.com/e2b-dev/infra" },
    ],
    [
      "E2B's Hobby credit and plan limits are vendor offers that may change. The $316 a month figure is E2B's own example, and the inputs behind it are not stated.",
      "Not stated on the pages we read: regions for the hosted service, a refund policy beyond the terms' non-refundable line, a default sandbox timeout, which base images templates can use, Codex support, a browser terminal or IDE, data retention periods, and the default CPU and RAM behind the Hobby plan. Self-hosting is described on its infra repository as supported on GCP, with AWS marked beta.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does E2B cost?",
      a: `As of ${AS_OF}, E2B lists a Hobby plan at no charge with a one-time $100 usage credit, Pro at $150 a month plus per-second usage, and Enterprise from $2,000 a month. Compute is listed at $0.000014 per second for each vCPU. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is E2B cheaper than Hivra?",
      a: "For short, bursty sandboxes on the Hobby plan, it can be, because you pay by the second. For an agent that runs all day on Pro, the $150 base fee plus usage adds up, and a flat monthly price is easier to predict. Run your own workload and compare a full month.",
    },
    {
      q: "Can I use E2B and Hivra together?",
      a: "Yes. They do different jobs. An agent on a Hivra computer can call E2B when it needs a clean, disposable environment, and you pay each on its own terms.",
    },
    {
      q: "Does an E2B sandbox keep running when I close my laptop?",
      a: "Yes, for as long as its session allows, because it runs in E2B's cloud. Sessions are capped at 1 hour on Hobby and 24 hours on Pro, and by default a sandbox is killed at timeout unless you set it to pause. A paused sandbox keeps its filesystem and memory.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `On Hivra, ${STAYS_ON} On E2B you design for it with timeouts, pauses and reconnects, since Pro sessions last up to 24 hours before they need pausing and resuming, or an Enterprise plan with persistent sessions.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On E2B, a paused sandbox keeps its filesystem and memory until you kill it, but a sandbox killed at timeout is gone. On Hivra, the computer keeps your files, sessions and login, but Hivra makes no promise of backups, so keep your own copy of anything important.",
    },
    {
      q: "Which one is better for running Claude Code?",
      a: "Both can run it. E2B's docs list Claude Code with a ready template that needs an Anthropic API key, and Hivra hosts it too. E2B suits driving it from code; Hivra suits opening one computer and leaving the agent on it. Hivra is not affiliated with E2B or Anthropic.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} E2B's pricing covers compute, and its pages do not say model usage is included.`,
    },
    {
      q: "Is there a free way to try each?",
      a: "E2B's Hobby plan is listed at no charge with a one-time $100 usage credit. A Hivra account costs nothing, but every Hivra Cloud computer is paid, with a 7-day money-back guarantee on card payments. A free account works with a server you connect yourself.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-fly-sprites", "ai-agent-hosting-alternatives", "vs-railway"],
    blog: ["ai-agent-hosting-guide", "cost-of-running-ai-agent"],
    agents: ["claude-code"],
    docs: ["linux-sandbox"],
    pricing: true,
  }),
};
