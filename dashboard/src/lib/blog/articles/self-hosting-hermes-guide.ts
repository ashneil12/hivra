import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "self-hosting-hermes-guide",
  title: "How to self-host Hermes Agent, and what goes wrong",
  metaTitle: "Self-hosting Hermes Agent: steps, costs and what breaks",
  metaDescription:
    "How to self-host Hermes Agent: the setup steps, what breaks, what it costs in time and money, and when managed hosting makes more sense.",
  publishedDate: "2026-03-13",
  lastModified: "2026-10-05",
  readingTimeMin: 11,
  author: "Hivra team",
  tagline: "Yes, you can. Some parts fight back.",
  intro:
    "If you know Linux, self-hosting Hermes Agent isn't hard. The trouble starts later. Browser automation, memory volumes and updates are where most setups bite back, and for some people it just isn't worth it.",
  shortAnswer: "After Hermes is up, the usual break points are browser libraries in containers, memory volumes recreated empty, and updates that move defaults. Budget 4-8 hours the first time if Compose is new. Use the install guide for commands and the Docker decision.",
  sections: [
    {
      heading: "What do I need before I start?",
      paragraphs: [
        "A Linux VPS with at least 2 vCPU and 4 GB of RAM. Hetzner's CX23 (€5.49/month) works, and the CX33 (€8.49/month, both before VAT) is the one to get if you'll use browser automation. DigitalOcean's 4 GB Droplet is $24/month. Hermes also runs on Modal or Daytona serverless, which costs almost nothing while idle. Good for bursty work. Bad for cron jobs that run every minute, because of cold starts. And skip the 1 GB VPS. Browser automation and subagents crash on it all the time.",
        "You'll also want Docker and Docker Compose on the server, and a domain pointed at it, because the web interface needs HTTPS (a subdomain like `hermes.yourdomain.com` is fine). Caddy comes with the standard setup and handles free SSL. Then an API key from at least one provider: Anthropic, OpenAI, or OpenRouter if you want lots of models on one key. Set aside 4 to 8 hours the first time.",
      ],
    },
    {
      heading: "How do I set Hermes up on my own server?",
      paragraphs: [
        "Start from a fresh Ubuntu 24.04 image. Add a non-root user with sudo, because Hermes expects to run under a restricted account, not root. SSH in as that user and install Docker using Docker's own Ubuntu guide.",
        "The exact commands, and the choice between running Hermes in Docker or using Docker as its terminal backend, are in [How to self-host Hermes Agent](/blog/how-to-self-host-hermes-agent). The installer does most of the work. Run the one-liner from the docs and it sets up uv, Python 3.11, Node.js v22, ripgrep, ffmpeg and the virtual environment, no sudo needed. Then `hermes setup` starts a wizard that asks for your model provider, terminal backend (local, Docker, SSH, Singularity or Modal) and which chat platforms to connect.",
        "Copy `.env.example` to `.env` and fill in the essentials: AI provider key, optional Firecrawl key for browser tasks, Telegram/Discord/Slack tokens for the gateway. The Telegram side has its own bot-token and pairing steps that are easy to get wrong the first time: [connecting Hermes Agent to Telegram](/blog/how-to-set-up-hermes-agent-telegram) covers them step by step. To keep the agent's shell commands off the host, run `hermes config set terminal.backend docker`. Then `docker compose up -d`.",
        "If it all lines up, Caddy grabs a certificate and the web interface is live at your domain in a minute or two. More often something in the network needs a nudge. DNS hasn't propagated yet. A firewall rule blocks port 443. Or another process is already sitting on port 80.",
      ],
    },
    {
      heading: "What usually breaks?",
      paragraphs: [
        "The browser, mostly. Headless Chromium needs system libraries that slim Docker images often leave out. If the agent throws missing-library errors when it opens a browser, you have to add them and rebuild the image yourself instead of pulling the published one. The README explains how. It's still not a one-command fix.",
        "Memory is the sneaky one. The memory volume is mounted into the container, but run `docker compose down` and `docker compose up` without minding the volume names and Docker can quietly create a new, empty one. Your agent wakes up with amnesia. Use named volumes and check them before every restart. People get caught by this once. Sometimes twice.",
        "Then there are updates, which never really stop. A new version can change how memory is stored or rename environment variables. Hermes v0.5.0 added a migration tool that carries memory, API settings and skills across, and that helps. But when `hermes update` turns up a renamed config key, you're fixing it by hand. No backups? An upgrade can wipe out months of what your agent learned.",
      ],
    },
    {
      heading: "What does self-hosting cost?",
      paragraphs: [
        "In cash, not much. Hetzner's CX23 (€5.49/month before VAT) covers light to moderate use, and the CX33 (€8.49/month) handles browser automation and parallel subagents. The DigitalOcean equivalent is $24/month. A domain is $10 to $15 a year. Tokens depend on the work: Claude Haiku 4.5 at $1 in and $5 out per million tokens is cheap for monitoring and summaries, but a browser task that takes 10+ screenshots a run adds 200,000 to 400,000 tokens a month in images alone.",
        "Time is the real bill. Setup takes 4 to 8 hours. After that, plan on 1 to 2 hours a month for updates, odd failures and log reading, plus whatever an outage or a container that won't restart costs you. Value your time at $50 an hour and that cheap server stops looking so cheap.",
      ],
    },
    {
      heading: "When is self-hosting the right call?",
      paragraphs: [
        "When you need full control. Strict data privacy rules, OS-level access for custom setups, or tight links to other services you already run yourself. Hermes is MIT licensed, so you can change the code, add your own tools and run it in ways no managed service will.",
        "It also makes sense if you already run a homelab or VPS and Hermes is one more service in your Compose file. The extra cost is tiny and you already know the drill. Or you just like this kind of work and want to understand every layer. Fair enough.",
      ],
    },
    {
      heading: "When is managed hosting the better choice?",
      paragraphs: [
        "When you want a running agent, not a weekend project. Managed hosting skips those 4 to 8 hours of setup, and that counts when you've got other work waiting.",
        "Already lost more than one evening to Docker networking or a broken update? Then the monthly fee for managed hosting is probably less than what your own server costs you in time. The agent doesn't care where it runs. Hivra runs Hermes from its own maintained build of the open-source agent, and the main difference is who does the upkeep.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can I run Hermes Agent on a $5/month VPS?",
      a: "It'll install. Then browser tasks will keep crashing for lack of memory. You need at least 4 GB of RAM for stable browser use, which makes Hetzner's CX23 at €5.49/month (before VAT) the realistic minimum.",
    },
    {
      q: "Does self-hosting mean my data never leaves my server?",
      a: "Your agent's memory and configuration stays on your server. But the agent still sends tokens to your AI provider (Anthropic, OpenAI, etc.) when processing tasks. That data leaves your server the same way it would from any API call.",
    },
    {
      q: "How do I back up my agent's memory?",
      a: "The memory data is stored in the Docker volume. Back it up by exporting the volume contents to a compressed archive and copying it offsite. Automate this with a cron job that runs daily. There is no built-in backup tooling in the self-hosted setup.",
    },
    {
      q: "Can I run Hermes on a Mac or Windows machine?",
      a: "Yes, with Docker Desktop (plus WSL2 on Windows). It's slower, though, and browser automation is flakier than on a real Linux server. For anything serious, use a Linux VPS.",
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
    {
      slug: "how-to-set-up-hermes-agent-telegram",
      title: "How to connect Hermes Agent to Telegram (step by step)",
    },
    {
      slug: "hermes-agent-skills-guide",
      title: "Hermes Agent skills: how they work, how to create them, and what's on the Skills Hub",
    },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
  ],
  relatedComparisons: [
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
    { slug: "vs-nous-hermes-cloud", title: "Hivra vs Nous Hermes Cloud" },
    { slug: "vs-hostinger", title: "Hivra vs Hostinger" },
  ],
  relatedFeatures: [
    { slug: "no-docker-hosting", title: "No Docker required" },
  ],
};
