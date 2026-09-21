import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "hermes-agent-cron-scheduled-tasks",
  title: "Hermes Agent scheduled tasks: automate anything on a timer",
  metaDescription:
    "Hermes Agent has a built-in scheduler — no separate cron setup needed. This covers how it works, how to set up a morning briefing, monitoring alerts, weekly reports, and how to manage scheduled tasks from the command line.",
  publishedDate: "2026-04-20",
  lastModified: "2026-04-20",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "Your agent runs tasks while you sleep. Here is how to set that up.",
  intro:
    "One of the more useful things about a persistent agent: it doesn't wait for you to ask it something. Hermes has a built-in scheduler that fires tasks at whatever interval you define — every morning, weekly, every hour. No separate cron knowledge required, though cron syntax works if you know it.",
  sections: [
    {
      heading: "How the scheduler works",
      paragraphs: [
        "The gateway process checks every 60 seconds whether any jobs are due. When a job fires, the agent runs the task — using all its tools, memory, and skills — and delivers the result to whatever platform you've connected. Telegram, Discord, Email, whoever.\n\nThis is different from a standard cron job, which runs a script. Hermes scheduling runs the AI agent. So the 'script' can browse websites, call APIs, read files, do research, and write a structured result. You describe what you want in plain English. The agent figures out how to do it.",
        "The scheduler lives inside the gateway, so it only fires when the gateway is running. On [Hivra](/) that's handled automatically. Self-hosted: install the gateway as a system service (`hermes gateway install`) so it starts on boot and restarts after crashes.",
      ],
    },
    {
      heading: "Setting up a scheduled task",
      paragraphs: [
        "Simplest method: tell the agent in conversation.\n\n> 'Every weekday at 8am, send me a Telegram message with today's weather in London and any calendar events I have before noon.'\n\nIt creates the schedule and confirms. Check what's scheduled:\n\n```bash\nhermes cron list\n```\n\nFor more control, use standard cron syntax — five fields: minute, hour, day of month, month, day of week:\n\n```\n0 8 * * 1-5     # weekdays at 8am\n0 18 * * 0      # Sundays at 6pm\n*/15 * * * *    # every 15 minutes\n0 * * * *       # top of every hour\n```\n\nIf cron syntax is unfamiliar: [crontab.guru](https://crontab.guru/) translates between plain English and cron expressions and shows the next 5 fire times.",
      ],
    },
    {
      heading: "Where the results go",
      paragraphs: [
        "Any platform you've connected. Specify the destination when creating the task — one task can go to Telegram, another to Email, another to Discord. The result arrives like a normal message from your bot.",
      ],
    },
    {
      heading: "Morning briefing",
      paragraphs: [
        "Most common scheduled task. Common things people put in:\n\n- Weather forecast for the day\n- Calendar events\n- Unread email count + anything flagged urgent\n- News headlines filtered to topics you care about\n- Outstanding tasks from your to-do system\n- Portfolio snapshot if you track investments\n\nStart with one or two. The agent needs API credentials for each data source (Google Calendar API key, etc.) — it will ask the first time, or you add them to `~/.hermes/.env` directly. Once set, they're remembered.",
      ],
    },
    {
      heading: "Monitoring and conditional alerts",
      paragraphs: [
        "Scheduled tasks don't have to deliver every time they fire. You can set up tasks that only message you when something notable happens:\n\n> 'Every 5 minutes: check if my-app.com returns HTTP 200. Message me on Telegram only if it doesn't.'\n\nOr:\n\n> 'Every morning: check the price of [product]. Message me only if it's dropped since yesterday.'\n\nThe agent handles the conditional logic. It fires, does the check, decides whether the result is worth sending. Far more useful than unconditional pings that just create noise.",
        "For server monitoring: the agent can SSH into other servers (with key auth configured), check disk usage, running processes, memory, recent error logs, then send a summary or alert only on problems. [The self-hosting guide](/blog/how-to-self-host-hermes-agent) covers SSH key setup.",
      ],
    },
    {
      heading: "Weekly reports",
      paragraphs: [
        "Weekly cadence works for things that aren't urgent but benefit from a regular look:\n\n- GitHub activity — open PRs, issues created this week, commits by author\n- Business metrics — weekly revenue, new signups, churn from Stripe\n- Content — posts published, word count, analytics from top pages\n- Personal — a reflection prompt: what did you actually finish this week?\n\nFor business metrics, the agent needs API access to relevant services. [Skills](/blog/hermes-agent-skills-guide) are the standard packaging — write the API integration once as a skill, the scheduler calls it weekly without re-explanation.",
      ],
    },
    {
      heading: "Managing scheduled tasks",
      paragraphs: [
        "```bash\nhermes cron list           # all scheduled tasks with next fire time\nhermes cron list --detail  # include description and delivery platform\nhermes cron edit <id>      # open task in your editor\nhermes cron delete <id>    # remove permanently\nhermes cron pause <id>     # pause without deleting\nhermes cron run <id>       # fire the task right now (for testing)\n```\n\nThe `run` command is the most useful during setup — fire the task immediately to see what the output looks like before waiting for the scheduled time. Saves a lot of guessing.",
        "Scheduled tasks live in your profile config. They're included in profile exports and backups — migrate to a new server or to Hivra and the schedule comes with you.",
      ],
    },
    {
      heading: "A realistic full schedule",
      paragraphs: [
        "What a developer's daily automated schedule might look like:\n\n**8:00am (weekdays)** — GitHub notifications + weather + calendar events before noon → Telegram\n\n**Every 30 minutes (9am–6pm)** — ping staging.myapp.io, message me on Telegram only if it returns non-200\n\n**Friday 5pm** — summarise merged PRs across three repos this week, include author and a one-sentence description of each change → Telegram\n\n**Sunday 7pm** — check Notion task list, list everything still open from last week, ask: what's the one most important thing for this week? → Telegram\n\nNone of this requires writing code. You describe what you want. The agent works out how.",
      ],
    },
  ],
  faqs: [
    {
      q: "Does scheduling work when I'm not connected?",
      a: "Yes. The gateway runs on your server, not your computer. Tasks fire and deliver to your chosen platform whether your laptop is on or off.",
    },
    {
      q: "What if a scheduled task fails?",
      a: "The gateway logs runs and errors. Check with: hermes cron logs <id>. By default it retries once on failure. For critical monitoring, consider setting a secondary alert — if the primary check errors, deliver to a backup platform.",
    },
    {
      q: "Can different tasks go to different platforms?",
      a: "Yes. Specify the delivery platform per task. Morning briefing to Telegram, weekly report to Email, alerts to Discord — whatever you want.",
    },
    {
      q: "What's the minimum interval?",
      a: "The scheduler ticks every 60 seconds, so 1 minute is the minimum. Sub-minute isn't supported. For near-real-time triggers, webhooks are the right tool — see the gateway guide.",
    },
    {
      q: "Will frequent tasks spike my API costs?",
      a: "Each task invocation uses API tokens. Simple checks (ping a URL, send a fixed message) use very few. Complex tasks (research, email summarisation) use more. Heaviest tasks should run at low frequency — weekly, not hourly. Full cost breakdown: /blog/cost-of-running-ai-agent",
    },
    {
      q: "Do I need a terminal open for scheduled tasks to run?",
      a: "No. Install as a system service: hermes gateway install. It starts on boot, runs in the background, no terminal needed. On Hivra this is already set up.",
    },
  ],
  relatedArticles: [
    { slug: "what-can-hermes-agent-actually-do", title: "What can Hermes Agent actually do?" },
    { slug: "hermes-agent-telegram-discord-setup", title: "Hermes Agent gateway: Telegram, Discord, and 13 more" },
    { slug: "hermes-agent-skills-guide", title: "Hermes Agent skills guide" },
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent on a VPS" },
  ],
};
