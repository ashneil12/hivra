import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "hermes-agent-memory-system-explained",
  title: "Hermes Agent memory explained: SOUL.md, MEMORY.md, sessions, and Honcho",
  metaDescription:
    "A plain-English breakdown of how Hermes Agent remembers things across sessions. Covers personality files, fact storage, conversation history search, and the Honcho semantic memory layer — with what actually persists and what gets forgotten.",
  publishedDate: "2026-04-14",
  lastModified: "2026-04-14",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "Three separate memory systems running at once. Here is what each one actually does.",
  intro:
    "Most AI tools forget everything the moment you close the window. Hermes keeps memory in four overlapping places, and each one does something the others don't. This covers how they work, what actually persists across sessions, and where memory still falls short.",
  sections: [
    {
      heading: "The four memory layers",
      paragraphs: [
        "**SOUL.md** — personality and communication style. **MEMORY.md** — facts you've shared. **Session history database** — every conversation, searchable. **Honcho** — optional external service for smarter cross-session recall.\n\nEach does something different. They work together.",
        "This matters because 'I told my agent something last week — why did it forget?' is almost always a question about which layer that information was supposed to land in. Hermes doesn't automatically remember everything — it decides what's worth writing down. Same way a person takes notes on some things and lets others go.",
      ],
    },
    {
      heading: "SOUL.md — personality",
      paragraphs: [
        "SOUL.md defines how the agent communicates: tone, what to avoid, how direct to be. It's the first thing loaded in every conversation, before any task context or memory.\n\nFree-form Markdown, no fixed schema. Example from the official docs:\n\n```\n# Personality\nYou are a pragmatic senior engineer.\nYou optimize for truth and clarity over politeness theater.\n\n## Style\n- Be direct without being cold\n- Prefer substance over filler\n\n## What to avoid\n- Sycophancy\n- Hype language\n```\n\nChanges take effect the next session. If the file is missing, Hermes falls back to the built-in default: 'You are Hermes Agent, an intelligent AI assistant created by Nous Research.'",
        "SOUL.md shapes *how* the agent speaks. MEMORY.md shapes *what* it knows about you. Editing one doesn't affect the other.",
      ],
    },
    {
      heading: "MEMORY.md — what it knows about you",
      paragraphs: [
        "MEMORY.md is where Hermes writes facts worth keeping: your name, your tech stack, standing preferences, context that would be annoying to repeat every session.\n\nThe agent writes here when it judges something worth persisting. You can push it explicitly:\n\n> 'Remember that I want all code examples in Python 3.12.'\n\nOr just open the file yourself and add a line — it's plain text, nothing encrypted:\n\n```bash\nnano ~/.hermes/MEMORY.md\n```",
        "There's also USER.md — the agent updates this on its own based on patterns it notices in how you work. MEMORY.md is facts you told it. USER.md is conclusions it drew. You can read and edit both.",
      ],
    },
    {
      heading: "Session history",
      paragraphs: [
        "Every conversation is saved to a searchable database on the server. Ask Hermes about something from a past session — 'What did I tell you about the auth service last month?' — and it searches through conversation history to find the relevant context.\n\nThe search is keyword-based. It finds messages containing the words you use, not the meaning behind them. If you said 'that deployment thing' months ago, searching for 'CI/CD pipeline' might not find it. Different words, same concept.\n\nBrowse your own history:\n\n```bash\nhermes sessions browse   # interactive session picker\nhermes sessions stats    # total sessions and storage used\n```\n\nConversations are kept indefinitely unless you configure pruning. On a small server this adds up — [the VPS guide](/blog/best-vps-for-hermes-agent) covers how quickly storage grows.",
        "The keyword limitation is real. If your vocabulary for something varied across sessions, the agent might not connect the dots. That's the gap Honcho addresses.",
      ],
    },
    {
      heading: "Honcho — memory that understands context",
      paragraphs: [
        "[Honcho](https://github.com/plastic-labs/honcho) (built by [Plastic Labs](https://plasticlabs.ai)) adds meaning-based memory on top of keyword search. It understands what you were talking about and surfaces relevant context even when you phrase things differently.\n\nPractical example: you spent Tuesday working through a complex database migration. Three weeks later you start a new session. Keyword search won't connect the two unless you use the same words. Honcho does.\n\nOnce connected, it gives Hermes four additional memory tools: fast fact lookup, semantic search over your full history, question-answering from past sessions, and the ability to write important facts down for later.",
        "Setting Honcho up is more involved — it runs as a separate background service and requires [Docker](https://docs.docker.com/get-started/). For most people, the built-in keyword search is good enough. Honcho pays off when you have months of history you want the agent to draw on intelligently.\n\nFor a simpler alternative: [Mem0](https://mem0.ai/) is another memory provider, easier to get running. Configure either with:\n\n```bash\nhermes memory setup\n```",
      ],
    },
    {
      heading: "What actually persists",
      paragraphs: [
        "**Reliably remembered:** your name; preferences you stated explicitly; standing instructions; anything the agent wrote to MEMORY.md.\n\n**Unreliable:** things mentioned once in passing that it didn't judge important; things said late in a long conversation when the AI's working memory was full.\n\n**Gone at session end:** anything not explicitly saved to MEMORY.md or Honcho. Think of it like a phone call — the conversation is over, but notes you took during it survive.",
        "Habit worth building: at the end of a productive session, ask 'What should you save to your memory from this conversation?' It identifies the important facts and writes them down. Faster than editing the file yourself.",
      ],
    },
    {
      heading: "Backing up memory",
      paragraphs: [
        "All memory files live in `~/.hermes/`. Back up the whole directory:\n\n```bash\ntar czf hermes-backup-$(date +%Y%m%d).tgz ~/.hermes/\n```\n\nThis captures personality files, facts, conversation history, skills, and config. API keys are usually in there too — encrypt the archive before storing it anywhere:\n\n```bash\ngpg --symmetric --cipher-algo AES256 hermes-backup-*.tgz\n```\n\nRestoring on a new server: unpack the archive and Hermes picks everything up on next start.",
      ],
    },
    {
      heading: "Memory on Hivra",
      paragraphs: [
        "Using [Hivra](/): all four memory layers are on and backed up automatically. SOUL.md, MEMORY.md, conversation history, and installed skills survive container restarts, redeployments, and cancellation. Nothing to configure.\n\nSelf-hosting: [the self-hosting guide](/blog/how-to-self-host-hermes-agent) covers backup setup. Worth doing before you accumulate months of conversation history you'd be sad to lose.",
      ],
    },
  ],
  faqs: [
    {
      q: "Does Hermes remember everything I say?",
      a: "No. It remembers what it decides is worth writing to MEMORY.md, and can search past conversations by keyword. For reliable memory: tell it explicitly what to remember, or use Honcho which does more thorough cross-session fact capture.",
    },
    {
      q: "Can I read and edit my own memory files?",
      a: "Yes. SOUL.md, MEMORY.md, and USER.md are plain text Markdown files. Open any of them in any text editor. Nothing is encrypted by default. Edits take effect the next session.",
    },
    {
      q: "What's the difference between MEMORY.md and SOUL.md?",
      a: "SOUL.md is personality — how the agent speaks, what tone it uses, what to avoid. MEMORY.md is facts — what it knows about you, your preferences, your context. Different jobs.",
    },
    {
      q: "What happens to memory if I lose the server?",
      a: "Everything in ~/.hermes/ is gone unless you have backups. Run the tar command above and keep the archive somewhere safe. On Hivra, automated nightly backups handle this without any setup.",
    },
    {
      q: "Does Hermes use AI to search its own memory?",
      a: "Default search is keyword-based — fast, local, no API cost. With Honcho or Mem0, search becomes semantic (the agent finds relevant memories based on meaning, not just word matches). Configure either with: hermes memory setup",
    },
    {
      q: "How many memory providers does Hermes support?",
      a: "Eight external providers: Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, and a custom API mode for building your own. All optional — keyword search works out of the box.",
    },
  ],
  relatedArticles: [
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent on a VPS" },
    { slug: "persistent-memory-explained", title: "How persistent memory works in AI agents" },
    { slug: "ai-agent-memory-systems", title: "AI agent memory systems compared" },
    { slug: "hermes-agent-telegram-discord-setup", title: "Hermes Agent gateway: Telegram, Discord, and 13 more" },
  ],
};
