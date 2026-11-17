import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
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
  slug: "vs-cubicles",
  browserTitle: "Cubicles vs Hivra: a cloud desktop or a managed agent computer | Hivra",
  h1: "Cubicles vs Hivra: a full cloud desktop for your agent or a managed agent computer",
  metaDescription: `Cubicles sells Ubuntu agent desktops from $24 a month; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Cubicles and Hivra both give an AI agent a computer in the cloud that is not your laptop, and both are opened from a browser. They differ in what that computer is. Cubicles describes each computer as a full Ubuntu desktop, with Chrome, Firefox, VS Code, a terminal and any app you install, so an agent can use applications the way a person does and you can watch it work. Hivra is a managed agent computer: you pick a supported agent, Hivra provisions the machine and sets the agent up, and you work through a browser view built around that agent.",
        "So the question is less which one is cheaper and more what the agent needs to do. If it has to drive graphical applications, sign in to websites in a real browser, or be watched on a screen, a desktop is the more direct fit. If you want a supported agent installed and managed for you, with a flat plan sized for it, Hivra is built for that. Cubicles is also young: its own pages describe a beta, and several of its facts changed between the pages we read, which we flag below.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `As of ${AS_OF}, Cubicles lists three computer sizes on its home page, each as a monthly subscription before tax. Standard is $24 a month for 4 vCPU, 8 GB of memory, 64 GB of NVMe storage and up to 1 Gbps with unmetered bandwidth. Pro is $48 a month for 8 vCPU, 16 GB of memory and 128 GB of storage, and Studio is $72 a month for 12 vCPU, 24 GB of memory and 192 GB of storage. At the time we read the pages, the two larger sizes were marked sold out.`,
        "The free offer is described two ways. Its home page says the first computer is free: every account can have one free Standard computer, without adding payment details, while there is room on the servers that host them. Its separate plans page says every computer is free while Cubicles is in beta, and shows $24, $48 and $72 as the future prices. Its API documentation also marks one desktop per account as free, with nothing billed. We cannot tell from its pages how long the free offer lasts or what the price will be when beta ends, so treat the $24 figure as the one to plan around and confirm before you rely on a free computer.",
        "Cubicles says each paid computer is charged on the day you create it and the same day each month after, with sales tax or VAT added when you pay by Paddle, which it calls its reseller. Agent subscriptions, model usage and connected services are separate, so an agent still needs its own model account or key. Hivra works the same way on that point: the AI is billed apart from the computer.",
        `As our own arithmetic, the closest Hivra size to Cubicles Standard is ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, against $24 before tax for 4 vCPU and 8 GB of memory, a difference of about $4.01 a month before tax and before any AI usage. The Hivra entry size is ${ENTRY_PRICE_PROSE}, half the compute of Standard, so the two are not like for like. Cubicles also lists 64 GB of storage per computer, while Hivra does not publish a disk size on this page. We also did not find tax treatment for Hivra stated the same way, so compare the checkout totals rather than the list prices.`,
        `Hivra charges for a computer rather than for use: ${ENTRY_PRICE_PROSE}. ${AI_USAGE}`,
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and runs the agent's own installer, and you work through a browser view with chat, a terminal and files. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "The trade-off is the desktop. We do not describe the Hivra browser view as a full Linux desktop with arbitrary graphical apps such as an office suite or a design tool, and a person cannot watch the agent drive a mouse and keyboard on a shared screen the way Cubicles describes. If your agent's job is mostly code, a repo, scheduled work and a chat, that matters less. If its job is to click through applications, it matters a lot.",
        "Hivra is independent and is not affiliated with Cubicles, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A Hivra account costs nothing, but every Hivra Cloud computer is a paid plan. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Cubicles is the better choice when the agent needs a screen. Its computers are full Ubuntu desktops with Chrome and Firefox, VS Code, Docker, LibreOffice and anything else you install, and its pages say you can watch the agent work live from any browser and share the screen through a view-only link or invite someone to use it. Hivra does not offer that desktop surface today.",
        "Cubicles is also the better choice when you want to try something without paying. At the time we read its pages, it offered one free Standard computer per account, without adding payment details, while capacity lasts. Every Hivra Cloud computer is a paid plan, so there is no free hosted computer to try, only a refund route if it is not right.",
        "It is better when you want to drive computers from code. Its documentation describes a REST API that can create, start, stop and delete desktops, run commands, take screenshots, move files and manage agents (OpenClaw, Hermes, Claude Code, Codex or OpenCode), and an MCP server that can start, stop and restart desktops, run commands, read and write files and take screenshots. Its docs say creating or deleting desktops is not available through MCP. We have not published a public API or SDK for creating Hivra computers from code, so that kind of scripting is not what Hivra offers today.",
        "And it is better if you want several separate computers, one per job. Its pages say you can have no limit on how many, each on its own monthly subscription, and can put one to sleep when idle, with its files kept. Note that its service details say stopping a computer does not cancel the subscription, so a stopped computer is still charged.",
        "Choose Hivra when you want the agent itself managed for you, a fixed monthly figure with a stated size, and a guarantee you can read before you pay. Choose Cubicles when a real desktop is the point.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Cubicles compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}; ${LARGER_PLAN_PRICE}/mo for ${LARGER_PLAN_SIZE}`, alternative: `Monthly subscription per computer, before tax: Standard $24, Pro $48, Studio $72, as of ${AS_OF}; the home page offers one free Standard computer per account` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "A full Ubuntu desktop, opened in a browser, with agents and apps installed" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_SIZE}`, alternative: "Standard 4 vCPU and 8 GB; Pro 8 vCPU and 16 GB; Studio 12 vCPU and 24 GB (Pro and Studio marked sold out when we read the page)" },
            { criterion: "Storage", hivra: "Disk size on the computer is not published", alternative: "64 GB NVMe on Standard, 128 GB on Pro, 192 GB on Studio (its API docs examples show 120 GB for Standard and 240 GB for Pro, which differ from the plan pages, so confirm)" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "On until you stop it; its pages say that closing the tab does not stop the agent and that a stopped computer keeps its files" },
            { criterion: "Persistence", hivra: "Files, repos, logins and CLI session history stay on the computer", alternative: "Files stay when a computer is stopped; deleting a computer erases every file on it" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "OpenClaw, Hermes Agent, Claude Code, Codex and the ChatGPT desktop app come installed; others such as Browser Use can be installed; OpenCode appears in its API agent list" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Agent subscriptions and model usage are separate; you bring your own accounts or keys" },
            { criterion: "Access method", hivra: "A browser view with chat, a terminal and files, which varies by agent", alternative: "A full desktop in the browser; also a REST API and an MCP server (desktops are created and deleted through the REST API or the site, not MCP)" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Create a computer, open it, pick an installed agent and sign in to its accounts" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "Cubicles provides the desktop; you manage the agent, its accounts and anything you install" },
            { criterion: "Data and security", hivra: "Each agent runs on its own computer, isolated from other customers' computers", alternative: "Its pages say the agent runs away from your laptop and that its staff cannot access your computer; it warns an agent can still be tricked by what it reads" },
            { criterion: "Location", hivra: "Regions are not published on this page", alternative: "Frankfurt, per its service details and API catalog" },
            { criterion: "Limits", hivra: "Set by the plan's total CPU and RAM, shared by the agents on it", alternative: "API commands and screenshots limited to 120 a minute per account; no stated limit on the number of computers" },
            { criterion: "Support", hivra: "Support channel and response times are not published on this page", alternative: "Docs, setup guides, and an email address on its refund page; other support channels not confirmed" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Its refund policy says a paid monthly charge, including the first, is not refunded once paid, with exceptions for duplicate charges, no delivery or where the law requires" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "You can download files through its API; its terms say deleting a computer erases every file and that you should keep copies" },
            { criterion: "Best for", hivra: "A developer who wants a supported agent's own computer, managed and ready", alternative: "Someone whose agent must use graphical apps and a real browser on a desktop you can watch" },
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
            { lead: "Maya, whose agent fills in forms and files reports in web apps:", text: "It needs a real browser, a signed-in session and ideally someone to watch it. Pick Cubicles. A full desktop with Chrome is the shape of that job, and the home page offers a free Standard computer to test it on." },
            { lead: "Tom, who runs one Claude Code agent on his own side projects:", text: `He wants to open it from a browser in the evening and find his repos and CLI session history as he left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. He does not need a desktop for it.` },
            { lead: "Priya, who wants to try an agent computer without paying first:", text: "She is not sure the idea suits her yet. Pick Cubicles for the first try, since its pages list one free Standard computer per account while capacity lasts, then compare a paid month on each." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: "It must keep going when he closes his laptop and be there each morning. Pick Hivra, with one condition on how he starts the run. If he runs Claude Code or Codex, a run he starts inside tmux in the computer's Terminal tab keeps going after he closes the laptop, and on Claude Code, work he sends through Telegram runs on the computer, not in his browser. If he runs Hermes, OpenClaw or Agent Zero, they run on the computer itself and need no open browser. Cubicles can also do this, since its pages say the agent keeps working after you close the tab, but the setup guide asks you to test a persistent process yourself." },
            { lead: "Dana, a platform engineer who wants to script her agents' machines:", text: "She wants to create, start, stop and delete computers from code and give her own tools an MCP connection. Pick Cubicles. It documents a REST API for creating and deleting computers and an MCP server for starting, stopping and driving them, and Hivra does not publish either." },
            { lead: "Sam, a founder who would rather not forecast a bill:", text: "A flat figure with a stated size is easier to approve. Either works, because both are monthly. Pick Hivra if the agent needs no desktop and he wants the lower entry price, and put model usage on the account or key he already pays for." },
            { lead: "Leo, who wants a desktop for one job and a managed agent for another:", text: "Use both. Keep the long-running agent on a Hivra computer and give the desktop-heavy job its own Cubicles computer, each on its own terms." },
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
            { lead: "Pick one real task.", text: "Use something your agent already does, such as a scheduled report or a repo it keeps up to date, plus one task that needs a browser, so both runs do the same work." },
            { lead: "Run it on Cubicles.", text: "Create an account and, if the free Standard computer is still offered and has room, start there. Open the computer, pick one of the installed agents, sign in with your own model account and run the task. Note whether it needed a person to pass a site check, which its own FAQ says can happen from a data centre." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "Start the Hivra run inside tmux in the Terminal tab (or send it through Telegram on Claude Code), because a browser chat or session-tab run is not certain to continue. In the morning, check which one finished the scheduled work and whether the files, logins and history were where you left them." },
            { lead: "Compare a full month.", text: `Add up the Cubicles subscription before tax and any size you needed, plus model usage on either side, against ${ENTRY_PRICE_PROSE}. Remember that Cubicles says a first paid charge is not refunded.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Cubicles, its service details say stopping a computer ends its running processes and keeps its files, and that stopping does not cancel the monthly subscription. Cancelling the subscription stops the next charge and the computer is deleted when the paid period ends. Once cancelled, you can delete it straight away by typing its name, and the rest of the period is not refunded. Deleting erases the computer and every file on it, and its terms tell you to keep copies of anything you need.",
        "Its home page says that if you close the tab the agent keeps working, and that you can open the computer again from any device to watch. Its setup guide is more careful: it describes a setup outline and says it is not a tested Cubicles installation or an automatic template, and asks you to configure a persistent process using the agent's own instructions, close only the browser view and reconnect to check. We take that to mean the always-on behaviour depends on how the agent itself is set up, which is also true of any agent on any host.",
        "Its privacy page says files, apps and accounts stay on your computer, that its staff cannot access it, and that when you delete a computer it deletes the computer, every file on it and the information about it, including shares. Screen sharing is by a view-only link that lets anyone with the link watch but not click or type, or by an invitation that lets one signed-in person click and type. Anyone you share with sees whatever is on the screen.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, repos, logins and CLI session history. Hivra makes no promise of backups, so keep your own copy of anything you cannot lose, on either platform.`,
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "Cubicles home page and plans", href: "https://cubicles.cloud/" },
      { label: "Cubicles pricing", href: "https://cubicles.cloud/pricing" },
      { label: "Cubicles service details", href: "https://cubicles.cloud/service-details" },
      { label: "Cubicles terms", href: "https://cubicles.cloud/terms" },
      { label: "Cubicles privacy", href: "https://cubicles.cloud/privacy" },
      { label: "Cubicles refund policy", href: "https://cubicles.cloud/refund-policy" },
      { label: "Cubicles docs (REST API, MCP, agents)", href: "https://cubicles.cloud/llms-full.txt" },
      { label: "Cubicles assistant setup guide", href: "https://cubicles.cloud/guides/assistant" },
    ],
    [
      "Cubicles's free offer, its beta status and its sold-out sizes are vendor statements that may change. Its home page offers one free Standard computer per account while there is room, and its plans page says every computer is free during beta, so the two pages differ in detail.",
      "Not stated on the pages we read: how long the free offer lasts, what the price will be after beta, a compliance or security certification, regions other than Frankfurt, a backup or saved-image policy, an uptime commitment, how much support is included, and a guaranteed always-on promise beyond its statement that closing the tab does not stop the agent. Its API docs examples show 120 GB (Standard) and 240 GB (Pro) disks, different from its plan pages. We did not test either product's agents or desktop ourselves.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does Cubicles cost?",
      a: `As of ${AS_OF}, Cubicles lists Standard at $24 a month for 4 vCPU and 8 GB of memory, Pro at $48 for 8 vCPU and 16 GB, and Studio at $72 for 12 vCPU and 24 GB, all before tax, with Pro and Studio marked sold out when we read the page. Its home page also offers one free Standard computer per account while there is room. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is Cubicles cheaper than Hivra?",
      a: `Not on list prices for the closest size. Cubicles Standard is $24 a month before tax for 4 vCPU and 8 GB of memory, while Hivra is ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}. Cubicles is cheaper if its free Standard computer is still available to you. Compare checkout totals, since tax and AI usage are extra on both.`,
    },
    {
      q: "Is the Cubicles free computer really free?",
      a: "Its home page says every account can have one free Standard computer, without adding payment details, while there is room on the servers that host them. Its plans page says every computer is free while it is in beta. It does not say how long that lasts, so confirm before you depend on it.",
    },
    {
      q: "Can I use Cubicles and Hivra together?",
      a: "Yes. They do different jobs. You could keep a long-running agent on a Hivra computer and give a desktop-heavy task its own Cubicles computer, and you would pay each on its own terms.",
    },
    {
      q: "Does a Cubicles computer keep running when I close my laptop?",
      a: "Its home page says that if you close the tab the agent keeps working, because it runs inside the computer in the cloud. Its setup guide asks you to configure a persistent process and test it by closing the browser view and reconnecting, and says it is not a tested installation. Stopping a computer ends its running processes but still charges the subscription.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `${STAYS_ON} That is the computer: for Claude Code or Codex, a run started inside tmux in the Terminal tab, or Claude Code work sent through Telegram, keeps going after you close the laptop, while a browser chat or session-tab run is not certain to. Hermes, OpenClaw and Agent Zero run on the computer itself. Cubicles describes its computers as on until you stop them, and leaves persistence of the agent process to the agent's own setup.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On Cubicles, stopping a computer keeps its files, and deleting it erases the computer and every file on it. Its terms tell you to keep copies. On Hivra, the computer keeps your files, repos, logins and CLI session history, but Hivra makes no promise of backups, so keep your own copy of anything important.",
    },
    {
      q: "Which one is better for running Claude Code or Codex?",
      a: "Both can run them. Cubicles lists Claude Code and Codex among the agents on its computers, and Hivra hosts both. Choose Cubicles if you also want a full desktop and a screen to watch, or an API to create computers, and Hivra if you want a managed agent computer and a flat plan. Hivra is not affiliated with Cubicles, Anthropic or OpenAI.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} Cubicles also says agent subscriptions and model usage are separate from the computer.`,
    },
    {
      q: "Can I get a refund on each?",
      a: `Cubicles says a paid monthly charge, including the first, is not refunded in full or in part once paid, apart from duplicate charges, a computer never delivered, or where the law requires it. Hivra has a ${MONEY_BACK_GUARANTEE}, set out in its terms.`,
    },
    {
      q: "Is there a free way to try each?",
      a: `Cubicles' pages list a free Standard computer for each account while there is room. A Hivra account costs nothing, but every Hivra Cloud computer is paid, with a ${MONEY_BACK_GUARANTEE}. A free account works with a server you connect yourself.`,
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
