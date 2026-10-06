import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "what-can-hermes-agent-actually-do",
  title: "What can Hermes Agent actually do? Real things people use it for",
  metaTitle: "What can Hermes Agent actually do? Real use cases",
  metaDescription:
    "What Hermes Agent can do on a 24/7 server: scheduled briefings, monitoring, coding help, browser automation, email drafts and research, with examples.",
  publishedDate: "2026-04-18",
  lastModified: "2026-09-30",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "What people use Hermes for, day to day.",
  intro:
    "Hermes Agent runs 24/7 on a server, so it keeps working after you close the chat. Before you set one up, you'll want to know what you'd use it for. These are the jobs people in the community give it, with enough detail to tell whether any of them fit you.",
  shortAnswer:
    "Hermes Agent is an assistant that runs 24/7 on a server and does tasks as well as chatting. People use it for scheduled briefings, monitoring and alerts, coding help, browser automation, file processing, email drafts, research, finance summaries, home automation and API workflows. You do all of it by messaging the agent on Telegram or another connected app.",
  sections: [
    {
      heading: "Why can Hermes do things a chatbot can't?",
      paragraphs: [
        "Because it never closes. Hermes runs in the background all the time, messages *you* first when something needs you, remembers past conversations, and can run code and use websites.\n\nPicture a colleague who's up at 3am, remembers what you worked on last month, and does the task instead of telling you how. Want the longer version? Here's [how an agent differs from a chatbot](/blog/ai-agent-vs-chatbot).",
        "Everything below works through whatever messaging app you connect it to. Telegram is the most popular. [Discord, WhatsApp, Email, and 11 others](/blog/hermes-agent-telegram-discord-setup) also work. You text it. It does the thing. It replies when done.",
      ],
    },
    {
      heading: "Can it send me a morning briefing?",
      paragraphs: [
        "Yes, and this is where most people start. Hermes has a built-in scheduler, so you set it up once and it just runs.\n\nPeople send themselves a daily weather and calendar summary, a portfolio snapshot pulled from a finance API, GitHub issues opened overnight, or just headlines filtered to topics they care about. The agent fetches everything, writes a summary, and sends it to Telegram before you're out of bed.",
        "Setup is a one-time thing. Tell the agent what you want in conversation and ask it to schedule itself. It writes the cron entry and handles the rest. Or use a [skill file](/blog/hermes-agent-skills-guide) if you want something more structured.",
      ],
    },
    {
      heading: "Can it watch things and only ping me when something changes?",
      paragraphs: [
        "That's exactly what running 24/7 is for. Have it ping your services every 5 minutes and message you on Telegram the moment one goes down. Watch a product page and tell you when the price drops under your target. Summarise new issues and PRs on a repo as they land. Check a careers page every morning and stay quiet unless a relevant role shows up.\n\nThis is where a server beats your laptop. Laptops sleep. The agent doesn't.",
      ],
    },
    {
      heading: "Can it help with code?",
      paragraphs: [
        "Yes. Hermes reads and writes files, runs commands and executes code. Point it at a source folder and ask it to find all usages of a deprecated function, write tests for something you just described, explain what a complex file does in plain English, or run the test suite and summarise what failed.\n\nThe part that pays off over time: it [remembers your project across sessions](/blog/hermes-agent-memory-system-explained). After a few weeks, you don't re-explain your tech stack or code style every time. It already knows.",
        "For developers who want to understand the security model (how shell access is sandboxed, why non-root matters), [the self-hosting guide](/blog/how-to-self-host-hermes-agent) covers it.",
      ],
    },
    {
      heading: "Can it use websites for me?",
      paragraphs: [
        "Yes, with a real browser. Hermes can log into dashboards, fill in forms, extract data from pages that need JavaScript to work, take screenshots, and interact with things that a basic HTTP request can't touch.\n\nReal setups people run: pulling weekly reports from a SaaS dashboard, filling timesheet fields across multiple days, downloading invoices from vendor portals, checking competitor pricing pages on a schedule.",
        "The browser is hungry, so leave at least 2 GB of RAM spare above what the agent normally uses. A Hetzner CX33 (8 GB) handles it fine, and the [VPS comparison](/blog/best-vps-for-hermes-agent) has the rest of the hardware detail.",
      ],
    },
    {
      heading: "Can it sort files and documents?",
      paragraphs: [
        "Yes. It has full access to the server's files, plus any cloud storage you mount. Have it rename and organise files based on their contents. Convert a folder of PDFs to text. Extract data from spreadsheets. Archive old project folders on a schedule.\n\nIt reads PDFs, images (with vision), CSVs, most text formats. Output goes to a new file or back to you as a message, depending on what you ask for.",
      ],
    },
    {
      heading: "Can it handle email?",
      paragraphs: [
        "Drafts, yes. Connect an email account over IMAP/SMTP and it can draft replies, flag urgent messages or watch for certain kinds of mail. The usual flow: forward a thread to the agent on Telegram, ask for a reply, read it, send it.\n\nIt won't replace your email client. It's good at the same chore every week: drafting responses to job applications, writing newsletter updates, processing customer support emails into a structured format.",
      ],
    },
    {
      heading: "Can it research a topic for me?",
      paragraphs: [
        "Yes, from real sources. Ask it to research something and it opens actual pages, pulls out the key points and hands back a summary with citations. It reads the pages. It doesn't guess what's on them.\n\nPeople use it for competitor research, digging into a technical topic before a meeting, summarising a long PDF, or generating a company briefing before a call. Output goes to a file you can keep and edit.",
      ],
    },
    {
      heading: "Can it track my money?",
      paragraphs: [
        "If your bank, portfolio tracker or expense tool has an API, yes. Hermes pulls the numbers and sends summaries to Telegram. Friday afternoon spending breakdown. Monthly P&L for freelancers. Morning portfolio snapshot.\n\nWrap the API connection in a [skill](/blog/hermes-agent-skills-guide) once, and the agent calls it on schedule without you explaining it again.",
      ],
    },
    {
      heading: "Can it run my smart home?",
      paragraphs: [
        "Through [Home Assistant](https://www.home-assistant.io/), yes. Hermes connects to it the same way it connects to Telegram, so you can control lights, heating, security and any other connected device from anywhere.\n\nIt reacts to sensors too. Tell it to warn you if the front door opens between 10pm and 7am, switch the bedroom light on at sunset, or message you when the temperature falls below 18°C.",
      ],
    },
    {
      heading: "Does it get better at my tasks over time?",
      paragraphs: [
        "Yes. When Hermes solves something it expects to see again, it can [write a skill](/blog/hermes-agent-skills-guide), a reusable how-to, and follow it next time. Your deployment flow might take 5 minutes the first time. Once it's written down, the same job runs faster and more predictably.\n\nSix months in, your agent has a library of skills built around how you work. Your deploy steps. Your document formats. Your code style. You never trained it. It wrote down what worked.",
      ],
    },
    {
      heading: "What does using it day to day look like?",
      paragraphs: [
        "Mostly, people just text it. Hermes sits in Telegram and gets messages all day. 'Remind me at 3pm to follow up with Alex.' 'Is my staging server up?' 'What was I researching last Thursday?' 'Draft an invoice for 12 hours at £150/hr.'\n\nIt does each one, uses whatever tools it needs, remembers what came before, and replies when it's done. For a lot of people that's the real win: dozens of little jobs that used to rot on a to-do list just get done.",
      ],
    },
    {
      heading: "Can it connect my business tools together?",
      paragraphs: [
        "Yes. Hermes makes HTTP requests, handles sign-in, reads the responses and chains calls together. With webhooks, outside services can wake it directly: Stripe, GitHub, JIRA, anything that can send a POST request.\n\nA few flows people run. A new Stripe payment comes in, the agent looks up the customer and sends a personal welcome. Someone opens a GitHub PR, the agent reviews it and leaves a comment. A support ticket lands, the agent tags it and drafts a first reply. [The gateway guide](/blog/hermes-agent-telegram-discord-setup) covers the webhook setup.",
      ],
    },
    {
      heading: "How do I get started?",
      paragraphs: [
        `Run it on your own server ([here's the guide](/blog/how-to-self-host-hermes-agent)), or use [Hivra](/), which handles the server, setup and upkeep so there's nothing to install.\n\nSelf-hosting runs about $10 to $25 a month all in. Hivra starts at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, with no server to look after. The [full cost breakdown](/blog/cost-of-running-ai-agent) has the details.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Is Hermes Agent the same as ChatGPT?",
      a: "No. ChatGPT is a chat interface you open when you need it. Hermes runs 24/7 on a server, remembers past conversations, executes code and tasks, and can message you on a schedule without being asked. You can run GPT-4o under both, and they still work completely differently.",
    },
    {
      q: "Do I need to be technical to use Hermes Agent?",
      a: "To self-host, you need to be comfortable on a Linux server. On Hivra you don't: connect your key, set up a Telegram bot, done. Day to day, either way, you just message it.",
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
      a: "Yes. It runs on a server, not your computer. Scheduled tasks fire, monitoring keeps going and it answers messages whether your laptop is open, shut or in a drawer.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-vs-chatbot", title: "AI agent vs chatbot: what is actually different" },
    { slug: "hermes-agent-skills-guide", title: "Hermes Agent skills: how they work and how to create them" },
    { slug: "hermes-agent-memory-system-explained", title: "Hermes Agent memory explained" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
  ],
};
