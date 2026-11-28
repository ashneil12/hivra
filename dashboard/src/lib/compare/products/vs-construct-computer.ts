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
  slug: "vs-construct-computer",
  browserTitle: "Construct Computer vs Hivra: an agent crew or one computer | Hivra",
  h1: "Construct Computer vs Hivra: a managed crew of agents or a computer of your own",
  metaDescription: `Construct Computer lists an agent crew from $9 a month; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Construct Computer and Hivra both put AI agents on a computer that is not your laptop, but they sell different things. Construct Computer presents itself as a team of AI agents, including a Researcher, an Inbox Manager, an App Builder and an Analyst, that you reach in chat or email, and its homepage says agents check with you before anything goes out. Hivra is a managed computer: you pick a supported agent, Hivra provisions the machine, and you open it in a browser and use it.",
        "So the question is less which one is cheaper and more what you want to own. If you want finished work delivered through chat, email or Slack without ever touching a machine, Construct Computer is built for that. If you want one computer that an agent lives on, with a terminal and files you can open yourself, Hivra is built for that. Construct Computer is not the game engine Construct 3, and we mean the AI product throughout.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `Construct Computer has three priced plans and an Enterprise tier. As of ${AS_OF}, its pricing page lists Lite, Starter and Pro, with usage expressed only as multiples of Lite rather than as a number of tokens or credits: Starter is listed at 6 times Lite's usage and Pro at 32 times. Lite is listed with base model usage, a cap of two agents counting Construct itself, 3 scheduled tasks and 100 MB of storage. Starter is listed with a cap of five agents counting Construct, 10 scheduled tasks and 1 GB of storage. Pro is listed with a cap of fifteen agents counting Construct, 50 scheduled tasks, 3 GB of storage and bring your own keys. All three list a 5 minute command runtime and an email address for the agent. Enterprise has no price and is scoped on a call, with SSO, private deployment and custom MCP mentioned.`,
        "The prices are where we could not get one clean answer. Construct's pricing page shows struck-through figures of $9, $59 and $299 beside $7.50, $39 and $199 a month, with Monthly and Annual billing labels and the lines 2 months free for Lite and 4 months free for Starter and Pro. Pro also reads as a one-week trial, then $2,388 a year, which equals $199 a month. The page does not clearly say which figure belongs to which billing toggle, so our reading, which is an inference, is that $9, $59 and $299 are the month-to-month prices and $7.50, $39 and $199 are the annual rate per month. Separately, Construct's homepage lists Lite at $9 a month, Starter at $49 a month and Pro at $259 a month, with Starter described as Construct plus 9 more agents and Pro as Construct plus 19 more agents, which does not match the other page's $59 and $299 or its agent limits. The homepage also says a yearly plan costs ten months. We cannot tell from the pages which is current, so check Construct before you rely on any one figure.",
        "Construct's plans are priced per tier with a usage allowance expressed as multiples of Lite, and its support page says that when usage runs out the agents stop starting new work until the week or the month renews. Its support page says the remaining usage is shown in Settings under Plan. Its terms say prices and plan limits may change, that you can upgrade, downgrade or cancel at any time from the in-app Billing settings with changes taking effect at the next billing cycle, and that payments are processed through Dodo Payments. A team of three is described on the pricing page as $39 a month for all three on the middle tier, with no per-seat fees.",
        "Bring your own keys is a Pro feature on the pricing page, and Construct's terms say charges made through your own keys with third-party providers are your responsibility and are billed under the provider's terms. The pages do not name the models behind the base usage on any plan.",
        `Hivra charges for a computer rather than for a usage budget: ${ENTRY_PRICE_PROSE}. ${AI_USAGE}`,
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and sets the agent up, and you open it through a browser view for that agent. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "The trade-off is shape. Hivra does not split a request across a named crew of role-based agents or check each outgoing message with you on your behalf; you work with the agent you chose, on the machine it runs on. It also has no built-in phone-call or email-agent channel of the kind Construct lists, so if the point is a team of hires reachable from Slack or by phone, that is not what Hivra offers.",
        "Hivra is independent and is not affiliated with Construct Computer, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A free Hivra account does not include managed compute. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Construct Computer is the better choice when you want the work done and do not want a machine. Its pages describe agents you reach from Discord, Telegram, Slack, email and phone calls, with integrations for Gmail, Slack, Discord, Notion and GitHub and hundreds more. A non-technical person who wants an inbox sorted, a report researched every Monday morning or a small app built, with an approval step before anything is sent or deleted, can use that without opening a terminal. Hivra does not package that experience.",
        "Construct is also better when the entry price matters most. Its lowest listed price is $7.50 to $9 a month depending on billing, which is below Hivra's entry price, and the plan limits above are the caps its pages list. If your work is occasional chat-driven tasks, a small subscription may be all you need.",
        "Teams have more to look at on Construct as well: its homepage lists roles, permissions and shared workflows, and its Enterprise tier mentions SSO and private deployment. This page does not describe a comparable team and permissions surface for Hivra.",
        "Its security page is also unusually specific. It says each workspace runs in its own container that holds no secrets, that stored secrets such as model keys and mailbox passwords are encrypted with AES-256-GCM, that its own AI gateway does not log requests, and that it does not train AI models on your work. It also says plainly that prompt injection is not solved anywhere and that the approval before a send or a delete is what limits the damage. The page says it was checked against Construct's code on November 14, 2026. These are Construct's own statements and we could not verify them independently.",
        "Choose Hivra when you want the agent itself to have a computer that stays on, where files and sessions are there each time you come back, and when you want to work in a terminal and file view rather than only through a chat or email channel.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Construct Computer compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Fixed-price tiers with a usage budget: Lite, Starter, Pro, plus Enterprise by quote. Its homepage and pricing page disagree on amounts, from $7.50 to $9 a month for Lite, as of ${AS_OF}` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "A crew of role-based agents (Researcher, Inbox Manager, App Builder, Analyst and Construct) that take requests in plain language" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "Not stated as CPU or RAM; usage is shown as multiples of Lite (6 times and 32 times on the higher tiers); commands run for 5 minutes at most" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Scheduled jobs run on Construct's own computer with your laptop closed; its security page says an idle computer is shut down and wiped after 10 idle minutes, apart from the workspace folder" },
            { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer", alternative: "Memory of what you teach it, which you can review and edit in Settings; the workspace folder is kept; storage is listed as 100 MB, 1 GB or 3 GB by tier" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "Its own named agents; its pages do not say it runs third-party agents such as Claude Code or Codex" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Base model usage is part of each tier's budget; the models are not named; bring your own keys is listed on Pro and Enterprise" },
            { criterion: "Access method", hivra: "A browser view for the agent, which varies by agent", alternative: "Chat through Discord, Telegram, Slack, email and phone calls; the pages we read do not describe a terminal or desktop" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Sign up, connect the apps each agent may use, and describe the job; no machine to manage" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "Construct runs the platform and the agents; you set what each agent may use and approve outgoing actions" },
            { criterion: "Data and security", hivra: "Your own computer on Hivra Cloud, with files and sessions kept on it", alternative: "Per-workspace container, AES-256-GCM encrypted secrets, no model training on your work per its security page; no SOC 2, ISO 27001 or HIPAA claim on the pages we read" },
            { criterion: "Limits", hivra: "Set by the size of the computer", alternative: "Agent counts, scheduled tasks and storage per tier; agents pause new work when the weekly or monthly usage runs out" },
            { criterion: "Support", hivra: "Support channel and response times are not published on this page", alternative: "Email, Discord and bookable calls; response times are not stated" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Its terms have no refund policy; its support page says to email support, name the payment, and the team reviews it" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "Its support page describes a data export of chats, memory, agents and workflows as one file; its terms state no export right and say workspace files may be deleted on termination" },
            { criterion: "Best for", hivra: "A developer who wants an agent's own computer, open and ready", alternative: "A person or small team who wants delivered work from managed agents through chat and email" },
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
            { lead: "Maya, a founder who wants her inbox triaged and a research summary every Monday:", text: "She does not want to run or understand a machine. Pick Construct Computer. Its Inbox Manager and Researcher roles, scheduled jobs and approval step before anything is sent are aimed at that, and its lowest price is below Hivra's entry price." },
            { lead: "Tom, who runs one Claude Code agent on his own side projects:", text: `He wants to open it from a browser in the evening and find his repos and sessions as he left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. Construct's pages do not describe running Claude Code on it.` },
            { lead: "Priya, a three-person team that wants shared agents without per-seat fees:", text: "The pricing page describes all three sharing one middle-tier subscription at $39 a month with no per-seat fees, and the homepage lists roles and permissions. Pick Construct Computer, after confirming the current price with Construct." },
            { lead: "Jonas, who wants a long agent run on a machine he can open:", text: "He wants a terminal, files and a computer that stays on, and does not want a 5 minute command limit or an idle wipe. Pick Hivra, where the computer stays on. On Construct, its security page says an idle computer is wiped after 10 idle minutes apart from its workspace folder, and commands are capped at 5 minutes each." },
            { lead: "Dana, a security lead who needs documented controls to read before buying:", text: "She will want to read how a vendor isolates workspaces and handles keys. Construct publishes a specific security page and a sub-processor list. Start there, then ask both vendors about the certifications you require, since we found no compliance certification stated on the Construct pages we read." },
            { lead: "Sam, a founder who would rather not watch a usage budget:", text: "On Construct, agents stop starting new work when the plan's weekly or monthly usage runs out. A flat figure is easier to approve. Pick Hivra, and put model usage on the account or key he already pays for." },
            { lead: "Leo, who wants a chat-driven crew and a home for his own agent:", text: "Use both. Let Construct handle the inbox and research jobs through chat, and keep the agent he configures himself on a Hivra computer. Each is paid for on its own terms." },
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
            { lead: "Pick one real task.", text: "Use something you actually need done, such as a weekly research summary or a repo kept up to date, so both runs do the same work." },
            { lead: "Run it on Construct Computer.", text: "Its homepage says every new account can try it free first, though the length of that trial is not stated, and its pricing page mentions a one-week trial on Pro. Confirm what applies to you. Describe the job in chat, connect only the apps it needs, and note what it asks you to approve." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "In the morning, check which one finished the scheduled work and whether the memory, files and sessions were where you left them." },
            { lead: "Compare a full month.", text: `Add up the Construct plan price you are actually billed, plus any model usage on your own keys, against ${ENTRY_PRICE_PROSE}.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Construct Computer, the security page says each workspace has a database of its own and each chat has another, and that a workspace computer is shut down and wiped after 10 idle minutes, apart from its workspace folder. Its homepage says it remembers what you teach it so each job goes better, and its support page says you can review, edit or remove any stored fact in Settings under Memory, or turn off learning from your chats.",
        "Scheduled jobs are described as running on Construct's own computer with your laptop closed. The pages do not say how long a single job may run beyond the 5 minute cap on each command, nor what happens to a job that is mid-run when a computer is wiped. Its support page also says a bigger plan starts right away and a cancelled plan runs until the paid period ends.",
        "For leaving, its support page describes an export of chats, memory, agents and workflows as one file, and a permanent account deletion that also removes files and app connections. Its security page says deleting an account stops every workspace and erases its chats, memory and files, while payment records are kept for tax. Its terms, read separately, state no export right and say your sandbox container, files, memory and chat history may be deleted on termination.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, sessions and login. Hivra does not promise backups, so keep your own copy of anything you cannot lose, on either platform.`,
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "Construct Computer homepage", href: "https://construct.computer/" },
      { label: "Construct Computer pricing", href: "https://construct.computer/pricing/" },
      { label: "Construct Computer security", href: "https://construct.computer/security/" },
      { label: "Construct Computer terms", href: "https://construct.computer/terms/" },
      { label: "Construct Computer support", href: "https://construct.computer/support/" },
    ],
    [
      "Construct Computer's plan prices, agent counts and limits are vendor figures that may change. Its homepage ($9, $49 and $259 a month; Construct plus 2, 9 and 19 more agents) and its pricing page ($9, $59 and $299, struck through, beside $7.50, $39 and $199 a month; up to 2, 5 and 15 agents including Construct) disagree. Which pricing figure belongs to monthly or annual billing is our inference.",
      "Not stated on the pages we read: the models behind base usage, the length of the trial for new accounts, answers to the pricing page's own FAQ, a documentation page (the /docs address did not load), CPU and RAM of an agent's computer, regions beyond its statement that it runs on Cloudflare, compliance certifications, a refund policy in the terms, support response times, and whether it can run third-party agents such as Claude Code or Codex.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does Construct Computer cost?",
      a: `As of ${AS_OF}, its pricing page lists Lite, Starter and Pro with struck-through figures of $9, $59 and $299 beside $7.50, $39 and $199 a month, and Enterprise by quote, while its homepage lists $9, $49 and $259 a month. The pages disagree, so confirm with Construct. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is Construct Computer cheaper than Hivra?",
      a: "At its lowest listed price, yes, but they are different products. Construct's tiers are budgets of usage for a managed crew of agents, while Hivra is a computer you open. Compare what you would actually run for a full month, including any model usage on your own keys.",
    },
    {
      q: "Can I use Construct Computer and Hivra together?",
      a: "Yes. They do different jobs. You can use Construct for chat-driven inbox and research work and keep an agent of your own on a Hivra computer, and you pay each on its own terms.",
    },
    {
      q: "Does Construct Computer keep running when I close my laptop?",
      a: "Yes for scheduled jobs. Its homepage says jobs run on Construct's own computer with your laptop closed. Its security page says an idle computer is shut down and wiped after 10 idle minutes, apart from the workspace folder, and that commands run for five minutes each at most.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `On Hivra, ${STAYS_ON} On Construct, you schedule jobs and its agents work in bursts within a usage budget; the pages do not describe a computer you leave running, and they say agents stop starting new work when the budget is used up until it renews.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On Construct, memory and the workspace folder are kept, you can export chats, memory, agents and workflows as one file per its support page, and deleting your account erases chats, memory and files. On Hivra, the computer keeps your files, sessions and login, but Hivra does not promise backups, so keep your own copy of anything important.",
    },
    {
      q: "Which one is better for running Claude Code?",
      a: "Hivra, if you want to run Claude Code itself: it hosts it, and you open the computer. Construct's pages describe its own agents and do not say it runs Claude Code. Hivra is not affiliated with Construct Computer or Anthropic.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} Construct's tiers include a usage budget, with base model usage on Lite, and bring your own keys is listed on Pro, so the two bill AI differently.`,
    },
    {
      q: "Is there a free way to try each?",
      a: `Construct's homepage says every new account can try it free first, without a stated length, and its pricing page mentions a one-week trial on Pro, so confirm the terms with Construct. A Hivra account costs nothing. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} Paid plans come with a ${MONEY_BACK_GUARANTEE}. A free account works with a server you connect yourself.`,
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
