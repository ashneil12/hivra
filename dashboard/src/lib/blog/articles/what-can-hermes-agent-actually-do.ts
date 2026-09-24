import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "what-can-hermes-agent-actually-do",
  title: "What can Hermes Agent actually do? Real things people use it for",
  metaDescription:
    "Hermes Agent is a persistent AI assistant you run 24/7. This covers what it can actually do: scheduling, browser automation, file management, Telegram messaging, coding tasks, and more — with real examples instead of marketing claims.",
  publishedDate: "2026-04-18",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "Not what the marketing says. What people actually use it for every day.",
  intro:
    "Hermes Agent runs 24/7 on a server — it's not a chatbot you open when you need it. Before setting one up, the obvious question is: what would I actually use this for? Here's what people in the community use it for, with enough real detail to figure out if any of it applies to you.",
  sections: [
    {
      heading: "Why these use cases are possible at all",
      paragraphs: [
        "Hermes runs in the background continuously, can reach out to *you* rather than waiting to be asked, has memory of past conversations, and can execute code and interact with websites. Not just generate text.\n\nThink of it as a capable colleague who's available at 3am, remembers what you worked on last month, and actually does tasks rather than describing how you could do them. The [full comparison with standard chatbots](/blog/ai-agent-vs-chatbot) is worth reading if you want the deeper breakdown.",
        "Everything below works through whatever messaging app you connect it to. Telegram is the most popular. [Discord, WhatsApp, Email, and 11 others](/blog/hermes-agent-telegram-discord-setup) also work. You text it. It does the thing. It replies when done.",
      ],
    },
    {
      heading: "Morning briefings",
      paragraphs: [
        "Hermes has a built-in scheduler. You set it up once and it runs without you asking.\n\nPeople send themselves: a daily weather + calendar summary, a portfolio snapshot pulled from a finance API, GitHub issues opened overnight, or just headlines filtered to topics they care about. The agent fetches everything, writes a summary, and sends it to Telegram before you're out of bed.",
        "Setup is a one-time thing. Tell the agent what you want in conversation and ask it to schedule itself — it writes the cron entry and handles the rest. Or use a [skill file](/blog/hermes-agent-skills-guide) if you want something more structured.",
      ],
    },
    {
      heading: "Monitoring and alerts",
      paragraphs: [
        "Because it runs 24/7, it can watch things and only message you when something changes. Worth setting up:\n\n- **Server uptime** — ping your services every 5 minutes, alert on Telegram if one goes down\n- **Price tracking** — check a product page and alert when the price drops below your target\n- **GitHub activity** — watch a repo and summarise new issues or PRs when they land\n- **Job postings** — check a careers page daily, alert only when new relevant roles appear\n\nThis is where running on a server rather than your laptop actually matters. Laptops sleep. The agent doesn't.",
      ],
    },
    {
      heading: "Coding assistant that knows your codebase",
      paragraphs: [
        "Hermes can read files, write files, run commands, and execute code. Point it at a source directory and ask it to find all usages of a deprecated function, write tests for something you just described, explain what a complex file does in plain English, or run the test suite and summarise what failed.\n\nThe part that gets genuinely useful over time: it [remembers your project context across sessions](/blog/hermes-agent-memory-system-explained). After a few weeks, you don't re-explain your tech stack or code style every time. It already knows.",
        "For developers who want to understand the security model — how shell access is sandboxed, why non-root matters — [the self-hosting guide](/blog/how-to-self-host-hermes-agent) covers it.",
      ],
    },
    {
      heading: "Browser automation",
      paragraphs: [
        "Full browser, not just URL fetching. Hermes can log into dashboards, fill in forms, extract data from pages that need JavaScript to work, take screenshots, and interact with things that a basic HTTP request can't touch.\n\nReal setups people run: pulling weekly reports from a SaaS dashboard, filling timesheet fields across multiple days, downloading invoices from vendor portals, checking competitor pricing pages on a schedule.",
        "Browser automation needs RAM — budget at least 2GB headroom above the agent's baseline. The [VPS comparison](/blog/best-vps-for-hermes-agent) has the hardware breakdown. Hetzner CX33 (8GB) handles it without issues.",
      ],
    },
    {
      heading: "File management and document processing",
      paragraphs: [
        "Hermes has full access to the server's filesystem, and if you mount cloud storage it can reach that too. Rename and organise files based on their contents. Convert a folder of PDFs to text. Extract data from spreadsheets. Archive old project folders on a schedule.\n\nIt reads PDFs, images (with vision), CSVs, most text formats. Output goes to a new file or back to you as a message, depending on what you ask for.",
      ],
    },
    {
      heading: "Email drafts",
      paragraphs: [
        "Connect it to an email account via IMAP/SMTP and it can draft replies, flag urgent messages, or monitor for specific types of incoming mail. Most common workflow: forward a thread to the agent on Telegram, ask for a draft reply, review it, send.\n\nNot a replacement for a proper email client. Good for specific recurring things — drafting responses to job applications, writing newsletter updates, processing customer support emails into a structured format.",
      ],
    },
    {
      heading: "Research",
      paragraphs: [
        "Ask Hermes to research something and it browses actual sources, extracts the key points, and returns a summary with citations. It visits real pages — it doesn't describe what might be there.\n\nPeople use it for competitor research, digging into a technical topic before a meeting, summarising a long PDF, or generating a company briefing before a call. Output goes to a file you can keep and edit.",
      ],
    },
    {
      heading: "Personal finance tracking",
      paragraphs: [
        "With API access to a bank, portfolio tracker, or expense tool, Hermes pulls financial data and sends weekly summaries to Telegram. Friday afternoon spending breakdown. Monthly P&L for freelancers. Morning portfolio snapshot.\n\n[Skills](/blog/hermes-agent-skills-guide) are the standard way to package up an API integration here — write it once, the agent calls it on schedule without re-explanation.",
      ],
    },
    {
      heading: "Home automation",
      paragraphs: [
        "Hermes supports [Home Assistant](https://www.home-assistant.io/) as a native gateway — the same way it connects to Telegram, it can connect to your smart home. Control lights, heating, security, any connected device from anywhere.\n\nBeyond direct control: it responds to sensor events. Alert if the front door opens between 10pm and 7am. Turn on the bedroom light at sunset. Message me if the temperature drops below 18°C.",
      ],
    },
    {
      heading: "Self-improving workflows",
      paragraphs: [
        "When Hermes solves a problem it expects to face again, it can [write a skill](/blog/hermes-agent-skills-guide) — a reusable procedure — and use that skill next time. First time you ask it to run your deployment flow might take 5 minutes. After it documents the process, same task is faster and more predictable.\n\nAfter six months of use, a Hermes instance has a skill library specific to your workflows. It knows your deployment process, your document formats, your code style — not because you trained it, but because it documented what worked.",
      ],
    },
    {
      heading: "Daily Telegram commands",
      paragraphs: [
        "This is what most people describe as their actual daily experience. They have Hermes on Telegram and just text it during the day. 'Remind me at 3pm to follow up with Alex.' 'Is my staging server up?' 'What was I researching last Thursday?' 'Draft an invoice for 12 hours at £150/hr.'\n\nThe agent handles individual requests, uses tools as needed, remembers past sessions, and replies when done. For people in this pattern, it replaces a lot of small tasks that used to pile up in a to-do list.",
      ],
    },
    {
      heading: "API and business automation",
      paragraphs: [
        "Hermes makes HTTP requests, handles authentication, parses responses, and chains API calls. Webhook support means external services trigger the agent directly — Stripe, GitHub, JIRA, anything that can send a POST request.\n\nFlows people actually run: new Stripe payment arrives → agent pulls customer info → sends a personalised welcome. GitHub PR opened → agent runs a code review and posts a comment. Support ticket created → agent categorises and drafts an initial response.\n\n[The gateway guide](/blog/hermes-agent-telegram-discord-setup) covers webhook setup.",
      ],
    },
    {
      heading: "How to get started",
      paragraphs: [
        "Two options: self-host it on a server ([full guide here](/blog/how-to-self-host-hermes-agent)) or use [Hivra](/), which handles the server, setup, and maintenance so there is nothing to install.\n\nSelf-hosting costs around $10-25/month total. Hivra starts at $9.99/month with no server to manage. [Full cost breakdown here](/blog/cost-of-running-ai-agent).",
      ],
    },
  ],
  faqs: [
    {
      q: "Is Hermes Agent the same as ChatGPT?",
      a: "No. ChatGPT is a chat interface you open when you need it. Hermes runs 24/7 on a server, remembers past conversations, executes code and tasks, and can message you on a schedule without being asked. You can use GPT-4o as the underlying model for both — but they work completely differently. Full comparison: /blog/ai-agent-vs-chatbot",
    },
    {
      q: "Do I need to be technical to use Hermes Agent?",
      a: "Self-hosting requires Linux server familiarity. Hivra managed hosting requires none — connect your API key, set up a Telegram bot, done. Day-to-day use either way is just messaging it.",
    },
    {
      q: "Does Hermes Agent work on mobile?",
      a: "Yes. Connect it to Telegram (or Discord, WhatsApp, etc.) and it's accessible from any device those apps run on. No separate mobile app needed.",
    },
    {
      q: "Can multiple people use the same instance?",
      a: "Yes. Add multiple User IDs to the allowlist. They all interact with the same agent and share memory and skills. For separate agents per person, each person needs their own agent, and on Hivra you can launch several agents in one account.",
    },
    {
      q: "Does it work when my computer is off?",
      a: "It runs on a server, not your computer. Scheduled tasks fire, monitoring runs, it responds to messages — all regardless of what you're doing or whether your laptop is on.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-vs-chatbot", title: "AI agent vs chatbot: what is actually different" },
    { slug: "hermes-agent-skills-guide", title: "Hermes Agent skills: how they work and how to create them" },
    { slug: "hermes-agent-memory-system-explained", title: "Hermes Agent memory explained" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
  ],
};
