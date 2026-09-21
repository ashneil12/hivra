import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "how-to-set-up-hermes-agent-telegram",
  title: "How to connect Hermes Agent to Telegram (step by step)",
  metaDescription:
    "A complete walkthrough for connecting Hermes Agent to Telegram. From creating a bot with BotFather to sending your first message — every step shown, with troubleshooting for the common errors.",
  publishedDate: "2026-04-21",
  lastModified: "2026-04-21",
  readingTimeMin: 7,
  author: "Hivra team",
  tagline: "From zero to talking to your agent on your phone.",
  intro:
    "Most people who run Hermes Agent use Telegram as their main interface. You message the bot from your phone like you'd message anyone, and the agent responds. Getting this set up takes about 10 minutes.",
  sections: [
    {
      heading: "What you need first",
      paragraphs: [
        "- A Telegram account ([download here](https://telegram.org/) if you don't have one — it's free)\n- Hermes Agent installed ([self-hosted](/blog/how-to-self-host-hermes-agent) or via [Hivra](/), which handles Telegram setup through the dashboard)\n- Your Telegram User ID — you'll get this in step 2",
      ],
    },
    {
      heading: "Step 1: Create your bot with BotFather",
      paragraphs: [
        "BotFather is Telegram's official tool for creating other bots. Open Telegram, search for **@BotFather** — it has a blue verified checkmark — and send it: `/newbot`\n\nIt asks for:\n1. A name for your bot (display name, anything you like — 'My Hermes Agent')\n2. A username (must end in `bot`, must be unique across Telegram — 'myhermesagent_bot')\n\nOnce created, BotFather sends your **bot token**. It looks like: `1234567890:AAFxxxxxxxxxxxxxxxxxx`\n\nCopy it somewhere safe.",
        "**Keep the bot token private.** Anyone with this token controls your bot. Don't paste it into chat, don't commit it to a public repo, don't include it in screenshots.\n\nIf you think it's been compromised: BotFather → `/mybots` → select your bot → API Token → Revoke. Generates a new token instantly, invalidates the old one.",
      ],
    },
    {
      heading: "Step 2: Find your Telegram User ID",
      paragraphs: [
        "Your User ID is a number, not your @username. It's how Hermes knows which accounts to respond to.\n\nOpen Telegram, search for **@userinfobot**, and send it any message. It replies with your numeric User ID — something like `123456789`.\n\nIf you want multiple people to use your bot, collect all their User IDs now.",
        "This matters because without an allowlist, anyone who finds your bot can send it commands. Hermes has access to your server's filesystem and terminal. Setting the User ID allowlist is the main security step — everything else is configuration.",
      ],
    },
    {
      heading: "Step 3: Add credentials to Hermes",
      paragraphs: [
        "Open the Hermes environment file:\n\n```bash\nnano ~/.hermes/.env\n```\n\nAdd these two lines:\n\n```\nTELEGRAM_BOT_TOKEN=1234567890:AAFxxxxxxxxxxxxxxxxxx\nTELEGRAM_ALLOWED_USERS=123456789\n```\n\nMultiple users:\n\n```\nTELEGRAM_ALLOWED_USERS=123456789,987654321\n```\n\nSave (in nano: Ctrl+O → Enter → Ctrl+X). Or run the interactive wizard which handles all of this:\n\n```bash\nhermes gateway setup\n```",
      ],
    },
    {
      heading: "Step 4: Start the gateway",
      paragraphs: [
        "Test it first:\n\n```bash\nhermes gateway\n```\n\nYou should see output showing the Telegram listener started. Open Telegram, find your bot by username, send it something — 'Hello' or 'What can you do?'\n\nIf it responds, it's working. Press Ctrl+C to stop the test.\n\nNow install it as a background service:\n\n```bash\nhermes gateway install\nhermes gateway start\nhermes gateway status\n```\n\nFrom this point the gateway runs in the background. Close the terminal. Messages sent to your bot on Telegram reach the agent, it runs the task, it replies.",
      ],
    },
    {
      heading: "If messages don't arrive",
      paragraphs: [
        "**Bot doesn't respond at all:**\n- Check the gateway is running: `hermes gateway status`\n- Verify the bot token is complete (no truncation, no trailing space)\n- Confirm your User ID is in `TELEGRAM_ALLOWED_USERS` — it's a number, not your @username\n\n**Error: 'Unauthorized':**\n- Bot token is wrong or revoked. Check it in BotFather: `/mybots` → your bot → API Token.\n\n**Error: 'User not in allowlist':**\n- Your User ID isn't in the list. Double-check with @userinfobot that you got the right number.\n\n**Gateway starts then crashes:**\n- Check logs: `journalctl --user -u hermes-gateway -f` (Linux with systemd)\n- Or: `tail -f ~/.hermes/logs/gateway.log`",
      ],
    },
    {
      heading: "Optional: use a dedicated phone number",
      paragraphs: [
        "If you already use Telegram bots for other things, consider creating a completely separate Telegram account just for Hermes. Separate phone number, separate identity.\n\nBenefits: cleaner notification management, lower risk to your personal account, easier to share with colleagues. Not required for personal use — this is mainly worth it if you're running it for a team.",
      ],
    },
    {
      heading: "What to say to it",
      paragraphs: [
        "Once connected, just message it. Some starting points:\n\n- 'What can you do?' — lists capabilities and installed skills\n- 'Remember that my name is [name] and I work as a [role]' — seeds the memory file\n- 'Check if google.com is reachable' — tests tool execution\n- 'Send me a Telegram message every weekday at 8am with a brief weather summary for [city]' — sets up a scheduled task\n\nFor a broader look at what people use it for day to day: [12 real use cases here](/blog/what-can-hermes-agent-actually-do). For connecting other platforms alongside Telegram: [the full gateway guide](/blog/hermes-agent-telegram-discord-setup).",
      ],
    },
    {
      heading: "On Hivra",
      paragraphs: [
        "If you're using [Hivra](/) instead of self-hosting, Telegram setup is in the dashboard. Paste your bot token and User ID, click save. No SSH, no .env editing, no terminal.",
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need to install Telegram on the server?",
      a: "No. Telegram is on your phone. The Hermes gateway connects to Telegram's API over the internet — no Telegram installation on the server itself.",
    },
    {
      q: "Can I use the same Telegram bot with two Hermes instances?",
      a: "No. One bot token, one gateway at a time. Two separate Hermes instances need two separate bots — each with their own token from BotFather.",
    },
    {
      q: "Is there a message rate limit?",
      a: "Telegram limits bots to roughly 30 messages/second to different users, 1/second to the same user. For personal use this never matters. Hermes handles standard rate limiting automatically.",
    },
    {
      q: "What if I want to use it in a group chat?",
      a: "Group access is off by default. Enable with TELEGRAM_ALLOW_GROUPS=true. Anyone in the group who's on your allowlist can send it commands — worth thinking through before enabling.",
    },
    {
      q: "Can anyone find my bot and use it?",
      a: "They can find it by username search, but Hermes will not respond to User IDs not in TELEGRAM_ALLOWED_USERS. Unknown users get no response. Alternatively, enable DM pairing (hermes pairing) — unknown users get a time-limited code you approve before they get access.",
    },
  ],
  relatedArticles: [
    { slug: "hermes-agent-telegram-discord-setup", title: "All 15 Hermes Agent gateways: full setup guide" },
    { slug: "what-can-hermes-agent-actually-do", title: "What can Hermes Agent actually do?" },
    { slug: "hermes-agent-cron-scheduled-tasks", title: "Hermes Agent scheduled tasks" },
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent on a VPS" },
  ],
};
