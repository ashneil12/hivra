import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "how-to-self-host-hermes-agent",
  title: "How to self-host Hermes Agent on a VPS: complete setup guide (2026)",
  metaDescription:
    "Step-by-step guide to self-hosting Hermes Agent on a Linux VPS. Covers server requirements, Docker setup, Telegram gateway, systemd service, and the common errors that kill most first attempts — plus when a managed host might be the better call.",
  publishedDate: "2026-04-11",
  lastModified: "2026-09-24",
  readingTimeMin: 14,
  author: "Hivra team",
  tagline: "Every command on this page came from the official NousResearch GitHub. Set aside 2-4 hours.",
  intro:
    "Hermes Agent runs on a VPS, persists memory, connects to Telegram, and runs scheduled tasks while you sleep. Getting there from a blank Ubuntu server takes 2-4 hours if everything goes right. This guide has all the actual commands — sourced from the official Nous Research GitHub — plus the errors most people hit and how to fix them.",
  sections: [
    {
      heading: "Before you start: do you actually want to self-host?",
      paragraphs: [
        "Self-hosting makes sense if you want full control over your data, you're comfortable with Linux server administration, you have specific compliance or privacy requirements, or you want to modify the agent's core behavior. The MIT license means you can do anything with it.",
        "Skip this guide if your hourly rate is above $50, you want to be running today without touching a server, or you'd rather spend your time on the work the agent will do rather than configuring the environment it runs in. Hivra launches a configured Hermes agent from its dashboard, with the server, container, and messaging gateway set up and chat in the browser, without any of the steps below. The rest of this guide is for the self-hosters.",
        "What you need before starting: a VPS running Ubuntu 24.04 LTS (fresh install preferred), root SSH access, a domain name pointed at the server (optional but strongly recommended for the web UI), an API key from at least one LLM provider (OpenRouter recommended — gives access to 300+ models with a single key), and a Telegram account for the messaging gateway.",
      ],
    },
    {
      heading: "Server requirements",
      paragraphs: [
        "Minimum: 2 vCPU, 4GB RAM, 20GB SSD. This runs Hermes with Docker-sandboxed execution. Hetzner's CX23 at €5.49/month (excluding VAT) meets this spec and is the community's budget option. DigitalOcean's Basic Droplet at 4GB RAM is $24/month for the same spec. Hostinger KVM 2 with 8GB RAM, at $8.99/month on a two-year promotional term and $14.99/month on renewal, is a solid mid-tier choice if you run several tools on the same server.",
        "Recommended: 4 vCPU, 8GB RAM, 40GB SSD. The extra RAM matters for running local models via Ollama alongside the agent, or for heavy parallel task workloads. 4GB is the hard floor — below it, you hit OOM errors on complex tasks. Operating system: Ubuntu 24.04 LTS. The official install script is written for this. Debian 12 works with minor adjustments. Nothing else unless you're confident rewriting the installer.",
      ],
    },
    {
      heading: "Phase 1: server preparation",
      paragraphs: [
        "SSH into your VPS as root. Run the initial system update:\n\n```\napt update && apt upgrade -y\n```\n\nCreate a dedicated non-root user for Hermes. Running as root is a security risk:\n\n```\nadduser hermes --disabled-password --gecos \"\"\nusermod -aG sudo hermes\necho 'hermes ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/hermes\nchmod 440 /etc/sudoers.d/hermes\n```\n\nCopy your SSH keys to the new user:\n\n```\nmkdir -p /home/hermes/.ssh\ncp ~/.ssh/authorized_keys /home/hermes/.ssh/\nchown -R hermes:hermes /home/hermes/.ssh\nchmod 700 /home/hermes/.ssh && chmod 600 /home/hermes/.ssh/authorized_keys\n```\n\nSwitch to the hermes user and stay there for the rest of the setup:\n\n```\nsu - hermes\n```",
        "Set up the firewall before exposing anything. This blocks all inbound traffic except SSH:\n\n```\nsudo apt-get install -y ufw\nsudo ufw default deny incoming\nsudo ufw default allow outgoing\nsudo ufw allow ssh\nsudo ufw --force enable\nsudo ufw status verbose\n```",
      ],
    },
    {
      heading: "Phase 2: Docker installation",
      paragraphs: [
        "Hermes uses Docker for sandboxed terminal execution. Install from the official Docker repository — not the Ubuntu package, which is often outdated:\n\n```\nsudo apt-get install -y ca-certificates curl gnupg\ncurl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg\necho \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable\" | sudo tee /etc/apt/sources.list.d/docker.list\nsudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io\n```\n\nAdd the hermes user to the docker group:\n\n```\nsudo usermod -aG docker hermes && newgrp docker\n```\n\nVerify:\n\n```\ndocker run --rm hello-world\n```\n\nYou should see 'Hello from Docker!'. If you see a permission error, log out and back in — `newgrp docker` fixes it for the current session but the persistent change needs a re-login.",
      ],
    },
    {
      heading: "Phase 3: Hermes Agent installation",
      paragraphs: [
        "The official one-line installer handles Python dependencies, the CLI binary, and the initial directory structure:\n\n```\ncurl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash\n```\n\nAfter it completes, reload your shell:\n\n```\nsource ~/.bashrc\n```\n\nVerify the installation and run the health check:\n\n```\nhermes --version\nhermes doctor\n```\n\n`hermes doctor` checks Docker availability, Python version, required dependencies, and write access to config directories. Fix anything it flags before continuing — common issues are Docker not being in PATH, missing Python packages, or permissions on `~/.hermes/`.",
        "Run the interactive setup wizard:\n\n```\nhermes setup\n```\n\nThis prompts for your LLM provider preference and generates the initial config files: `~/.hermes/.env`, `~/.hermes/config.yaml`, `~/.hermes/MEMORY.md`, and `~/.hermes/USER.md`. These are the core files — do not delete them.",
      ],
    },
    {
      heading: "Phase 4: LLM provider configuration",
      paragraphs: [
        "Hermes supports 400+ models. OpenRouter is the recommended starting point — one API key gives access to Anthropic, OpenAI, Mistral, Llama, and 60+ other providers. Get a key at openrouter.ai.\n\nSet permissions on the env file first:\n\n```\nchmod 600 ~/.hermes/.env\necho 'OPENROUTER_API_KEY=sk-or-v1-your-key-here' >> ~/.hermes/.env\n```\n\nSet your default model:\n\n```\nhermes config set model.provider openrouter\nhermes config set model.default anthropic/claude-sonnet-4\n```\n\nTest it:\n\n```\nhermes -m 'What is 2+2?'\n```\n\nIf you get a response, the LLM connection is working.",
        "Configure Docker as the terminal backend:\n\n```\nhermes config set terminal.backend docker\nhermes config get terminal\n```\n\nTest sandboxed execution:\n\n```\nhermes -m 'Run ls -la in a sandboxed environment and show me the output'\n```",
      ],
    },
    {
      heading: "Phase 5: Telegram gateway setup",
      paragraphs: [
        "Create a bot: open Telegram, message @BotFather, send `/newbot`, follow the prompts, and copy the token. Get your user ID from @userinfobot.\n\nAdd both to your env file:\n\n```\necho 'TELEGRAM_BOT_TOKEN=your-bot-token-here' >> ~/.hermes/.env\necho 'TELEGRAM_ALLOWED_USERS=your-numeric-user-id' >> ~/.hermes/.env\n```\n\n`TELEGRAM_ALLOWED_USERS` is your security allowlist. Without it, anyone who finds your bot can send it commands. Test the gateway:\n\n```\nhermes gateway\n```\n\nSend a message to your bot in Telegram. You should see it arrive in the terminal and a response sent back. Press Ctrl+C once confirmed.",
      ],
    },
    {
      heading: "Phase 6: run as a persistent service",
      paragraphs: [
        "The gateway running in a terminal session will stop when your SSH connection closes. Install it as a systemd user service:\n\n```\nhermes gateway install\nsystemctl --user enable hermes-gateway\nsystemctl --user start hermes-gateway\nsystemctl --user status hermes-gateway\n```\n\nVerify it is running:\n\n```\njournalctl --user -u hermes-gateway -f\n```\n\nTest that it survives a reboot:\n\n```\nsudo reboot\n```\n\nSSH back in after 30 seconds and check:\n\n```\nsystemctl --user status hermes-gateway\n```",
        "If the service fails to start after reboot, the most common cause is `XDG_RUNTIME_DIR` not being set for loginctl sessions:\n\n```\nloginctl enable-linger hermes\n```\n\nThis allows the user service to run without an active login session.",
      ],
    },
    {
      heading: "Common errors and fixes",
      paragraphs: [
        "'Permission denied' running Docker after adding to the group: log out and back in, or run `newgrp docker`. Group membership is only picked up on new login.\n\n'hermes: command not found' after installation: run `source ~/.bashrc`. The installer adds the PATH entry but it only applies in new shell sessions.\n\n`hermes doctor` flags missing dependencies: run `hermes update` then re-check. If specific Python packages are still missing: `pip install -r ~/.hermes/requirements.txt`.\n\nTelegram bot not responding: check the token (no extra spaces), verify `TELEGRAM_ALLOWED_USERS` contains your exact numeric user ID, and check `journalctl --user -u hermes-gateway -f` for the specific error.\n\nOut of memory during tasks: 4GB RAM is the minimum — if you are below this, complex tasks will fail. Check current usage with `free -h` and upgrade the server if needed.\n\nAPI errors after it was working: your API key may have exhausted credits, especially on OpenRouter's free tier. Check your provider dashboard.",
      ],
    },
    {
      heading: "The honest self-hosting calculation",
      paragraphs: [
        `Server cost: Hetzner CX23 at €5.49/month excluding VAT. LLM API costs: $5-50/month depending on task volume. Initial setup: 2-4 hours of your time. Ongoing maintenance: 30-60 minutes per month. At $50/hour, the setup alone costs $100-200 in time — enough to cover 10-20 months of Hivra's ${ENTRY_PLAN_PRICE} plan.`,
        "Self-hosting wins if you are comfortable with Linux, expect to keep the agent running for a year or more, and care about complete data control. It loses if setup issues frustrate you, if maintenance distracts from the actual work, or if updates break your configuration at inconvenient times. Hivra is the managed alternative: Hermes from Hivra's maintained build of the open-source agent, with the container, service, SSL, and tested updates handled. If you would rather skip the 4 hours, that is what it is for.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is the cheapest server that can actually run Hermes Agent?",
      a: "Hetzner CX23 at €5.49/month excluding VAT (2 vCPU, 4GB RAM, 40GB SSD). This meets the minimum spec and the community has validated it works. Below 4GB RAM you will hit OOM errors on complex tasks.",
    },
    {
      q: "How long does the setup actually take?",
      a: "2-4 hours for a developer comfortable with Linux and Docker, if everything goes right. Add an hour for each significant error you hit. First-time Linux server administrators typically spend 6-8 hours. On Hivra you skip this setup entirely.",
    },
    {
      q: "Do I need my own domain for self-hosting?",
      a: "Not for the Telegram gateway — that runs fine without a domain. You need a domain if you want the web UI accessible externally via HTTPS. Without one, you can access the UI over the server's IP on a local port.",
    },
    {
      q: "Can I migrate from OpenClaw to Hermes Agent?",
      a: "Yes. Hermes has a built-in migration tool: `hermes claw migrate`. It migrates config files, memories, skills, and environment variables from an existing OpenClaw installation. Not everything transfers perfectly but the core migration is automated.",
    },
    {
      q: "What happens when a Hermes update breaks my setup?",
      a: "Run `hermes update`, then `hermes doctor`, then `hermes config check`. Most breaking changes are caught by the doctor command. Check the logs with `journalctl --user -u hermes-gateway -f` for the specific error if the gateway stops responding.",
    },
  ],
  relatedArticles: [
    {
      slug: "hermes-agent-skills-guide",
      title: "Hermes Agent skills: how they work, how to create them, and what's on the Skills Hub",
    },
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent? A plain-English explanation" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
    { slug: "persistent-memory-explained", title: "How persistent memory works in AI agents" },
  ],
};
