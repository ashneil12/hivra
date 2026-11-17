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
  slug: "vs-simular-box",
  browserTitle: "Simular box vs Hivra: a cloud desktop or an agent computer | Hivra",
  h1: "Simular box vs Hivra: a cloud desktop your AI drives or a computer your agent lives on",
  metaDescription: `Simular box is a cloud Linux desktop at $19 a month; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Simular box and Hivra both give an AI a cloud computer that is not your laptop, but they start from opposite ends. Simular's own pages describe box as a cloud Linux desktop for AI: an Ubuntu desktop with Chrome and a shell that your existing AI drives over MCP, the Model Context Protocol. You add one hosted MCP server to the assistant you already use, and that assistant can open a browser, click, type, read the screen and run commands on the box. Hivra is a managed agent computer: you pick a supported agent, Hivra provisions the machine and installs the agent, and you open the computer in a browser and work with it.",
        "So the question is less which one is cheaper and more where the agent lives. With box, the agent is the assistant you already have (Claude, ChatGPT, Claude Code, Codex, Cursor and others, per Simular's pages), and box is a screen and a shell it borrows. With Hivra, the agent is installed on the computer itself and the computer is its home. Both are legitimate designs, and which one fits depends on whether you want a tool for an assistant or a place for an agent.",
        `This page compares the two from each side's own published information. We collected Simular's figures from its own pages in ${AS_OF}. Where a page did not say something, we say so instead of guessing, and the list of unconfirmed points is near the end.`,
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `Simular box lists a Free option and two paid plans. As of ${AS_OF}, its page lists Free as 5,000 credits once, which it describes as about 50 box-hours, valid for 90 days; S at $19 a month with 5,000 credits each month, where the box sleeps when idle; and M at $39 a month with 10,000 credits each month, where the box does not sleep. The page also says annual billing gives 2 months free. It does not say what the annual price comes to in dollars, so we have not worked it out for you.`,
        "Credits are the unit behind everything else. The page states that 1,000 credits equal $1. The Free box uses 100 credits an hour, extra boxes start at 100 credits an hour, and a residential IP on paid plans costs 10,000 credits per GB. Box credits also cover box's own model calls. By Simular's description, your own AI keeps using its own plan, so the assistant that drives the box is a separate bill from the box.",
        "As our own arithmetic from those listed rates, 100 credits an hour is $0.10 an hour. An extra box kept running for a 730-hour month would come to about $73 at the starting rate, and the 5,000 monthly credits in plan S are worth $5. We do not know from the pages we read how a paid plan's own box is metered, whether the starting rate for extra boxes rises with size, or what happens when the monthly credits run out beyond the note that you can add credits or pick a plan on the Billing page. Real figures depend on how often your AI connects and for how long.",
        `Hivra charges for a computer rather than for credits: ${ENTRY_PRICE_PROSE}. ${AI_USAGE}`,
        "On the sleep rule, the two plans differ in a way that matters for always-on work. Simular's page says the box sleeps when nobody is using it, except on plan M, where it stays awake, and that it wakes when your AI connects. It also says a box that stays asleep for 14 days in a row is deleted, along with its files and saves, and that any wake resets the count. That is a clear, published rule, and worth reading before you store anything you care about on plan S.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and runs the agent's own installer, and you work through a browser view with the agent's chat, a terminal and files, which vary by agent. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "That has a price: it is a flat fee even in a month when the agent does little. Hivra is also not a way to hand your existing Claude or ChatGPT chat a screen to drive. The agent runs on the Hivra computer, and you open it there, rather than attaching a hosted desktop to an assistant elsewhere.",
        "Hivra is independent and is not affiliated with Simular, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A Hivra account costs nothing, but every Hivra Cloud computer is a paid plan. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Simular box is the better choice when you want your current assistant to gain a computer without changing where it runs. If you already pay for Claude or ChatGPT and want that assistant to use a real browser, click through a site that has no API and run a command, adding one MCP server is a short path. Simular's pages list sign-in through OAuth with your Simular account, so no key is needed, and a personal key for apps that cannot sign in. Hivra has no equivalent of attaching a desktop to an assistant you use somewhere else.",
        "Box is also better at graphical work. It is a desktop, with a browser the AI can see and a live view you can watch at box.simular.ai/box and take control of when needed. The docs describe a live view you can watch and a Take control option. If the job is to watch an AI work through a website and step in, that is what box is for.",
        "It is better when the work is occasional. A Free option with a one-time credit allowance and a $19 plan S mean a person who needs a computer for an AI a few hours a month can pay less than a flat monthly computer, and the box sleeps when idle. Simular's docs also describe a secrets feature in which a key you paste once is stored encrypted and swapped in by box only when a command sends it to a host on the key's list, so commands can use your keys without the AI seeing them. We did not find an equivalent description in Hivra's materials for that exact design, so if that matters to you, weigh it.",
        "And it is better if you want its vendor's wider ecosystem: Simular also lists Sai, an agent product, the Simular API and the open-source Agent S framework, and claims the number one place on the OSWorld benchmark on its company site. We cannot verify that claim, and Simular's page labels the results both OSWorld 2.1 and 2.0, so treat it as the vendor's statement.",
        "Choose Hivra when you want the agent itself to live somewhere without you attaching it to an assistant, and when a fixed monthly figure matters more than the lowest possible bill.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Simular box compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Free: 5,000 credits once for 90 days; S $19/mo with 5,000 credits; M $39/mo with 10,000 credits; 1,000 credits equal $1, as of ${AS_OF}` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "A cloud Ubuntu desktop with Chrome and a shell, driven by your AI over one hosted MCP server" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "CPU, memory and storage are not listed on the pages we read" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Sleeps when idle on plan S and the Free option; plan M does not sleep; wakes when your AI connects" },
            { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer", alternative: "A box asleep for 14 days in a row is deleted with its files and saves; any wake resets the count" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "Any MCP client; listed: Claude, ChatGPT, Claude Code, Codex, Cursor, OpenCode, Hermes, OpenClaw, VS Code, DeepSeek Harness" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Your AI keeps its own plan; box credits cover box's own model calls, extra boxes and residential IP" },
            { criterion: "Access method", hivra: "A browser view for the agent, which varies by agent", alternative: "MCP over OAuth or a personal key; a live view at box.simular.ai/box with Take control" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Add the MCP server, or run its connect command for coding agents on your own computer" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "Simular runs the box; its docs say older boxes need updating from Settings to get newer features such as secrets" },
            { criterion: "Data and security", hivra: "Your own computer on Hivra Cloud, with files and sessions kept on it", alternative: "OAuth sign-in; secrets stored encrypted and swapped in only for listed hosts; no isolation, encryption or compliance statement found on the pages we read" },
            { criterion: "Limits", hivra: "Set by the size of the computer", alternative: "Credit-based; session time limits and quotas not stated on the pages we read" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "No refund or cancellation terms found on the pages we read" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "Hosted service; no self-hosting or export route found on the pages we read" },
            { criterion: "Maturity", hivra: "Paid Hivra Cloud computers", alternative: "Labelled Beta on Simular's company site" },
            { criterion: "Best for", hivra: "A developer who wants an agent's own computer, open and ready", alternative: "Someone who wants their existing assistant to use a desktop and a browser" },
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
            { lead: "Nadia, who pays for Claude and wants it to operate a website with no API:", text: "She wants her assistant to open a browser, click and type while she watches. Pick Simular box. Adding the MCP server gives her existing assistant a desktop and a live view, and she does not need to move her agent anywhere." },
            { lead: "Tom, who runs one Claude Code agent on his own side projects:", text: `He wants to open it from a browser in the evening and find his repos and sessions as he left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. He is not attaching a desktop to an assistant, he wants the agent to live somewhere.` },
            { lead: "Priya, who wants to try a cloud computer for an AI with little commitment:", text: "She needs an hour or two a week. Pick Simular box. The Free option lists a one-time credit allowance, and plan S at $19 a month is a small step up, and the box sleeps when idle." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: `He wants a scheduled job on a computer that stays on. Pick Hivra, where ${STAYS_ON.toLowerCase()} Simular's plan M also does not sleep, at $39 a month, so compare that against ${ENTRY_PRICE_PROSE} and check whether the work runs from your AI or from the box itself.` },
            { lead: "Dana, who needs the AI to use a company API key it must not see:", text: "She cannot paste a key into the chat. Pick Simular box for this specific need, since its secrets guide describes a stand-in variable that box swaps for the real key only when a command sends it to a host on the key's list." },
            { lead: "Sam, a founder who would rather not forecast a bill:", text: "A flat figure is easier to approve than credits with a conversion rate and separate rates for extra boxes and residential IP. Pick Hivra, and put model usage on the account or key he already pays for." },
            { lead: "Leo, who wants both a graphical desktop and a home for his agent:", text: "Use both. Keep the agent on a Hivra computer, and attach box when a task needs a real browser session that a person can watch and take over." },
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
            { lead: "Pick one real task.", text: "Use something your agent already does, such as a scheduled report or a site it keeps up to date, so both runs do the same work." },
            { lead: "Run it on Simular box.", text: "Sign in with your Simular account and add the box MCP server to your assistant. Run the task and note how much of the Free allowance it used, using the 100 credits an hour rate on the page." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone for a week.", text: "Check which one still has your files, whether the box went to sleep and woke when your AI connected, and where the agent's session and login were left." },
            { lead: "Compare a full month.", text: `Add up the box plan and any extra credits, plus the model usage on your AI plan, against ${ENTRY_PRICE_PROSE} plus model usage on the Hivra side.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Simular box, the published rule is about sleep and deletion. The box sleeps when no one uses it, except on plan M, where it stays awake, and wakes when your AI connects. A box that stays asleep for 14 days in a row is deleted, with its files and saves, and any wake resets the count. The pages we read do not say whether a box that is awake keeps programs running when your AI disconnects, how long a session can last, or whether there is any export of files before deletion.",
        "The docs also list a headless agents guide, for running agents such as codex exec and claude -p with no one at the keyboard. That page did not load for us, so we cannot say how it works. The troubleshooting page says access lasts the days chosen on the approval page, with no default or maximum given, so a signed-out AI may need to sign in again.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, sessions and login. Hivra does not promise backups, so keep your own copy of anything you cannot lose, on either platform.`,
      ),
    },
    {
      heading: "Security and secrets",
      blocks: paragraphs(
        "Simular's secrets guide is the most detailed security material we found. You paste a key once at box.simular.ai/secrets, and box stores it encrypted, with nobody able to read it back, including the page and your AI. You enter the variable name programs read, up to 8 hosts the key may be sent to, and how the site expects the key, in a header or in the URL. The box variable holds a stand-in containing cbv_, and when a command sends the stand-in to a listed host, box substitutes the real key. To any other host, the stand-in is useless.",
        "The guide also lists limits. Commands run through the shell tool and the box terminal receive secrets, while scripts run with script_run do not. A terminal opened before a key was added does not have it. Older boxes send the stand-in unchanged until updated, and boxes an AI creates with box_create receive none of your secrets. A site that accepts one key in two formats needs two secrets.",
        "Beyond that, the home page and introduction make no statement we could find about isolation, encryption of the desktop itself, certifications or where boxes run. An AI that can click and type on a desktop can also take actions you did not intend, on any platform, so review what the assistant is allowed to do, whichever product you pick.",
        "On the Hivra side, the computer is yours on Hivra Cloud, or a server you connect yourself, and the agent runs with the access you give it. Read Hivra's security and access documentation for the details rather than relying on a comparison table.",
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "Simular box home page and pricing", href: "https://box.simular.ai/" },
      { label: "Simular box docs introduction", href: "https://box.simular.ai/docs" },
      { label: "Simular box secrets guide", href: "https://box.simular.ai/docs/secrets" },
      { label: "Simular box troubleshooting", href: "https://box.simular.ai/docs/troubleshooting" },
      { label: "Simular company site", href: "https://www.simular.ai/" },
    ],
    [
      "Simular's Free allowance and plan prices are vendor offers that may change. Box is labelled Beta on Simular's company site (www.simular.ai), so details may move faster than usual.",
      "Not confirmed on the pages we read: a separate pricing page (box.simular.ai/pricing did not load), CPU, memory and storage, the Ubuntu version, regions, session time limits, quotas, a refund or cancellation policy, terms of service (www.simular.ai/terms did not load), the dollar price of annual billing, the metering of plan boxes versus extra boxes, the headless agents guide, isolation and compliance statements, and any self-hosting or file export route. The OSWorld ranking is Simular's own claim, and its page labels the result both 2.1 and 2.0.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does Simular box cost?",
      a: `As of ${AS_OF}, Simular's page lists Free as 5,000 credits once, valid for 90 days, S at $19 a month with 5,000 credits a month, and M at $39 a month with 10,000 credits a month, where the box does not sleep. 1,000 credits equal $1. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is Simular box cheaper than Hivra?",
      a: "For occasional use, it can be, because the Free option and a $19 plan are small and the box sleeps when idle. For an always-on computer, plan M is $39 a month and extra boxes start at 100 credits an hour, which is about $73 across a 730-hour month by our arithmetic. Compare a full month of your own use.",
    },
    {
      q: "Can I use Simular box and Hivra together?",
      a: "Yes. They do different jobs. An agent on a Hivra computer can use a box when it needs a graphical browser session you can watch, if that agent can use an MCP server. Each is billed on its own terms.",
    },
    {
      q: "Does Simular box keep running when I close my laptop?",
      a: "Simular describes box as a cloud computer, so it keeps running when your own computer is closed. The box runs in Simular's cloud and wakes when your AI connects, and it sleeps when idle on plan S. The pages we read do not give a session time limit.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `On Hivra, ${STAYS_ON} On Simular box, plan M is the one that does not sleep, per its page. We could not confirm session limits or what runs while your AI is disconnected.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On Simular box, a box that stays asleep for 14 days in a row is deleted with its files and saves, and any wake resets the count. On Hivra, the computer keeps your files, sessions and login, but Hivra does not promise backups, so keep your own copy of anything important.",
    },
    {
      q: "Which one is better for running Claude Code?",
      a: "Both can work with it. Simular lists Claude Code as an MCP client and offers a connect command for it, so Claude Code on your own computer can use a box. Hivra hosts Claude Code on its own computer. Hivra is not affiliated with Simular or Anthropic.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} On Simular box, your AI keeps its own plan, and box credits cover box's own model calls, extra boxes and residential IP.`,
    },
    {
      q: "Is there a way to try each without paying?",
      a: `Simular lists a Free option of 5,000 credits once, about 50 box-hours, valid for 90 days. A Hivra account costs nothing, but every Hivra Cloud computer is paid, with a ${MONEY_BACK_GUARANTEE}. A free account works with a server you connect yourself.`,
    },
    {
      q: "Is Simular box still in beta?",
      a: "Simular's company site (www.simular.ai) labels Box as Beta; the box.simular.ai page we read did not repeat the label. We did not find a general availability date, so check its pages for the current status before you rely on it for important work.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-e2b", "vs-fly-sprites", "ai-agent-hosting-alternatives"],
    blog: ["ai-agent-hosting-guide", "cost-of-running-ai-agent"],
    agents: ["claude-code"],
    docs: ["linux-sandbox"],
    pricing: true,
  }),
};
