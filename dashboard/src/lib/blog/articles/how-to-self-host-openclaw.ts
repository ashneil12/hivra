import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "how-to-self-host-openclaw",
  title: "How to self-host OpenClaw: complete setup guide (2026)",
  metaDescription:
    "Step-by-step guide to self-hosting OpenClaw AI agent on a Linux VPS. Covers Docker setup, environment configuration, Telegram integration, CVE-2026-25253 security patch, and the honest upgrade overhead — plus when it makes sense to use a managed alternative.",
  publishedDate: "2026-04-12",
  lastModified: "2026-04-12",
  readingTimeMin: 15,
  author: "Hivra team",
  tagline: "OpenClaw is powerful. Maintaining a self-hosted instance is a second job.",
  intro:
    "OpenClaw is one of the most-used open-source AI agent frameworks, with a large community and a broad integration ecosystem. Getting it running on a VPS takes 30-90 minutes if you follow these steps. Keeping it running — stable, updated, and secure — is the harder problem, and the part this guide covers honestly.",
  sections: [
    {
      heading: "Before you start: what you are actually signing up for",
      paragraphs: [
        "OpenClaw releases 1-2 major point releases per month and frequently introduces breaking changes. The community estimates $10,000-$20,000 per year in developer operations overhead for self-hosted instances managed at a production quality level — largely the time cost of keeping up with updates, handling schema migrations, and rewriting custom skills when API surfaces change.",
        "For running personal workflows or experimenting: the DIY route is fine. For anything business-critical requiring 24/7 reliability: the upgrade overhead is real. The r/openclaw subreddit has a steady stream of threads about breaking changes that went unannounced.",
        "There is also a third option: Hermes Agent. The architecture is comparable — persistent AI agent, messaging gateway, skills/tools system — but Hermes ships a built-in migration tool (`hermes claw migrate`) for OpenClaw users and has a more stable release cadence. Hivra is managed Hermes hosting with one-click deployment. Check it out before committing 4 hours to a self-hosted OpenClaw setup.",
      ],
    },
    {
      heading: "System requirements",
      paragraphs: [
        "Minimum for OpenClaw: 2 vCPU, 4GB RAM, 20GB SSD, Ubuntu 22.04 or 24.04. At 2GB RAM, expect OOM errors on complex agent tasks. Node.js 22 LTS or later is required. pnpm is the recommended package manager (npm and bun work but the official docs use pnpm). Docker and Docker Compose are required for the containerized install.",
        "Recommended: 4 vCPU, 8GB RAM, 40GB SSD on a dedicated VPS — OpenClaw's Docker daemon and multi-container setup competes for memory with other services. Hetzner CX22 (€3.99/month, 4GB RAM) or Hetzner CX32 (€7.49/month, 8GB RAM) are the community-recommended budget options.",
      ],
    },
    {
      heading: "Installation: the fastest method (shell installer)",
      paragraphs: [
        "OpenClaw provides a shell installer for Linux and macOS:\n\n```\ncurl -fsSL https://openclaw.ai/install.sh | bash\n```\n\nThis installs the `openclaw` CLI, sets up the `~/.openclaw/` configuration directory, and handles Node.js dependency checking. After it completes:\n\n```\nsource ~/.bashrc\nopenclaw --version\nopenclaw doctor\n```\n\nFix anything `openclaw doctor` flags before continuing — common issues are the wrong Node.js version and missing pnpm.",
        "Run the setup wizard:\n\n```\nopenclaw setup\n```\n\nThis creates the main configuration file at `~/.openclaw/openclaw.json`. The config file is JSON — any syntax error in it prevents OpenClaw from starting with a cryptic error message. After any manual edits, run `openclaw config validate`.",
      ],
    },
    {
      heading: "Installation: Docker method (recommended for production)",
      paragraphs: [
        "The Docker method is more reproducible and easier to roll back if an update breaks something. Create a directory for your OpenClaw data:\n\n```\nmkdir -p ~/openclaw-data\ncd ~/openclaw-data\n```\n\nCreate a `docker-compose.yml`:\n\n```yaml\nversion: '3.8'\nservices:\n  openclaw-gateway:\n    image: ghcr.io/openclaw/openclaw:latest\n    restart: unless-stopped\n    volumes:\n      - ./data:/home/openclaw/.openclaw\n    env_file:\n      - .env\n    ports:\n      - \"3000:3000\"\n```\n\nCreate your `.env` file:\n\n```\nOPENROUTER_API_KEY=sk-or-v1-your-key-here\n```\n\nStart the container:\n\n```\ndocker compose up -d\ndocker compose logs -f openclaw-gateway\n```\n\nConnection errors at startup are almost always a missing or malformed API key. Check the env file first.",
        "**Important for Docker upgrades**: OpenClaw skills and configuration must live in the mounted volume (`./data`), not inside the container image. If you bake skills into the image layer they will be lost on every rebuild. Verify your volume mount:\n\n```\ndocker inspect openclaw-gateway | grep -A 5 Mounts\n```",
      ],
    },
    {
      heading: "LLM provider configuration",
      paragraphs: [
        "OpenRouter is recommended for getting started — one key covers 300+ models:\n\n```\nopenclaw config set llm.provider openrouter\nopenclaw config set llm.apiKey sk-or-v1-your-key\nopenclaw config set llm.model anthropic/claude-sonnet-4\nopenclaw config validate\n```\n\nTest the connection:\n\n```\nopenclaw -m 'What is 2+2?'\n```",
        "For local models via Ollama — no API costs, no data sent externally:\n\n```\nopenclaw config set llm.provider ollama\nopenclaw config set llm.model llama3.2:8b\nopenclaw config set llm.baseUrl http://localhost:11434\n```\n\nOllama requires at least 8GB RAM for 7B models and 16GB for 13B. Your VPS spec determines which local models you can run.",
      ],
    },
    {
      heading: "Telegram gateway setup",
      paragraphs: [
        "Create a bot via @BotFather in Telegram (`/newbot`, follow prompts, copy the token). Get your user ID via @userinfobot. Add the credentials:\n\n```\nopenclaw config set messaging.telegram.enabled true\nopenclaw config set messaging.telegram.botToken YOUR-BOT-TOKEN\nopenclaw config set messaging.telegram.allowedUsers YOUR-USER-ID\n```\n\n`allowedUsers` is your security allowlist. Without it, anyone who knows your bot's username can send it commands.\n\nStart the gateway and verify it works:\n\n```\nopenclaw gateway\n```\n\nSend a test message from Telegram. Then Ctrl+C and install as a system service.",
      ],
    },
    {
      heading: "Running as a persistent service",
      paragraphs: [
        "Native install:\n\n```\nopenclaw gateway install\nsystemctl --user enable openclaw-gateway\nsystemctl --user start openclaw-gateway\n```\n\nIf it fails to start after reboot:\n\n```\nloginctl enable-linger $USER\n```\n\nFor the Docker installation, `restart: unless-stopped` handles persistence automatically. Monitor logs:\n\n```\njournalctl --user -u openclaw-gateway -f  # native\ndocker compose logs -f openclaw-gateway    # Docker\n```",
      ],
    },
    {
      heading: "Security: CVE-2026-25253 and the ClawHub risks",
      paragraphs: [
        "CVE-2026-25253 is a prompt injection vulnerability affecting OpenClaw before version 2026.2.8. Malicious content in processed documents or web pages can inject instructions into the agent's context, potentially causing it to execute unauthorized commands or exfiltrate data. If you are running 2026.2.7 or earlier, update now:\n\n```\nopenclaw update\nopenclaw --version  # verify 2026.2.8+\n```\n\nFor Docker:\n\n```\ndocker compose pull\ndocker compose up -d --force-recreate\n```",
        "Beyond patching: the agent has full system-level access — shell commands, local file reads. Anyone with access to your connected messaging account can command it. The community security checklist: enable the pairing approval flow, set `ALLOWED_USERS` explicitly, never run as root, use Docker sandbox mode, and do not connect accounts with access to sensitive data.\n\nA separate note on ClawHub: the official skill registry lists 2,800+ community skills. In early 2026, Immersive Labs and MITRE documented a coordinated supply chain attack — 'ClawHavoc' — in which hundreds of malicious skills designed as info-stealers were published before the marketplace had systematic security review in place. Treat skill installation the same way you would treat installing an npm package from an unknown author.",
      ],
    },
    {
      heading: "The upgrade process: what actually happens every month",
      paragraphs: [
        "OpenClaw releases 1-2 major point releases per month. The actual upgrade procedure:\n\n```\n# 1. Stop the gateway\nopenclaw gateway stop\n\n# 2. Backup BEFORE every upgrade (schema changes can corrupt data)\ntar czf openclaw-backup-$(date +%Y%m%d-%H%M).tgz ~/.openclaw/\ngpg --symmetric --cipher-algo AES256 openclaw-backup-*.tgz\n\n# 3. Upgrade\nopenclaw update\n\n# 4. Post-upgrade verification\nopenclaw doctor --fix\nopenclaw gateway restart\nopenclaw --version\nopenclaw config validate\n```",
        "That is approximately 20 minutes per upgrade done correctly, times 2-4 upgrades per month. This is before accounting for any breaking changes that require rewriting custom skills or handling config schema migrations manually.\n\nCommon things that break after an upgrade: config schema changes (fix: `openclaw doctor --fix`), skill API changes where functions have been renamed, and `tools.profile` defaulting to `messaging` which strips read/write/exec permissions from the agent. After every upgrade, run `openclaw config validate` and verify in Telegram that the bot still responds before calling it done.\n\nThe community's practical workaround for critical deployments: pin to a specific version in `docker-compose.yml` (`image: ghcr.io/openclaw/openclaw:2026.3.12`) and only upgrade when you have time to handle breakage. This means falling behind on security patches — which means CVE-2026-25253 all over again. There is no clean answer.",
      ],
    },
    {
      heading: "When self-hosting stops making sense",
      paragraphs: [
        "Self-hosting OpenClaw makes sense if you want zero monthly software cost, full data sovereignty, or the ability to run entirely local models. It stops making sense if that 20-minute monthly upgrade process (4+ hours per year on updates alone, before breakage) is time you do not have.",
        "Three managed OpenClaw options: ClawHost (purpose-built for OpenClaw, handles auto-updates), Blink Claw (managed service with automatic update management), and Zeabur (container deployment platform that works with the Docker image).\n\nThere is also Hermes Agent — MIT licensed, built by Nous Research, with `hermes claw migrate` to migrate your OpenClaw config, memories, skills, and environment variables. Hermes has a more stable release cadence, fewer breaking changes, and managed hosting (Hivra) with one-click deployment. If you have spent three Saturdays debugging OpenClaw upgrades, that migration exists for a reason.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is OpenClaw free to self-host?",
      a: "The software is open source and free. Your costs are server (~$4-25/month), LLM API usage ($5-50/month), and your time. The community estimates $10K-20K/year in developer operations overhead for production-quality deployments. That number is about time cost, not software cost.",
    },
    {
      q: "How do I apply the CVE-2026-25253 security patch?",
      a: "Run `openclaw update` and verify you are on 2026.2.8 or later with `openclaw --version`. For Docker: `docker compose pull && docker compose up -d --force-recreate`. The patch addresses a prompt injection vulnerability that allows malicious content in processed documents to inject instructions into the agent's context.",
    },
    {
      q: "How often does OpenClaw have breaking changes?",
      a: "1-2 times per month, based on release history and community reports. The most common breakages: config schema changes (fixed by `openclaw doctor --fix`), renamed or removed skill APIs, and `tools.profile` resetting to `messaging` (strips permissions). Budget 20 minutes per upgrade including backup.",
    },
    {
      q: "Can I migrate from OpenClaw to Hermes Agent without losing my data?",
      a: "Hermes has a built-in migration tool: `hermes claw migrate`. It migrates config files, memory, skills, and environment variables. Not everything transfers perfectly — some OpenClaw-specific skill formats need manual adjustment — but the core migration is automated and typically takes 30-60 minutes.",
    },
    {
      q: "Is there a way to get OpenClaw-equivalent functionality without the maintenance overhead?",
      a: "ClawHost and Blink Claw host OpenClaw directly. Hivra hosts Hermes Agent with a built-in `hermes claw migrate` tool to import your existing data. It covers Docker setup, updates, Telegram gateway, web interface, and persistent memory in one click.",
    },
  ],
  relatedArticles: [
    { slug: "hermes-vs-openclaw", title: "Hermes Agent vs OpenClaw: a direct comparison" },
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent on a VPS" },
  ],
};
