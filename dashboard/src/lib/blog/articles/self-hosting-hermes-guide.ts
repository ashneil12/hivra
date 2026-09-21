import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "self-hosting-hermes-guide",
  title: "How to self-host Hermes Agent (and why most people quit halfway)",
  metaDescription:
    "A real guide to self-hosting Hermes Agent on a VPS. Covers the exact steps, the parts that break, what it costs in time and money, and when managed hosting is the better call.",
  publishedDate: "2026-03-13",
  lastModified: "2026-03-13",
  readingTimeMin: 11,
  author: "Hivra team",
  tagline: "Yes, you can. Here's the full picture.",
  intro:
    "Self-hosting Hermes Agent is technically straightforward if you know Linux. Here is the full process, the parts that regularly cause problems, and an honest accounting of when it makes sense versus when it does not.",
  sections: [
    {
      heading: "What you need before you start",
      paragraphs: [
        "A Linux VPS with at least 2 vCPU and 4 GB RAM. Hetzner's CX22 (~€7.49/month) or CX32 (€17.99/month, recommended for browser automation) are solid options. DigitalOcean's 4GB Droplet is $24/month. Hermes also runs on Modal or Daytona serverless infrastructure at near-zero idle cost — useful for bursty workloads, but cold-start latency makes it unsuitable for sub-minute cron tasks. Do not use a 1 GB RAM VPS — browser automation and subagent delegation crash frequently on it.",
        "Docker and Docker Compose installed on the server. A domain name with DNS pointed at the server is needed for the web interface (HTTPS required — use a subdomain like `hermes.yourdomain.com`). Free SSL is handled by Caddy, included in the standard setup. An API key from at least one AI provider — Anthropic, OpenAI, or an OpenRouter account for multi-model access. Budget 4-8 hours for first-time setup.",
      ],
    },
    {
      heading: "The actual setup process",
      paragraphs: [
        "Provision the server with a fresh Ubuntu 24.04 image. Add a non-root user with sudo privileges — the Hermes security model assumes it runs under a restricted user account, not root. SSH in as that user and install Docker following the official Docker documentation for Ubuntu.",
        "The installer handles the heavy lifting: run the one-liner from the documentation and it installs uv, Python 3.11, Node.js v22, ripgrep, ffmpeg, and the virtual environment without requiring sudo. Then run `hermes setup` for the interactive wizard — it walks through model provider, terminal backend (local, Docker, SSH, Singularity, or Modal), and gateway platform connections.",
        "Copy `.env.example` to `.env` and fill in the essentials: AI provider key, optional Firecrawl key for browser tasks, Telegram/Discord/Slack tokens for the gateway. For the terminal backend, run `hermes config set terminal.backend docker` to isolate shell commands in Docker rather than on the host. Then `docker compose up -d`. If everything is configured correctly, Caddy will provision an SSL certificate and the web interface will be accessible at your domain within a minute or two. More often, something in the networking configuration needs adjusting — DNS not propagated yet, a firewall rule blocking port 443, or a conflict between Caddy and another process on port 80.",
      ],
    },
    {
      heading: "The parts that break",
      paragraphs: [
        "Browser automation is the main friction point. The headless Chromium browser requires specific system libraries not always present in minimal Docker images. Errors about missing libraries when the agent tries to open a browser mean you need to add those libraries to the container image — which requires rebuilding the Docker image rather than just pulling the published one. The project README covers this, but it is not a one-command fix.",
        "Memory persistence breaks in subtle ways. The storage volume for memory is mounted into the container, but if you run `docker compose down` and then `docker compose up` without being careful about volume names, Docker can create a fresh volume and the agent starts empty. Always use named volumes and check them explicitly before restarting. This catches people the first time — and sometimes the second.",
        "Updates are the ongoing headache. Pulling a new version and rebuilding sometimes changes the schema of memory storage or environment variable names. Hermes v0.5.0 ships with a migration tool that imports memory layers, API settings, and skills from existing environments, which helps — but running `hermes update` and discovering a config key changed still requires manual fixing. Without backups, you can lose accumulated agent memory during an upgrade.",
      ],
    },
    {
      heading: "What it costs",
      paragraphs: [
        "Server: Hetzner CX22 (~€7.49/month) for light-to-moderate use; CX32 (€17.99/month) for browser automation and parallel subagents. DigitalOcean equivalent: $24/month. Domain: $10-15/year. API costs: Claude Haiku 4.5 at $1/$5 per MTok is cheap for monitoring and summarization, but browser-heavy tasks with 10+ screenshots per run add 200-400k tokens/month in vision inputs alone.",
        "Time cost: initial setup takes 4-8 hours. Estimate 1-2 hours per month for maintenance — handling updates, debugging intermittent failures, reviewing logs. Any server provider outage or container crash that does not auto-restart adds debugging time on top. At $50/hour, the math for self-hosting versus managed hosting is not as clean as the raw server cost makes it look.",
      ],
    },
    {
      heading: "When self-hosting makes sense",
      paragraphs: [
        "Full control over infrastructure — data privacy requirements, OS-level access for custom configuration, or deep integration with other self-hosted services. The MIT license means you can modify the code, add custom tools, and operate the agent in ways a managed service cannot accommodate.",
        "An existing homelab or VPS where adding Hermes is just another service in a Docker Compose setup. The incremental cost is low and setup complexity is manageable if you already maintain similar infrastructure. Or you genuinely enjoy the infrastructure work and want to understand the system at every layer.",
      ],
    },
    {
      heading: "When managed hosting makes more sense",
      paragraphs: [
        "If your goal is a running agent rather than learning to configure one, managed hosting is faster by significant margin. The gap between 5 minutes and 6 hours matters when you have other work to do.",
        "If you have already tried self-hosting and spent more than one evening debugging Docker networking or update problems, the recurring cost of managed hosting is likely less than the ongoing time cost of self-management. The agents do not care where they run — Hermes capabilities are identical whether the container is on your Hetzner VPS or on Hivra infrastructure. What differs is who handles the operational overhead.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can I run Hermes Agent on a $5/month VPS?",
      a: "It will install, but browser automation tasks will crash frequently due to memory limits. You need at least 4 GB RAM for stable operation with browser use. Hetzner's CX22 at €7.49/month is the realistic minimum.",
    },
    {
      q: "Does self-hosting mean my data never leaves my server?",
      a: "Your agent's memory and configuration stays on your server. But the agent still sends tokens to your AI provider (Anthropic, OpenAI, etc.) when processing tasks — that data leaves your server the same way it would from any API call.",
    },
    {
      q: "How do I back up my agent's memory?",
      a: "The memory data is stored in the Docker volume. Back it up by exporting the volume contents to a compressed archive and copying it offsite. Automate this with a cron job that runs daily. There is no built-in backup tooling in the self-hosted setup.",
    },
    {
      q: "Can I run Hermes on a Mac or Windows machine?",
      a: "With Docker Desktop and WSL2 (Windows) or Docker Desktop (Mac), yes — but performance is reduced and browser automation is less stable than on a native Linux server. For serious use, a Linux VPS is the recommended environment.",
    },
    {
      q: "What happens when the server reboots?",
      a: "If you add `restart: unless-stopped` to your Docker Compose configuration, the containers restart automatically after a reboot. Without this, you need to restart them manually. Hivra handles this automatically.",
    },
  ],
  relatedArticles: [
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent? A plain-English explanation" },
    { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent in 2026" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it saves you money" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
  ],
  relatedComparisons: [
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
  ],
  relatedFeatures: [
    { slug: "no-docker-hosting", title: "No Docker required" },
  ],
};
