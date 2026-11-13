// Catalog entry for the bot connect wizard (/tools/telegram-discord-bot-setup). Type-only import from the
// catalog: the catalog imports the entries, so a value import here would be a cycle.

import type { ToolEntry } from "../tool-catalog";
import {
  BOT_CONNECT_FACTS,
  MINIMAL_PERMISSIONS,
  THREAD_PERMISSIONS,
  buildInviteUrl,
  checkTelegramToken,
} from "./bot-connect-wizard";

/** A made-up application id for the worked examples. It is not a real application. */
export const EXAMPLE_APPLICATION_ID = "123456789012345678";
/** A made-up token shape: 10 digits, a colon, then 35 characters. Built, never a real credential. */
export const EXAMPLE_TELEGRAM_SHAPE = `${"1".repeat(10)}:${"A".repeat(35)}`;

export const BOT_CONNECT_WIZARD_ENTRY: ToolEntry = {
  slug: "telegram-discord-bot-setup",
  name: "Bot Connect Wizard",
  h1: "Connect your AI agent to Telegram or Discord",
  subhead:
    "Step by step: make the Telegram or Discord bot, get the token, build the Discord invite link, check the token's shape and see where Hermes and OpenClaw take it.",
  metaTitle: "Telegram and Discord Bot Setup for Your AI Agent",
  browserTitle: "Telegram and Discord Bot Setup for Your AI Agent | Hivra",
  metaDescription:
    "How to create a Telegram bot or a Discord bot, get its token, find your user id and build the invite link, then paste it into Hermes or OpenClaw.",
  intro: {
    lede: "To talk to an AI agent from your phone, it needs a bot account on the chat app. Making that account is free on both Telegram and Discord. What trips people up is a short list of details: which token goes where, which switch to turn on, and which id to allow.",
    body: [
      "Pick Telegram or Discord and the wizard walks you through the steps in order. On Telegram you talk to BotFather, copy the token, find your own user id and decide what to do about groups. On Discord you create an application, turn on the Message Content intent, tick the permissions the bot needs, and get an invite link with the permission number worked out for you.",
      "A token checker tells you whether what you copied has the right shape. It runs in your browser and sends nothing. The last step shows where Hermes and OpenClaw read the token, with the exact command or file from their own docs, and says so plainly where we could not confirm one.",
    ],
    note: "A bot token is a password for the bot. Anyone who has it controls the bot. Do not paste a real one into a site you do not trust, and if one leaks, revoke it straight away. The wizard has a step for that.",
  },
  faqs: [
    {
      q: "How do I create a Telegram bot?",
      a: "Open a chat with @BotFather in Telegram and send /newbot. It asks for a name and then a username, which must end in bot. When you finish it gives you the bot's token. Telegram's docs say anyone with the token can control the bot, so keep it private. To change the bot's name, picture or settings later, send /mybots and pick the bot.",
    },
    {
      q: "What does a Telegram bot token look like?",
      a: "Digits, a colon, then a string of letters, digits, underscores and hyphens. Telegram's own docs show 110201543 then a colon then 34 characters. The checker on this page treats 35 characters after the colon as the expected length. Telegram does not publish a fixed length, so a token that differs may still work. The checker only reads the shape. It cannot tell you whether a token is live.",
    },
    {
      q: "How do I make a Discord bot and get its token?",
      a: "In the Discord Developer Portal, create an application. New applications already have a bot user. Open the Bot page, choose Reset Token and copy the result. Discord shows it once, so store it somewhere safe straight away, such as a password manager. Then use the invite link step on this page to add the bot to your server.",
    },
    {
      q: "Which Discord intents does an AI agent need?",
      a: "Message Content. Without it Discord sends empty message text for most guild messages, with exceptions for messages that mention the bot and direct messages. Both Hermes and OpenClaw tell you to turn it on. Server Members is needed if you allow people by username or by role. Presence is optional. All three are switches on the Bot page of the Developer Portal. While a bot is in fewer than 100 servers you only have to switch them on. Past that, Discord requires verification and approval for each.",
    },
    {
      q: "How do I build the Discord invite link?",
      a: "Use the authorize address with your Application ID as client_id, the scope bot, and a permissions number that is the sum of the permission bits you want. The tool above does the sum. The link it builds uses scope=bot%20applications.commands, which is the bot scope plus the slash commands scope that Hermes and OpenClaw both list. The Application ID is on the General Information page, not on the Bot page.",
    },
    {
      q: "What if my bot token leaked?",
      a: "Replace it at once. On Telegram, send /revoke to BotFather and pick the bot. Telegram's docs name /token for a compromised token, so use that if /revoke is not offered. On Discord, reset the token on the Bot page. Then put the new token in your agent, restart it, and remove the old one from everywhere it was saved. A token that was ever in a public repository counts as leaked even if you deleted it, because the history keeps it.",
    },
    {
      q: "How do I find my Telegram or Discord user id?",
      a: "Discord: turn on Developer Mode under Settings, then Advanced, and right-click your name and choose Copy User ID. Telegram: Hermes' guide suggests messaging a bot such as @userinfobot, which replies with your numeric id. Those are third-party bots, not Telegram's, so use them only for this and never send them a token. Agents use the id as an allowlist, so only you can talk to the bot.",
    },
    {
      q: "Why does my Telegram bot ignore messages in a group?",
      a: "Privacy mode. Telegram turns it on by default for every bot, except bots that are admins of the group. With it on the bot sees commands addressed to it and replies to its own messages, not the rest. To change that, send /mybots to BotFather, pick the bot, then Bot Settings, then Group Privacy, and turn it off. Telegram says the bot must be re-added to the group for the change to take effect. Making the bot a group admin also works. Only do either if the agent needs to read everything said in the group.",
    },
    {
      q: "Is it safe to type a token into this page?",
      a: "The page does not send it anywhere. The check runs in your browser, the token is not stored and it never goes in the page address. Even so, treat a real token as a password. If you would rather not type it at all, paste a made-up one with the same shape to see how the checker behaves, and put the real one straight into your agent's own setup.",
    },
  ],
  faqCode: ["/newbot", "/mybots", "/revoke", "/token", "scope=bot%20applications.commands"],
  relatedLinks: [
    { href: "/agents/hermes", label: "Run Hermes on Hivra" },
    { href: "/agents/openclaw", label: "Run OpenClaw on Hivra" },
    { href: "/tools/hermes-vs-openclaw", label: "Hermes or OpenClaw: which agent fits you?" },
    { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
    { href: "/pricing", label: "Hivra pricing" },
  ],
  componentKey: "bot-connect-wizard",
  primaryKeyword: "how to create telegram bot",
  vendors: ["Telegram", "Discord", "Nous Research", "OpenClaw"],
  method: {
    heading: "Where these steps come from",
    lastVerified: BOT_CONNECT_FACTS.lastVerified,
    paragraphs: [
      {
        text: "Telegram's side comes from Telegram's own bot pages. BotFather and /newbot, the warning that anyone with a token can control the bot, /token for a compromised token, and the privacy mode behaviour are all on the bot features page and the bots FAQ. The Bot API page shows how a token is used in a request address.",
        sources: [
          { label: "Telegram: bot features", url: "https://core.telegram.org/bots/features" },
          { label: "Telegram: bots FAQ", url: "https://core.telegram.org/bots/faq" },
          { label: "Telegram: Bot API", url: "https://core.telegram.org/bots/api" },
        ],
      },
      {
        text: "Discord's side comes from the Developer Portal documentation: creating an application and resetting the token, the privileged intents and the 100-server threshold, the bot authorization address with its client_id, scope and permissions parameters, and the permissions table. The permission bit values in the invite builder are the documented ones, and the tests hold every one of them to that table.",
        sources: [
          { label: "Discord: getting started", url: "https://docs.discord.com/developers/quick-start/getting-started" },
          { label: "Discord: gateway and intents", url: "https://docs.discord.com/developers/events/gateway" },
          { label: "Discord: OAuth2 and bot authorization", url: "https://docs.discord.com/developers/topics/oauth2" },
          { label: "Discord: permissions", url: "https://docs.discord.com/developers/topics/permissions" },
        ],
      },
      {
        text: "The token checker is a rule of thumb, not a specification. Telegram does not document a token length (its own example has 34 characters after the colon), and Discord does not document a token format at all. So the checker says the shape is right, unusual or wrong, and never says a token is valid. Only the agent connecting, or the platform, can tell you that.",
      },
      {
        text: "Where each agent reads the token comes from its own docs. Hermes: the .env file and the gateway setup command. OpenClaw: a channels add command, a config key and an environment variable for Telegram, and an environment variable for Discord. Where a page did not show us an exact name, the wizard says to see the agent's own docs and does not guess. We could not find the /revoke command on Telegram's own pages, which name /token, so the page says so.",
        sources: [
          { label: "Hermes: Telegram setup", url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram" },
          { label: "Hermes: Discord setup", url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord" },
          { label: "OpenClaw: Telegram setup", url: "https://docs.openclaw.ai/channels/telegram/setup" },
          { label: "OpenClaw: Discord setup", url: "https://docs.openclaw.ai/channels/discord/setup" },
          { label: "OpenClaw: pairing", url: "https://docs.openclaw.ai/cli/pairing" },
        ],
      },
      {
        text: "Nothing you type is sent anywhere. The page address carries only the platform and the ticked permissions. The Application ID and the token are never in it, are not stored, and leave the page only if you copy them out yourself. Both agents can run on a machine of your own, which is a fair choice, and the commands here are the same there.",
      },
    ],
  },
  examples: [
    {
      title: "Invite link with the minimal permissions",
      inputs: `Application ID ${EXAMPLE_APPLICATION_ID} (made up), the five baseline permissions: view channels, send messages, read message history, embed links, attach files`,
      command: buildInviteUrl(EXAMPLE_APPLICATION_ID, MINIMAL_PERMISSIONS).url ?? "",
      result:
        "The permissions number is 117760, the same value Hermes' docs list for this set. Open the link, choose your server, and the bot joins with exactly these five permissions.",
    },
    {
      title: "Invite link with reactions and threads",
      inputs: `The same application, plus add reactions, create public threads and send messages in threads`,
      command: buildInviteUrl(EXAMPLE_APPLICATION_ID, THREAD_PERMISSIONS).url ?? "",
      result:
        "The number grows to 309237763136, the value Hermes' docs list for its recommended set. Thread permissions use bits above 32, which is why the sum needs 64-bit arithmetic and why the tool does not use ordinary 32-bit maths.",
    },
    {
      title: "Checking a Telegram token's shape",
      inputs: "A made-up token: ten digits, a colon, then 35 letters",
      command: checkTelegramToken(EXAMPLE_TELEGRAM_SHAPE).headline,
      result:
        "The shape passes. The checker also says that passing proves nothing about whether the token is live, because it never contacts Telegram.",
    },
  ],
};
