import type { DocPage } from "../types";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";

export const doc: DocPage = {
  slug: "telegram",
  section: "run",
  title: "Connect Telegram to your agent",
  metaTitle: "Connect Telegram to your Hivra agent",
  metaDescription: "Connect your own Telegram bot to a Claude Code agent, send it work from your phone, and learn who can message it and how to disconnect.",
  summary: "Make a bot with BotFather, paste its token in the agent's Telegram tab, tap Start once, and you can send a Claude Code agent work from your phone.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "What this is and who it is for",
      paragraphs: [
        "Telegram is a second way to reach an agent. Instead of opening the dashboard, you message a Telegram bot that you own, and the message goes to the agent's computer. This page is for developers and AI power users who want to send a job from a phone, or want to keep a conversation with the agent going away from the dashboard.",
        "The Telegram tab connects **your own bot** to a service running on the agent's computer. Hivra does not provide a shared bot. You create the bot with Telegram's @BotFather, so the bot, its name and its token are yours, and you can revoke the token in BotFather at any time.",
        "The Telegram screen says you connect a Telegram bot, message your agent from your phone, and get pinged when work is done. Hivra has not verified how reliably the agent sends a completion message, so count on seeing the agent's replies in your chat with the bot. On the first visit after a fresh launch, a one-line banner on the agent page tells you the agent can reach you when work is done and offers a Connect Telegram button. You can dismiss it (this browser remembers that), and it does not show once Telegram is connected.",
      ],
    },
    {
      heading: "Which agents support it",
      paragraphs: [
        "| Agent | Telegram on Hivra |\n| --- | --- |\n| **Claude Code** | Verified. The Telegram tab connects your bot to the computer, and work you send runs on the computer. |\n| **Codex** | The Telegram view appears on Codex pages, but Hivra has not verified it and does not promise it works there. |\n| **Hermes, OpenClaw, Agent Zero, Aeon and the other dashboard agents** | Hivra shows no Telegram view for them. Hermes and OpenClaw are projects that have their own messaging setup, which you reach through the agent's own interface and its own documentation. |\n| **Computers without an agent** (Ubuntu Desktop, Linux Sandbox) | Hivra offers no Telegram view. |",
        "This page describes the Claude Code flow, the only one Hivra has verified. If you see a Telegram entry on Codex, Hivra has not verified it. See [Claude Code on Hivra](/docs/claude-code) for the rest of that agent, and [Open your agent](/docs/open-an-agent) for how the agent page is laid out.",
      ],
    },
    {
      heading: "Before you start",
      paragraphs: [
        "- **A running Claude Code agent.** Telegram needs the computer to be reachable. If it is not ready yet, the Telegram area shows a \"Not ready\" notice that says the computer isn't reachable yet. Wait for the agent to finish starting and reload.\n- **A Telegram account on your phone or desktop**, so you can talk to @BotFather and later to your own bot.\n- **A browser that can reach Telegram.** Hivra checks your token against Telegram's own API directly from your browser, so a network that blocks api.telegram.org will stop the first step.\n- **A little patience on the connect step.** Saving the bot restarts the connection on the computer, and the page shows a notice while it saves.",
        "You do not need a paid Hivra plan for Telegram itself, but every computer that Hivra Cloud runs needs one. See [What you pay for](/docs/plans-and-billing).",
      ],
    },
    {
      heading: "Connect your bot, step by step",
      paragraphs: [
        "1. Open the agent from **Home**. In the sidebar, open the **Settings** group, then choose **Telegram**. Under **Chat from Telegram** you will see a **Bot token** box.\n2. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its questions for a name and a username. BotFather replies with a token that looks like `123456789:ABC...`.\n3. Copy the whole token and paste it into **Bot token**. It is the only thing you copy.\n4. Press **Continue**. Hivra first asks Telegram who the token belongs to, which also gives it your bot's @username. Then it saves the bot on the computer and restarts the connection. Leave the page open while it works.\n5. When it finishes, the page shows **@yourbot · last step** and a button named **Open @yourbot & tap Start**. Press it. Telegram opens a chat with your bot.\n6. Tap **Start** in Telegram. The dashboard shows \"Waiting for you to tap Start...\" and keeps checking. As soon as the computer reports that your chat is bound, the page flips to the connected view.",
        "The connected view shows your bot's @username and a status of **Bot is running**. Right after connecting it can read **Connected (starting...)** while the service finishes starting. An **Open in Telegram** button takes you to the bot, and the page tells you to send it a message: it reaches your agent.",
        "The Start step matters. The link behind the button carries a one-time setup token. Whoever opens it first and taps Start becomes the owner of the bot. Do it yourself, straight away, from the Telegram account you want to use. The token is single-use and is wiped on the computer once someone binds.",
      ],
    },
    {
      heading: "Who can message your agent",
      paragraphs: [
        "A Telegram bot is public in the sense that anyone who knows its username can open a chat with it. What stops a stranger from driving your agent is the binding step.",
        "- **One owner.** The first chat to redeem the setup link and tap **Start** binds as the owner. The page says anyone else who finds the bot is silently ignored.\n- **Single-use link.** The setup token burns after the first bind, so the link cannot be replayed later.\n- **The owner is a Telegram user id.** The connected view reads the owner id from the computer. Messages from other accounts are not treated as yours.\n- **Your token is yours.** The bot token gives control of the bot itself. If you ever think it leaked, use BotFather's revoke option, then disconnect and reconnect in Hivra with the new token.",
        "Because the bound chat can send the agent work, treat your Telegram account like a login: keep two-step verification on, and do not hand your unlocked phone to someone else. An agent that can run commands on its computer will run what the owner sends. The [Security and access](/docs/security-and-access) page covers the wider picture, and the [Security page](/security) explains why a separate computer is a boundary and not a guarantee that an agent is safe.",
      ],
    },
    {
      heading: "What you can send, and where the work runs",
      paragraphs: [
        "Open your bot in Telegram and send it a message. It reaches your agent, and Claude Code on the computer picks the job up. Write it the way you would write a task in the Chat tab: describe the outcome, name the repo or folder, and say what done looks like.",
        "The important part is where it runs. " + CLI_RUN_LIFETIME + " In practice that means you can send a long job from your phone, close the laptop or the dashboard tab, and the work continues on the computer. The files it changes, and its history, stay on the computer for the next time you open the agent.",
        "| | Chat tab in the browser | Telegram |\n| --- | --- | --- |\n| How you send work | Type in the dashboard | Message your own bot |\n| Where the work runs | Through the agent's session; do not rely on it outliving your tab | On the agent's computer, not in your browser |\n| Needs the dashboard open | Yes, to send and to watch | No, only to set it up |\n| Best for | Watching tool use and files as it goes | Handing off a job and reading the agent's replies in a chat on your phone |",
        "Use Telegram for hand-offs, not for review. To read diffs, browse files or use the terminal, open the agent's **Files** and **Terminal** views, as described in [Open your agent](/docs/open-an-agent). I have not verified what kinds of attachments (photos, voice notes, files) the Telegram service accepts, so plain text is the safe choice.",
        "Model usage follows the same route as the rest of the agent: Claude sign-in or Hivra credits, as set at launch. A Telegram message does not add a separate charge from Hivra. Each message does add model tokens, because the agent has to read it and the context around it. [Choose how your agent gets its model](/docs/models-and-credits) explains the two routes.",
      ],
    },
    {
      heading: "The advanced manual option",
      paragraphs: [
        "Below the pairing step there is a disclosure labelled **Advanced: paste your Telegram id directly (older agents only)**. It skips the Start handshake and writes your numeric Telegram user id straight into the allowlist.",
        "Use it only when the normal flow does not work on this agent. The page checks for about five minutes. If you have not tapped Start by then it shows the notice \"Still waiting on Telegram. Try tapping Start again, or use the advanced manual entry below.\", opens this option, and stops checking. If you tap Start later, reload the Telegram view to see **Bot is running**. If you left the page before tapping, paste the token again to get a fresh Start link. The option also appears after a failed connect attempt and when the computer does not support the pairing link yet.",
        "1. Open the disclosure and find **Your Telegram user id**.\n2. To learn your id, message [@userinfobot](https://t.me/userinfobot) and tap Start. It replies with your numeric id.\n3. Type the digits only into **Your Telegram user id** and press **Connect Telegram**. You still need your bot token in the earlier box, because the page re-uses it.",
        "Only enter your own id. Whoever owns that id can send your agent work, and nothing checks that the id is yours, so a mistyped id can hand control to someone else. A valid id is digits only. If you type anything else, the page says \"Enter your numeric Telegram id (digits only).\" If the token box has been cleared, it says a message starting \"The bot token looks wrong\"",
      ],
    },
    {
      heading: "Disconnect Telegram",
      paragraphs: [
        "1. Open the agent, then **Settings**, then **Telegram**.\n2. Press **Disconnect**. Hivra asks you to confirm instead of acting on one tap. Cancel takes the place of the Disconnect button so a double tap cannot confirm by accident.\n3. Confirm with **Disconnect @yourbot**. The message reads: \"Your agent stops answering on Telegram, and reconnecting needs a bot token from BotFather again.\"",
        "Disconnecting stops the Telegram service on the computer and clears the bot's saved configuration there. Your agent, its files and its other views are not touched.",
        "To be certain the bot can never be used again, also delete or revoke it in @BotFather. Disconnecting in Hivra removes the link from the computer, but the bot still exists in your Telegram account until you remove it there. Reconnecting binds a new owner, so you tap Start again. To connect again later, start from step 1 with a token from BotFather.",
      ],
    },
    {
      heading: "When something goes wrong",
      paragraphs: [
        "| What you see | What it means and what to do |\n| --- | --- |\n| \"That doesn't look like a bot token. Paste the whole token BotFather gave you.\" | The text is not shaped like a token. Copy the entire line from BotFather, including the number, the colon and the long string after it, with no spaces. |\n| \"Telegram rejected that token. Double-check you copied it correctly.\" | Telegram says the token is not valid, or BotFather has since revoked it. Generate or re-send the token in BotFather and paste it again. |\n| \"Couldn't reach Telegram to verify the token. Check your connection and try again.\" | Your browser could not reach api.telegram.org within about eight seconds. This is common on some corporate networks, regional filters or mobile carriers. Try another network or turn off the VPN or filter, then press **Continue** again. |\n| \"Saving is taking longer than expected\" | The page stops waiting after roughly half a minute, even though the restart can take longer. Wait, reload the Telegram tab to see whether it already says **Bot is running**, and only then press **Continue** again. |\n| \"doesn't support the pairing deeplink yet\" | The computer's Telegram service is too old for the Start link. Use the **Advanced** option above, or check [Update your agent](/docs/update-an-agent). |\n| \"Couldn't start the pairing flow. Try again.\" | The computer rejected the save for a reason it did not give. Try once more, then check the computer is running. |\n| \"Waiting for you to tap Start...\" never ends | You have not tapped Start in the chat that opened, or you tapped it in another bot. Use the **Open @yourbot & tap Start** button again. After about five minutes the page shows a notice, opens the manual option and stops checking; reload the Telegram view if you tap Start afterwards. |\n| You tapped Start but nothing binds | Someone else may have used the link first, or the link was already used. Disconnect, reconnect with a fresh token and tap Start yourself. |\n| \"Couldn't disconnect Telegram (...). Your bot is still connected. Try again.\" | The computer could not be reached. The bot is still active. Try again once the agent is running. |\n| The Telegram area says \"Not ready\" | The agent's computer is not reachable yet. Wait for it to finish starting, or open it from Home to check its status. |",
        "If the bot is connected but your messages get no reply, first check the agent is running on Home and that you are messaging your own bot from the account that tapped Start. If Claude Code asks you to sign in again, the work cannot proceed: open **Settings**, then **Overview**, and press **Sign in again**. More general fixes are on the [Troubleshooting](/docs/troubleshooting) page.",
      ],
    },
    {
      heading: "What Hivra does and does not do",
      paragraphs: [
        "- Hivra shows the setup screens, checks your token with Telegram from your browser, and asks the computer to connect your bot.\n- The agent's computer runs the Telegram service. Messages from the bound owner become work for Claude Code, on the computer.\n- Hivra does not create a bot for you and does not own your bot. You do.\n- Hivra does not promise how Telegram itself behaves: Telegram's availability, message limits and rules are Telegram's.\n- Telegram is not end-to-end encrypted for bots, so avoid sending secrets in a chat with your bot. Put credentials on the computer through the Terminal or Files views instead.\n- Hivra is an independent hosting service and is not affiliated with or endorsed by Telegram or Anthropic. Telegram's own terms apply to your bot and your account, and Claude Code is Anthropic's product.",
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need a Telegram bot of my own?",
      a: "Yes. Hivra does not run a shared bot. You make one by messaging BotFather in Telegram, send it the new bot command, and paste the token it gives you into the agent's Telegram tab.",
    },
    {
      q: "Does Telegram work with Codex?",
      a: "The Telegram view appears on Codex pages, but Hivra has not verified it and does not promise it works there. Use the Chat tab or the agent's own session for Codex.",
    },
    {
      q: "Can someone else take over my bot?",
      a: "Only if they tap Start on your setup link before you do. The first chat to tap Start becomes the owner, and the one-time token is wiped after that, so open the link yourself right after pasting your token. Everyone else who finds the bot is ignored.",
    },
    {
      q: "Does the work stop if I close my laptop?",
      a: "No. Work you send to Claude Code through Telegram runs on the agent's computer, not in your browser, so closing the dashboard or the laptop does not end it. On Hivra Cloud, the computer's idle policy depends on how it was launched.",
    },
    {
      q: "How do I disconnect Telegram?",
      a: "Open the agent, go to Settings, then Telegram, and press Disconnect, then confirm. The agent stops answering on Telegram. Reconnecting needs a bot token from BotFather again, and you can also delete the bot in BotFather.",
    },
    {
      q: "Why does connecting seem slow?",
      a: "Saving your bot restarts the connection on the computer, and the page shows a notice while it saves. Leave the page open. If it reports that saving is taking longer than expected, reload the tab and check whether it already says Bot is running.",
    },
    {
      q: "What if I cannot tap the Start link?",
      a: "Use the Advanced option under the pairing step. Message userinfobot in Telegram to get your numeric user id, enter the digits, and press Connect Telegram. It is meant as a fallback for older agents.",
    },
  ],
  next: ["open-an-agent", "security-and-access", "troubleshooting"],
};
