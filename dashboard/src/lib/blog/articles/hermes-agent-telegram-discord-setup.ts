import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "hermes-agent-telegram-discord-setup",
  title: "Hermes Agent gateway setup: Telegram, Discord, WhatsApp, Email and 11 more",
  metaDescription:
    "Complete setup guide for all 15 Hermes Agent messaging gateways. Covers Telegram bot creation, Discord slash commands, WhatsApp via Baileys bridge, Email IMAP/SMTP config, Webhooks, and security via DM pairing codes and allowlists.",
  publishedDate: "2026-04-15",
  lastModified: "2026-04-15",
  readingTimeMin: 13,
  author: "Hivra team",
  tagline: "The README says 12+ platforms. It's actually 15. Here's how to set up each one.",
  intro:
    "Hermes Agent receives messages and sends responses through 15 platforms: Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Open WebUI, and Webhooks. This covers practical setup for the most commonly used gateways, the security model that applies to all of them, and the tradeoffs worth knowing before you connect anything.",
  sections: [
    {
      heading: "How the gateway works",
      paragraphs: [
        "A single `hermes gateway` process handles all connected platforms simultaneously. You run it once and it listens on all configured channels — delivering messages to the agent, running the inference loop, and sending responses back to the originating platform.",
        "Security is opt-in per platform. Every platform has an `ALLOWED_USERS` environment variable that acts as an allowlist. Without it, the gateway accepts messages from anyone who finds your bot. That is a serious problem for an agent with shell access. Set allowlists before exposing any gateway publicly.",
        "The alternative to manual allowlists is DM pairing codes: unknown users message your bot and receive a one-time pairing code that expires after one hour. You approve it with `hermes pairing approve <platform> <code>`. More scalable than maintaining a static list if you have multiple users.",
      ],
    },
    {
      heading: "Telegram",
      paragraphs: [
        "Telegram is the most commonly used Hermes gateway. Setup:\n\n1. Message @BotFather in Telegram → send `/newbot` → follow prompts → copy the token\n2. Message @userinfobot to get your numeric user ID\n3. Add to `~/.hermes/.env`:\n\n```bash\nTELEGRAM_BOT_TOKEN=1234567890:AAF...\nTELEGRAM_ALLOWED_USERS=123456789\n# Multiple users: TELEGRAM_ALLOWED_USERS=123456789,987654321\n```\n\n4. Test it: `hermes gateway`\n5. Install as service: `hermes gateway install`\n\nOr use the interactive wizard:\n\n```bash\nhermes gateway setup\n```",
        "For webhook mode instead of long-polling (more reliable, lower latency):\n\n```bash\nTELEGRAM_WEBHOOK_URL=https://your-domain.com/webhooks/telegram\n```\n\nWebhook mode requires a public HTTPS endpoint. Long-polling works fine for personal use without a domain.\n\nGroup chat access is disabled by default. To enable it: add `TELEGRAM_ALLOW_GROUPS=true` and be aware that everyone in the group who is in your allowlist can issue commands.",
      ],
    },
    {
      heading: "Discord",
      paragraphs: [
        "Discord support includes slash commands, thread responses, and voice channel transcription. Setup:\n\n1. Go to discord.com/developers/applications → New Application → name it\n2. Bot tab → Add Bot → copy the token\n3. OAuth2 tab → URL Generator → select `bot` and `applications.commands` scopes, `Send Messages` + `Read Message History` + `Use Slash Commands` permissions → copy the generated URL and visit it to add the bot to your server\n4. Enable Message Content Intent in the Bot tab (required for reading messages)\n5. Add to `.env`:\n\n```bash\nDISCORD_BOT_TOKEN=MTq...\nDISCORD_ALLOWED_USERS=123456789012345678  # Discord user ID (18 digits)\nDISCORD_ALLOWED_GUILDS=987654321098765432  # Optional: restrict to specific server\n```",
        "Discord voice channel integration uses voice recognition to transcribe speech and pass it to the agent. Install the voice dependencies first:\n\n```bash\nhermes install --extras voice\n```\n\nFor slash commands to appear, the bot registers them automatically on first connection. If they do not appear, kick and re-add the bot to the server to force command re-registration.",
      ],
    },
    {
      heading: "WhatsApp",
      paragraphs: [
        "WhatsApp integration uses the Baileys library — an unofficial bridge that emulates the WhatsApp Web session protocol. No Meta developer account required.\n\nSetup:\n\n```bash\nhermes whatsapp\n```\n\nThe wizard installs the Baileys bridge dependencies (requires Node.js v18+), displays a QR code, and you scan it: WhatsApp → Settings → Linked Devices → Link a Device. Session saves automatically.\n\nTwo modes: a **separate bot number** (dedicate a phone number to the bot — lower ban risk, cleaner UX for multiple users) or **personal self-chat** (use your own WhatsApp number, message yourself to talk to the agent — easier to set up, more account risk).",
        "The main risk: WhatsApp's terms prohibit unofficial automation. For personal use, ban risk is low. For anything resembling bulk messaging or outreach to people who have not opted in, the risk is significant. The official WhatsApp Business API (which Hermes does not use) is the compliant path for business use.",
      ],
    },
    {
      heading: "Email",
      paragraphs: [
        "The email gateway uses standard IMAP (inbound) and SMTP (outbound). No external libraries.\n\nFor Gmail:\n\n```bash\n# First: Enable 2FA on your Google account\n# Then: myaccount.google.com/apppasswords → create app password for Mail\n\nEMAIL_ADDRESS=hermes@gmail.com\nEMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx  # 16-char app password, NOT your Gmail password\nEMAIL_IMAP_HOST=imap.gmail.com\nEMAIL_SMTP_HOST=smtp.gmail.com\nEMAIL_ALLOWED_USERS=you@yourdomain.com,colleague@work.com\n```\n\nFor Outlook/Microsoft 365:\n\n```bash\nEMAIL_IMAP_HOST=outlook.office365.com\nEMAIL_SMTP_HOST=smtp.office365.com\n# App password: account.microsoft.com/security → Additional security options\n```\n\nPorts default to IMAP 993 (TLS) and SMTP 587 (STARTTLS). Override with `EMAIL_IMAP_PORT` and `EMAIL_SMTP_PORT` if needed.\n\nUse a dedicated email account, not your personal inbox. The gateway reads and processes all incoming email to that address.",
      ],
    },
    {
      heading: "Webhooks",
      paragraphs: [
        "The webhook gateway runs an HTTP server on port 8644 and accepts POST requests, connecting Hermes to any service that sends webhooks: GitHub, GitLab, JIRA, Stripe, or custom triggers.\n\n```bash\nWEBHOOK_ENABLED=true\nWEBHOOK_PORT=8644\nWEBHOOK_SECRET=your-global-secret  # Used for HMAC signature validation\n```\n\nCreate a named route:\n\n```bash\nhermes webhook subscribe\n```\n\nEndpoint format: `http://your-server:8644/webhooks/<route-name>`\n\nHealth check: `curl http://localhost:8644/health`\n\nCommon uses: receive GitHub PR review requests for the agent to summarize, process JIRA ticket updates, handle Stripe payment events and trigger follow-up tasks. The agent receives the webhook payload, interprets it, and can use any of its tools in response.",
      ],
    },
    {
      heading: "The full list: all 15 platforms",
      paragraphs: [
        "The complete gateway list confirmed in the official documentation (15 total, not 12 as the README states):\n\n1. **Telegram** — most popular, long-polling or webhook mode\n2. **Discord** — slash commands, voice channel, thread support\n3. **Slack** — Slack app with OAuth, works in DMs and channels\n4. **WhatsApp** — Baileys bridge, unofficial\n5. **Signal** — requires Signal CLI installed and linked phone number\n6. **SMS** — Twilio integration, sends/receives SMS\n7. **Email** — IMAP/SMTP, any provider\n8. **Home Assistant** — integrates directly as a conversation agent\n9. **Mattermost** — self-hosted Slack alternative\n10. **Matrix** — decentralized messaging protocol (Element, etc.)\n11. **DingTalk** — Alibaba's enterprise messaging platform\n12. **Feishu/Lark** — ByteDance enterprise messenger\n13. **WeCom** — Tencent's enterprise WeChat variant\n14. **Open WebUI / API Server** — HTTP API endpoint for custom frontends\n15. **Webhooks** — generic HTTP webhook receiver",
        "All gateways share the same security model: `ALLOWED_USERS` allowlist or DM pairing code approval. `GATEWAY_ALLOWED_USERS` applies across all connected platforms as a global setting. Per-platform variables override it. `GATEWAY_ALLOW_ALL_USERS=true` accepts messages from anyone — do not set this on a gateway with shell access.",
      ],
    },
    {
      heading: "Running multiple gateways simultaneously",
      paragraphs: [
        "One `hermes gateway` process handles all configured platforms. Set credentials for Telegram and Discord both, and the same agent responds on both channels with shared memory and context. A message from Telegram and a message from Discord reach the same agent — your task history and preferences persist regardless of which platform you are messaging from.",
        "The built-in cron scheduler runs inside the gateway process and can deliver to any connected platform. A morning briefing goes to Telegram, a work-hours alert to Slack, an end-of-day summary to Email — all from the same scheduled task configuration.\n\nToken usage is higher through messaging gateways than CLI. Telegram adds roughly 15,000-20,000 tokens of overhead per message (versus 6,000-8,000 in CLI) due to AGENTS.md workspace files and additional context. At Sonnet 4.6 pricing, that is approximately $0.03-0.06 per message in overhead alone. Disable unused tool categories with `hermes tools` to reduce the baseline cost.",
      ],
    },
    {
      heading: "Hivra gateway setup",
      paragraphs: [
        "On Hivra, gateway configuration is handled through the dashboard — paste your Telegram bot token and user ID, click connect, done. The gateway service is managed, monitored, and restarted automatically. You do not need the `hermes gateway install` → `systemctl` → `loginctl enable-linger` sequence.\n\nAll 15 gateways are available on Hivra. Multi-gateway setup (Telegram + Discord + Email simultaneously) works by adding credentials for each platform in the dashboard.",
      ],
    },
  ],
  faqs: [
    {
      q: "How many messaging platforms does Hermes Agent support?",
      a: "15, as of April 2026. The GitHub README says '12+', but the official documentation lists 15 distinct integrations: Telegram, Discord, Slack, WhatsApp, Signal, SMS (Twilio), Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Open WebUI/API Server, and Webhooks.",
    },
    {
      q: "Can I run Telegram and Discord at the same time on the same agent?",
      a: "Yes. A single `hermes gateway` process handles all configured platforms. Set credentials for both in ~/.hermes/.env and the agent responds on both channels simultaneously with shared memory and context.",
    },
    {
      q: "Is the WhatsApp integration official?",
      a: "No. It uses the Baileys library, which emulates the WhatsApp Web session protocol. No Meta developer account is required, but the integration violates WhatsApp's terms. For personal use, ban risk is low. For business use requiring compliance, the official WhatsApp Business API is the correct path.",
    },
    {
      q: "How do I prevent strangers from using my Hermes bot?",
      a: "Set the ALLOWED_USERS variable for each platform: TELEGRAM_ALLOWED_USERS=your-numeric-id, DISCORD_ALLOWED_USERS=your-18-digit-id, etc. Alternatively, use DM pairing codes — unknown users receive a one-time code that you approve with `hermes pairing approve <platform> <code>`. Never set GATEWAY_ALLOW_ALL_USERS=true on an agent with shell access.",
    },
    {
      q: "Why does my agent use more API tokens through Telegram than the CLI?",
      a: "Messaging gateways load additional context files (AGENTS.md, workspace files) per message, adding roughly 15,000-20,000 tokens of overhead versus the CLI's 6,000-8,000. Reduce this with `hermes tools` to disable tool categories you don't use through that gateway.",
    },
    {
      q: "Can Hermes Agent respond in voice on Discord?",
      a: "Yes. Discord voice channel integration uses speech recognition to transcribe voice input and pass it as text to the agent. Text-to-speech output back into the voice channel is also supported with additional TTS provider configuration. Install voice dependencies with: hermes install --extras voice",
    },
  ],
  relatedArticles: [
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent on a VPS" },
    { slug: "hermes-agent-memory-system-explained", title: "Hermes Agent memory explained: SOUL.md, MEMORY.md, sessions, and Honcho" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026: Hetzner vs DigitalOcean vs OVH" },
    { slug: "hermes-vs-openclaw", title: "Hermes Agent vs OpenClaw: a direct comparison" },
  ],
};
