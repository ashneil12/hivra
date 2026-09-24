import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "ai-agent-vps",
  title: "AI agent VPS guide: specs, providers, and setup that actually works (2026)",
  metaTitle: "AI agent VPS guide: specs, providers and setup",
  metaDescription:
    "What VPS does an AI agent need? Real specs by agent type, Hetzner vs DigitalOcean vs Vultr vs Linode prices, the security setup guides skip, and setup.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-24",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "Most agents need a smaller server and a bigger firewall than the listicles tell you.",
  intro:
    "Most AI agents are API orchestrators that idle on 1 vCPU and 2GB of RAM. The hard part of running one on a VPS is not the specs. It is keeping a machine with your API keys and logins on it safe on the public internet. This guide covers both.",
  sections: [
    {
      heading: "What an AI agent actually needs from a server",
      paragraphs: [
        "Start with the split that decides everything else. There are two kinds of agent workloads, and they need wildly different hardware:\n\n- **API-orchestrator agents.** Claude Code, Codex, Hermes, OpenClaw, and most agent frameworks. The model runs in Anthropic's or OpenAI's datacenter. Your server runs a loop: send context, receive a tool call, execute it, repeat. That loop is cheap. 1 vCPU and 1-2GB of RAM covers many agent processes; Anthropic lists 4GB for Claude Code.\n- **Local-model agents.** You run the weights on your own hardware with Ollama or similar. Now RAM is the whole game. A quantized 8B model wants 8GB+ just for weights and context. A 70B model wants 48GB+ and serious cores, and CPU inference is still slow. GPU boxes that do this well run $200-500/month.",
        "Almost everyone reading this is in the first group, and the practical spec for the first group is a step above the theoretical minimum. Budget for what the agent does, not what it is:\n\n- **Terminal-only agent, external API:** 1 vCPU, 2GB RAM, 20GB disk. Works, but swapping starts fast if anything else runs.\n- **Comfortable single agent:** 2 vCPU, 4GB RAM, 40GB SSD. Room for Docker, a gateway process, and log growth. This is the spec to actually buy.\n- **Agent + browser automation:** 4GB minimum, 8GB comfortable. A headless Chrome instance is heavier than the agent driving it, and an uncapped Chrome will eat every gigabyte you give it.\n- **Local models:** 8GB+ for small models, and be honest with yourself about token speed before committing.",
        "Disk fills slower than you fear but faster than zero. Session databases, JSONL logs, and files the agent downloads all accumulate. 40GB buys years for a single agent. 20GB buys months if browser downloads are involved.",
      ],
    },
    {
      heading: "Provider comparison: Hetzner, DigitalOcean, Vultr, Linode",
      paragraphs: [
        "For the 2 vCPU / 4GB class that most agents want, here is where the market sits in September 2026:\n\n| Provider | Plan | vCPU | RAM | SSD | Price/mo |\n|----------|------|------|-----|-----|----------|\n| Hetzner | CX23 | 2 | 4 GB | 40 GB | €5.49 |\n| Hetzner | CX33 | 4 | 8 GB | 80 GB | €8.49 |\n| Vultr | Regular Cloud Compute | 2 | 4 GB | 80 GB | $20 |\n| Linode | Shared 4GB | 2 | 4 GB | 80 GB | $24 |\n| DigitalOcean | Basic | 2 | 4 GB | 80 GB | $24 |\n\nHetzner prices are for its Germany and Finland locations, excluding VAT, after its 15 June 2026 price change. Prices move, so verify before you buy. The shape of the table does not move: Hetzner costs roughly a quarter to a third of the US-brand trio for equivalent agent workloads.",
        "What the price gap does and does not buy:\n\n- **Hetzner** is the community default for agent hosting for a reason. The catch list is short but real: its cheapest shared plans are priced for its EU datacenters, signup verification is stricter, and its support culture assumes you know Linux.\n- **DigitalOcean** has the best documentation and tutorials in the business. If this is your first server, that is worth something. It is not worth nearly four times the price forever.\n- **Vultr** has the widest location spread, useful if you need the box near a specific region. Pricing is otherwise DigitalOcean-shaped.\n- **Linode (Akamai)** is solid and boring in the good sense. Long-running boxes, predictable network. Same pricing problem as the other US brands.\n\nFor a personal agent where a few hours of downtime is annoying rather than fatal, take the Hetzner CX23 or CX33 and spend the savings on your API budget. To compare the full monthly picture including API costs, run your numbers through the [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator).",
      ],
    },
    {
      heading: "Security: the section the listicles skip",
      paragraphs: [
        "An agent VPS is not a normal VPS. A normal server holds your app. An agent server holds credentials that act as you: API keys, OAuth sessions, shell access, sometimes a logged-in browser. Treat it like a machine that can spend your money, because it is one.\n\n**Rule 1: no public ports beyond SSH.** The agent's web UI, gateway, and any dashboard should listen on localhost only. Do not bind them to 0.0.0.0 and rely on an obscure port number. Internet-wide scanners find every open port on every IPv4 address in hours, not weeks.\n\n**Rule 2: reach the box over a private network, not the open internet.** Tailscale is the easy version: install it on the VPS and your laptop, and the agent UI is reachable at a private 100.x address that only your devices can see.\n\n```bash\n# On the VPS\ncurl -fsSL https://tailscale.com/install.sh | sh\ntailscale up\n\n# Then bind the agent UI to the tailnet address or localhost\n# and close the public firewall down to SSH only\nufw default deny incoming\nufw allow OpenSSH\nufw enable\n```\n\nAn SSH tunnel (`ssh -L 8080:localhost:8080 user@vps`) does the same job with zero new software if you only ever connect from one machine.",
        "**Rule 3: API-key hygiene.** Keys live in the environment or a root-owned env file with `chmod 600`, never in the agent's working directory where a tool call can read or commit them. Use a separate key per box so you can revoke one machine without rotating everything. Set spend limits on the provider side; a runaway loop should hit a $25 cap, not your card limit.\n\n**Rule 4: know the OAuth-on-a-VPS ToS trap.** Claude Code and Codex both support signing in with your consumer subscription instead of an API key. Those subscriptions are personal logins, and putting a personal OAuth session on shared or third-party-managed infrastructure can sit badly with provider terms, which generally prohibit sharing account access. A VPS that only you control and only you access is the defensible setup: one person, one login, one machine. What you should not do is park a shared team login on a box five people SSH into. If the account matters to you, read the current terms yourself before deciding.",
        "**Rule 5: contain the agent itself.** The agent executes code and shell commands as part of normal operation. Run it as a non-root user, and prefer the Docker install where the agent offers one, so a bad tool call trashes a container instead of the host. This is also the honest argument for one-agent-per-box: isolation by hardware boundary beats isolation by hope.",
      ],
    },
    {
      heading: "Setup checklist: from fresh box to durable agent",
      paragraphs: [
        "The order matters. Harden first, install second.\n\n```bash\n# 1. First login: update, create a user, lock down SSH\napt update && apt upgrade -y\nadduser agent && usermod -aG sudo agent\n# copy your key, then in /etc/ssh/sshd_config:\n# PasswordAuthentication no, PermitRootLogin no\nsystemctl restart ssh\n\n# 2. Firewall before anything listens\nufw default deny incoming && ufw allow OpenSSH && ufw enable\n\n# 3. Docker for agents that ship an image\ncurl -fsSL https://get.docker.com | sh\nusermod -aG docker agent\n\n# 4. Unattended security updates\napt install -y unattended-upgrades\ndpkg-reconfigure -plow unattended-upgrades\n```",
        "Then make the agent survive reboots. A tmux session dies with the machine; a systemd unit comes back on its own:\n\n```bash\n# /etc/systemd/system/agent.service\n[Unit]\nDescription=AI agent\nAfter=network-online.target\n\n[Service]\nUser=agent\nEnvironmentFile=/etc/agent/env\nExecStart=/usr/local/bin/your-agent-command\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n```\n\n```bash\nsystemctl enable --now agent\n```\n\nFinally, backups. The irreplaceable part of an agent box is small: config, memory files, session database. A nightly restic or rsync job to storage that lives somewhere else takes ten minutes to set up. The VPS provider's disk is not a backup; a deleted server takes its disk with it.",
      ],
    },
    {
      heading: "Per-agent notes: Claude Code, Codex, Hermes, OpenClaw",
      paragraphs: [
        "**Claude Code** installs with Anthropic's native installer (`curl -fsSL https://claude.ai/install.sh | bash`), or with `npm install -g @anthropic-ai/claude-code` on Node.js 22 or later. It is interactive, so on a raw VPS you run it inside tmux and reattach over SSH. The headless mode (`claude -p \"...\"`) suits cron-driven jobs. Anthropic's system requirements list 4GB of RAM; add headroom if the agent will drive a browser. Details on the [Claude Code agent page](/agents/claude-code).\n\n**Codex** follows a similar shape: Node.js, `npm install -g @openai/codex`, sign in with your ChatGPT login (`codex login --device-auth` on a headless box), run in tmux. See the [Codex agent page](/agents/codex).\n\n**Hermes** is a full agent platform rather than a coding CLI: gateway, memory system, Telegram and Discord connections, scheduled tasks. It wants the 2 vCPU / 4GB spec as a working minimum and 40GB of disk for state growth. The [self-hosting guide](/blog/how-to-self-host-hermes-agent) covers the install end to end, and the [VPS comparison for Hermes](/blog/best-vps-for-hermes-agent) goes deep on provider specifics.\n\n**OpenClaw** runs as a long-lived gateway process, and its default posture assumes a trusted network. That makes the no-public-ports rule non-negotiable: loopback binding plus Tailscale, exactly as above. The [OpenClaw self-hosting walkthrough](/blog/how-to-self-host-openclaw) covers it step by step. Browser automation is core to OpenClaw workflows, so budget 8GB RAM, not 4GB.",
        "All four, plus [Aeon](/agents/aeon) and [Agent Zero](/agents/agent-zero), are also launchable as managed agents on Hivra.",
      ],
    },
    {
      heading: "When managed beats a raw VPS",
      paragraphs: [
        "The DIY route above is real and it works. Priced honestly, it is $5-10/month in server rent, 1-3 hours of setup, and a slow drip of maintenance: OS patches, agent updates, disk cleanup, and the occasional evening lost to a gateway that stopped restarting. If you enjoy that work, nothing here needs improving. (And if you are still deciding whether a VPS is even the right shape, the [AI agent hosting guide](/blog/ai-agent-hosting-guide) compares all four options: own hardware, VPS, serverless, and managed.)\n\n[Hivra](/) is the version where most of the checklist above is someone else's job. Each agent runs on its own private VM, and Claude Code and Codex are the vendors' official CLIs. Claude Code uses your own Anthropic login and Codex uses your own ChatGPT login, so there is zero markup on AI usage. You get a browser view of the running session instead of a bare SSH terminal.",
        `The plan math, plainly: the ${ENTRY_PLAN_PRICE}/month plan is ${ENTRY_PLAN_SIZE}, and the ${LARGER_PLAN_PRICE}/month plan is ${LARGER_PLAN_SIZE}, shared across the agents you run. Paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. Hermes, Claude Code, Codex, Aeon, OpenClaw, and Agent Zero all launch on Hivra; OpenClaw and Agent Zero need a paid plan. Full details on the [pricing page](/pricing).\n\nA reasonable decision rule: if you were going to buy one Hetzner box for one agent and follow this guide carefully, the DIY route saves a few dollars and teaches you things. If you want several agents, want them reachable from your phone, or do not want to own the security section personally, managed is cheaper than your time. If you are not sure your usage justifies always-on hosting at all, the [agent survival check](/tools/agent-survival-check) is a two-minute sanity test.`,
      ],
    },
  ],
  faqs: [
    {
      q: "What VPS specs do I need to run an AI agent?",
      a: "For agents that call external APIs (Claude Code, Codex, Hermes, OpenClaw), 2 vCPU, 4GB RAM, and 40GB SSD is the comfortable spec; 1 vCPU and 2GB RAM is the working minimum for many agents, though Anthropic lists 4GB for Claude Code. Add up to 8GB RAM if the agent drives a headless browser. Running local models is a different category: 8GB+ for small models, 48GB+ and many cores for 70B-class models.",
    },
    {
      q: "What is the cheapest VPS that can run an AI agent well?",
      a: "Hetzner's CX23 (2 vCPU, 4GB RAM, 40GB NVMe) at €5.49/month excluding VAT is the community standard. Equivalent plans at DigitalOcean, Vultr, or Linode run $20-24/month. The premium buys better docs and more locations, not better agent performance.",
    },
    {
      q: "Is it safe to put my API keys on a VPS?",
      a: "Yes, with basic discipline: keys in a root-owned environment file with restricted permissions, one key per machine so it can be revoked alone, spend limits set on the provider side, and no agent web UI exposed on a public port. Reach the box over Tailscale or an SSH tunnel instead of the open internet.",
    },
    {
      q: "Can I use my Claude or ChatGPT subscription login on a VPS?",
      a: "Claude Code and Codex both support subscription sign-in instead of API keys, and it works on a remote machine. Keep it defensible: one person, one login, one box you control. Sharing a personal login across a team or on shared infrastructure is where provider terms get uncomfortable. Read the current terms if the account matters to you.",
    },
    {
      q: "Should my agent run in Docker or directly on the VPS?",
      a: "Prefer Docker when the agent ships an image. Agents execute shell commands as part of normal work, so a container limits the damage a bad tool call can do and makes memory caps (--memory=4g) easy. Interactive CLIs like Claude Code more commonly run directly, inside tmux, as a non-root user.",
    },
    {
      q: "How is managed agent hosting different from renting my own VPS?",
      a: `Same underlying idea, different owner of the work. On your own VPS you handle hardening, updates, restarts, and backups; the server costs $5-10/month. On Hivra each agent gets a private VM with the official CLI preinstalled, a browser interface, and no markup on AI usage since you sign in with your own accounts. Plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}.`,
    },
  ],
  relatedArticles: [
    {
      slug: "ai-agent-memory-systems",
      title: "AI agent memory systems in 2026: Zep, Mem0, Letta, and dual-layer architectures",
    },
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent" },
    { slug: "how-to-self-host-openclaw", title: "How to self-host OpenClaw" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser automation" },
  ],
};
