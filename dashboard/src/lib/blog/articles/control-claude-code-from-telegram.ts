import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "control-claude-code-from-telegram",
  title: "How to control Claude Code from Telegram",
  metaTitle: "Control Claude Code From Telegram",
  metaDescription:
    "Connect Claude Code to Telegram with Anthropic's official channel plugin. Follow the setup, pairing, security, persistence, and troubleshooting steps.",
  publishedDate: "2026-09-03",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "Send tasks from your phone while Claude Code works on the machine holding your repository.",
  intro:
    "Claude Code can receive messages from Telegram through Anthropic's official Telegram channel plugin. You create a bot, install and configure the plugin, start Claude Code with channels enabled, then pair your Telegram account. The session still runs on your computer or server, so that machine and the Claude Code process must stay online.",
  sections: [
    {
      heading: "The short answer",
      paragraphs: [
        "The supported route is Claude Code Channels. A channel is an MCP server that pushes an incoming Telegram message into the Claude Code session already running on your machine. Claude can act on your real repository and reply through the bot. Anthropic currently labels Channels as a research preview, so check the [official Channels documentation](https://code.claude.com/docs/en/channels) before setup for current requirements.",
        "You need a recent Claude Code release (the Channels documentation lists the current requirements), Bun, a Telegram account, and a bot token created through BotFather. Channels work with claude.ai authentication or an Anthropic Console API key. Team and Enterprise administrators must enable Channels for their organisation. Pro and Max users without an organisation can opt in per session.",
        "Telegram does not move Claude Code onto your phone. Your phone becomes an input and reply surface. The code, tools, permissions, and active session remain on the host machine. If that machine sleeps, restarts without recovering the process, or exits Claude Code, the bot stops receiving work.",
      ],
    },
    {
      heading: "Before you connect Telegram",
      paragraphs: [
        "Update Claude Code and confirm it starts normally in the repository you want it to control. Then install Bun, because Anthropic's Telegram channel server runs on Bun. Keep the terminal open while you complete the setup. You will restart Claude Code after the plugin is configured.",
        "Decide where the session should live. A laptop works while it is awake. An always-on desktop, home server, VPS, or private cloud VM is better if you expect messages to work at any hour. If you use a remote host, run Claude Code inside tmux or under another recovery setup so an SSH disconnect does not kill the session. The guide to [keeping Claude Code running 24/7](/blog/keep-claude-code-running-24-7) covers that part.",
        "Treat the Telegram bot as a remote control for a coding agent. Anyone admitted to the channel can send instructions into a session that may read files, run commands, and request permission for more. Use a dedicated bot. Do not add it to a public group. Pair only your own account first.",
      ],
    },
    {
      heading: "Step 1: create a Telegram bot",
      paragraphs: [
        "Open Telegram and start a direct chat with `@BotFather`. Send `/newbot`. BotFather asks for a display name and then a unique username that ends in `bot`. When creation succeeds, it returns a bot token. That token controls the bot, so store it like a password and never commit it to your repository.",
        "You do not need to expose a public port or configure a webhook for the official plugin. The Telegram channel polls Telegram from the same machine that runs Claude Code. This is useful on a home connection or private VM because there is no inbound web server to publish.",
        "If the token leaks, return to BotFather and revoke it. Pairing restricts which sender IDs reach Claude Code, but a stolen bot token still gives another person control of the bot account. Keep both layers: a private token and a narrow sender allowlist.",
      ],
    },
    {
      heading: "Step 2: install and configure the official plugin",
      paragraphs: [
        "Start Claude Code, then install Anthropic's official Telegram plugin from inside the session:\n\n```text\n/plugin install telegram@claude-plugins-official\n```\n\nIf Claude Code reports that the `claude-plugins-official` marketplace is not found, add it with `/plugin marketplace add anthropics/claude-plugins-official`, then retry the install. When the install asks for a scope, the user scope makes the plugin available in all your projects.",
        "If the install summary asks you to reload, run this so the Telegram commands become available:\n\n```text\n/reload-plugins\n```\n\nNow configure the bot token you received from BotFather:\n\n```text\n/telegram:configure YOUR_BOT_TOKEN\n```\n\nThe official plugin stores this in `~/.claude/channels/telegram/.env`. Anthropic also supports setting `TELEGRAM_BOT_TOKEN` in the environment before Claude Code starts. Do not put the token in a tracked `.env` file inside your project.",
        "Exit that Claude Code session after configuration. The plugin can be installed correctly without receiving messages yet. Incoming events only start after you relaunch Claude Code with the channel explicitly enabled.",
      ],
    },
    {
      heading: "Step 3: start Claude Code with Telegram enabled",
      paragraphs: [
        "From the repository you want Claude Code to work in, run:\n\n```bash\nclaude --channels plugin:telegram@claude-plugins-official\n```\n\nThis starts Claude Code and the Telegram channel server together. Leave the process running. Opening a normal `claude` session without the `--channels` option will not receive Telegram messages, even though the plugin and token remain configured.",
        "For a persistent remote setup, launch that command inside tmux:\n\n```bash\ntmux new -s claude-telegram\nclaude --channels plugin:telegram@claude-plugins-official\n```\n\nDetach with `Ctrl+b`, then `d`. Later, reconnect with `tmux attach -t claude-telegram`. Tmux protects the session from an SSH disconnect, but it does not survive a machine reboot by itself. Use a service manager if automatic recovery after reboot matters.",
        "Channels inject events into one running session. They do not create a fresh cloud task for every Telegram message. That means your current working directory, repository state, instructions, and conversation context stay attached to the session you started.",
      ],
    },
    {
      heading: "Step 4: pair your Telegram account and lock access",
      paragraphs: [
        "Open the bot in Telegram and send it any message. While the channel-enabled Claude Code session is running, the bot replies with a pairing code. Return to Claude Code and approve that code:\n\n```text\n/telegram:access pair YOUR_PAIRING_CODE\n```\n\nThen set the access policy to an allowlist:\n\n```text\n/telegram:access policy allowlist\n```\n\nYour Telegram sender ID is now the identity allowed to push messages into the session. Unapproved senders are dropped.",
        "Test with a read-only request first. Ask Claude to report the current repository name, branch, and working tree status without changing files. Confirm the response appears in Telegram and matches the host. Next, try a small task that produces a diff but does not commit or publish anything. Review it from the terminal before granting broader authority.",
        "Permission relay deserves extra care. A paired sender may be able to approve or deny tool use from Telegram when the channel supports it. That is powerful, but it also means control of your phone or Telegram account can become control of the agent. Keep device lock and Telegram two-step verification enabled. Never pair a shared account with a session that holds production credentials.",
      ],
    },
    {
      heading: "What works from Telegram, and what does not",
      paragraphs: [
        "Once paired, you can send a coding request, receive Claude's reply, and continue the same conversation from your phone. The session has the same tools and repository access it had in the terminal. This is useful for checking progress, answering a question, reacting to an alert, or sending the next bounded task while away from your desk.",
        "The bot only works while that Claude Code session is open and Channels are enabled. It cannot wake a sleeping laptop. It does not automatically restart Claude Code after a host reboot. It also does not make every task safe to approve remotely. Database migrations, production deploys, secret rotation, billing changes, and destructive commands still deserve a larger screen and deliberate review.",
        "You may see a tool-call confirmation in the terminal while the actual response text appears only in Telegram. That is expected for channel replies. If you want to drive the exact terminal interface from a browser instead, Hivra's [Claude Code agent](/agents/claude-code) provides browser access to chat, terminal, and files. Hivra's Claude Code box also has its own Telegram connect, in the agent's Telegram tab, which runs on the box without the plugin setup. Anthropic's channel plugin described here is the route when you host Claude Code yourself.",
      ],
    },
    {
      heading: "Troubleshooting when the bot does not reply",
      paragraphs: [
        "Check the setup in this order:\n\n1. Run `claude --version` and confirm it meets the version in Anthropic's current Channels documentation.\n2. Confirm Bun is installed with `bun --version`.\n3. Make sure you relaunched with `--channels plugin:telegram@claude-plugins-official`.\n4. Confirm the bot token belongs to the same bot you are messaging.\n5. Refresh the official plugin marketplace, update the plugin, and reload plugins.\n6. Pair again if the sender is not in the allowlist.\n7. If you use a Team or Enterprise organisation, ask an admin to confirm Channels are enabled.",
        "A Telegram bot cannot use long polling and an outgoing webhook at the same time. If the same token was previously connected to another service, that webhook or poller may consume messages before the Claude Code plugin sees them. Use a fresh dedicated bot token to remove that conflict.",
        "Research preview features can change and can have release-specific faults. If your configuration matches the official guide but inbound messages still fail, check the current Claude Code and official plugin issue trackers before rebuilding the setup yourself. Record the Claude Code version, plugin version, operating system, and whether outbound replies work. Those details separate an access problem from a channel runtime bug.",
      ],
    },
    {
      heading: "Keep the host online without running another laptop",
      paragraphs: [
        "Telegram is only the control surface. Reliable remote use still depends on a machine that stays online, a recoverable Claude Code process, and sensible permission boundaries. You can assemble that on a VPS with tmux and a service manager. Keep the bot token outside the repository and isolate the agent from unrelated personal files.",
        `If you want the host managed for you, [Hivra](/agents/claude-code) launches the official Claude Code CLI on a private VM and lets you use your own Anthropic login. You can reach the box from a phone browser and manage chat, terminal, and files there, and the agent's Telegram tab connects your own bot: paste the BotFather token, open the pairing link, and messages to the bot run as work on the box, so they keep going after you close the laptop. Plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. Compare the options on the [pricing page](/pricing). You can still configure Anthropic's Telegram channel inside that machine instead if you prefer the official plugin and the current Claude Code and plugin requirements are met. Hivra is independent and is not affiliated with Anthropic.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Can I control Claude Code from Telegram?",
      a: "Yes. Anthropic provides an official Telegram channel plugin for Claude Code. Install the plugin, configure a BotFather token, restart Claude Code with the Telegram channel enabled, and pair your Telegram account. Channels are currently a research preview.",
    },
    {
      q: "Does Claude Code keep running if I close my laptop?",
      a: "No. Telegram is a remote control for the Claude Code session running on your host. If the laptop sleeps or the process exits, the bot stops receiving work. Use an always-on machine and a persistent process setup for dependable access.",
    },
    {
      q: "Do I need to open a port for the Telegram channel?",
      a: "No. The official Telegram plugin polls Telegram from the Claude Code host, so it does not require a public inbound port or webhook. Do not reuse a token that another poller or webhook is already using.",
    },
    {
      q: "Is it safe to approve Claude Code actions from Telegram?",
      a: "Only with tight access controls. Pair your own account, use the sender allowlist, secure your phone and Telegram account, and keep Claude Code permissions narrow. Do not remotely approve destructive or production actions without reviewing the exact command and impact.",
    },
    {
      q: "Why does my Telegram bot not reply?",
      a: "The common causes are an old Claude Code version, missing Bun, launching without the channels flag, a wrong token, an unpaired sender, an organisation policy that blocks Channels, or another webhook or poller consuming updates for the same bot.",
    },
    {
      q: "Does Hivra connect Claude Code to Telegram automatically?",
      a: "Hivra's Claude Code box has its own Telegram connect in the agent's Telegram tab: paste a bot token from BotFather, open the pairing link, and messages to the bot run on the box. It is not automatic, since you bring your own bot. The setup in this guide, Anthropic's official channel plugin, is the route when you host Claude Code yourself.",
    },
  ],
  relatedArticles: [
    {
      slug: "keep-claude-code-running-24-7",
      title: "How to keep Claude Code running 24/7",
    },
    {
      slug: "ai-agent-dies-terminal-closes-fixes",
      title: "Why your AI agent dies when you close the terminal",
    },
    {
      slug: "is-it-safe-to-leave-an-ai-agent-running-unattended",
      title: "Is it safe to leave an AI agent running unattended?",
    },
    {
      slug: "ai-agent-hosting-guide",
      title: "AI agent hosting: home hardware, VPS, serverless, and managed",
    },
  ],
  relatedFeatures: [
    { slug: "persistent-memory", title: "Persistent memory" },
    { slug: "scheduled-tasks", title: "Scheduled tasks" },
  ],
};
