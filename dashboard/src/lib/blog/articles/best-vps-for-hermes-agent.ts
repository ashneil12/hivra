import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "best-vps-for-hermes-agent",
  title: "Best VPS for Hermes Agent in 2026: Hetzner, DigitalOcean, OVH compared",
  metaDescription:
    "Which VPS actually runs Hermes Agent well? Real specs, current pricing, and community recommendations for Hetzner CX23/CX33, DigitalOcean, OVH, Vultr, and Raspberry Pi. Covers multi-instance setup, storage growth, and ARM compatibility.",
  publishedDate: "2026-04-16",
  lastModified: "2026-09-24",
  readingTimeMin: 11,
  author: "Hivra team",
  tagline: "The community has been running Hermes on cheap VPS servers for months. Here is what they found.",
  intro:
    "Hermes Agent runs well on inexpensive cloud infrastructure. The question is not whether you can afford a VPS. At €5.49/month you can. The question is which tier is enough for your usage, which providers the community trusts, and what breaks when you underspec. Here are the real numbers.",
  sections: [
    {
      heading: "Minimum specs and what happens below them",
      paragraphs: [
        "Minimum: 2 vCPU, 4GB RAM, 40GB SSD. At this spec, Hermes Agent with an external API provider (OpenRouter, Anthropic, OpenAI) runs reliably for a single user. The 4GB RAM floor is hard — at 2GB you see OOM errors on complex tasks involving browser automation or heavy file processing. The errors are not always graceful; they can corrupt the session in progress.",
        "The 40GB storage recommendation exists because `~/.hermes/` grows over time. Session logs accumulate in `~/.hermes/sessions/` and the SQLite database (`state.db`) grows with every conversation. On a 20GB disk at several sessions per day, you can fill it in 6-12 months. Start with 40GB or configure log rotation early.",
        "Docker adds overhead. If you use `hermes config set terminal.backend docker` — which sandbox-isolates shell commands — Docker needs an additional 1-2GB for container spin-up. On a 4GB server running the gateway and Docker simultaneously, run `free -h` before enabling the Docker backend. It is easy to forget it and discover the problem at 2am when a task fails.",
      ],
    },
    {
      heading: "Hetzner (community favourite, not close)",
      paragraphs: [
        "Hetzner is the near-universal community recommendation for Hermes hosting. The price-to-spec ratio beats DigitalOcean or AWS Lightsail significantly for equivalent hardware.\n\n| Model | vCPU | RAM | NVMe | Price/mo |\n|-------|------|-----|------|----------|\n| CX23  | 2 | 4 GB | 40 GB | €5.49 |\n| CX33  | 4 | 8 GB | 80 GB | €8.49 |\n| CX43  | 8 | 16 GB | 160 GB | €15.99 |\n\n*Prices as of September 2026 for Hetzner's Germany and Finland locations, excluding VAT. Hetzner raised CX prices again on 15 June 2026, so older guides quoting €3.99 for the CX23 are out of date.*",
        "The CX23 is the minimum viable spec: adequate for a single-user instance with external API inference, Telegram gateway, and moderate task volume. The CX33 at €8.49/month is the recommended tier. The 8GB RAM headroom handles Docker backend, browser automation tasks, and occasional heavy workloads without OOM pressure. Two light Hermes instances on one CX33 is feasible with careful resource limits.",
        "Datacenter locations: Nuremberg, Falkenstein, Helsinki (EU), Hillsboro Oregon, Ashburn Virginia (US). EU datacenters suit most European users. The US locations reduce round-trip for North American users on Telegram gateway, though the difference is modest since Telegram's own servers are distributed.",
      ],
    },
    {
      heading: "DigitalOcean, OVH, Vultr, and Hostinger",
      paragraphs: [
        "**DigitalOcean** is the default in most tutorials because of good documentation and a polished UI. The pricing does not compete:\n\n| Droplet | vCPU | RAM | Price/mo |\n|---------|------|-----|-----------|\n| Basic | 2 | 4 GB | $24 |\n| Basic | 4 | 8 GB | $48 |\n\nAt $48/month for 8GB RAM versus Hetzner's €8.49, the gap is hard to justify unless you are already running DigitalOcean infrastructure and want to co-locate.",
        "**OVH** is the more interesting alternative. The current lineup: VPS-1 (2 vCPU, 4GB RAM, 40GB SSD) at about $4.54/month and VPS-2 (4 vCPU, 8GB RAM, 75GB NVMe, unlimited traffic) at about $8.50/month, both on annual billing. VPS-2 undercuts the Hetzner CX33 slightly and adds unmetered bandwidth, useful if your instance does heavy data retrieval. Support quality is lower than Hetzner in community reports, though most self-hosters rarely need support.\n\n**Vultr** pricing lands close to DigitalOcean: its regular 2 vCPU, 4GB plan is $20/month. The High Frequency line is faster and dearer (3 vCPU and 8GB for $48/month), which works for multi-instance setups but has the same pricing problem as DigitalOcean.\n\n**Hostinger KVM 2**: 2 vCPU, 8GB RAM, $8.99/month on a two-year promotional term, renewing at $14.99/month. More RAM per dollar than the Hetzner CX23 at a comparable price. Appears in a few community setup threads. Less established than Hetzner in the self-hosting community.",
      ],
    },
    {
      heading: "Raspberry Pi: does it actually work?",
      paragraphs: [
        "Raspberry Pi 5 (8GB): yes, with caveats. Community members have run Hermes Agent on Pi 5 for multi-week stretches using external API inference. The limitations are practical:\n\n- SD card I/O under heavy SQLite writes causes periodic hangs — use NVMe via USB or an official M.2 hat\n- Power outages corrupt the SQLite session database without a UPS\n- ARM64 support: the Docker image supports arm64, so the Docker install works\n- No useful local model inference — small quantised models (Phi-3-mini, Llama 3.2 3B) on Pi 5 run at 5-15 tokens/second on CPU alone\n\nPi is a legitimate option for a personal assistant that only hits external APIs. Not production-viable for anything where availability matters.",
      ],
    },
    {
      heading: "Shared VPS vs dedicated",
      paragraphs: [
        "Shared VPS (Hetzner CX series, DigitalOcean Basic) is the right call for Hermes Agent with external API inference. CPU is the bottleneck for Hermes orchestration and tool execution — not inference — and shared vCPU handles it without problem.",
        "Dedicated or bare metal only makes sense if you run local Ollama inference on the same machine. Llama 3.1 70B on CPU needs 48+ GB RAM and 16+ physical cores to run at acceptable speed. That territory is far beyond the cost/use-case for most Hermes users. GPU VPS runs $200-500/month — at that price, Hivra managed hosting plus a premium API key is more economical than self-hosted GPU inference.",
      ],
    },
    {
      heading: "Multi-instance: several Hermes agents on one server",
      paragraphs: [
        "Hermes supports a profiles system (introduced in v0.6.0) for running multiple isolated instances from a single installation. Each profile gets a separate `~/.hermes-<profile>/` directory, independent memory stores and session database, isolated skill library, distinct gateway services, and separate config files.\n\n```bash\nhermes profile create work\nhermes profile create personal\nhermes profile list\nhermes profile switch work\nhermes -p work -m 'Check my tasks for today'\n```",
        "For Docker-based multi-instance, give each container a separate volume. Never run two containers against the same data directory:\n\n```bash\n# Profile 1\ndocker run --memory=4g --cpus=2 --shm-size=1g -v hermes1:/app/.hermes ...\n# Profile 2\ndocker run --memory=4g --cpus=2 --shm-size=1g -v hermes2:/app/.hermes ...\n```\n\nResource allocation:\n\n| Instances | Min RAM | Recommended |\n|-----------|---------|-------------|\n| 1 | 4 GB | 8 GB (CX33) |\n| 2 | 8 GB | 16 GB (CX43) |\n| 3-4 | 16 GB | 32 GB |\n\nHetzner CX43 (16GB, €15.99/month) handles two instances comfortably.",
      ],
    },
    {
      heading: "Storage growth and disk management",
      paragraphs: [
        "What grows over time in `~/.hermes/`:\n- `state.db` — SQLite session database. Expect 50-200MB/year at moderate usage.\n- `sessions/` — JSONL session log files. Prune with `hermes sessions export` then delete old files.\n- `logs/` — gateway logs. Configure log rotation: `hermes config set logging.max_size_mb 100`.\n- `downloads/` — files created during tasks. Clean manually or set task-specific output directories.\n\n```bash\ndf -h                      # total disk\ndu -sh ~/.hermes/          # hermes directory\ndu -sh ~/.hermes/state.db  # session database specifically\nhermes sessions stats      # session count and estimated storage\n```",
        "A 40GB disk with normal single-user usage handles 2-3 years before storage becomes a concern. If your agent runs browser automation tasks that download files, use a dedicated data directory outside `~/.hermes/` from the beginning.",
      ],
    },
    {
      heading: "Total monthly cost",
      paragraphs: [
        `Running Hermes Agent on a self-hosted VPS (single user, external API inference, Telegram gateway):\n\n| Component | Monthly cost |\n|-----------|-------------|\n| Hetzner CX23 | €5.49 (excl. VAT) |\n| LLM API (OpenRouter, moderate usage) | $5-20 |\n| Domain (optional, for HTTPS webhook) | ~$1 |\n| **Total** | **~$12-27/month** |\n\nHivra managed hosting starts at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE} and includes the server and gateway setup, with no server maintenance on your side. The self-hosted route is $12-27/month plus 2-4 hours of initial setup and 30-60 minutes/month of ongoing maintenance.`,
        "The math favours self-hosting on cash cost. It does not always favour it on time cost. At $50/hour developer time, a single afternoon debugging an update that broke your gateway costs more than six months of Hivra. That comparison changes in your favour if you run Hermes long-term with rare issues, or genuinely enjoy the infrastructure work.",
      ],
    },
    {
      heading: "The same box runs Claude Code, Codex, and OpenClaw",
      paragraphs: [
        "Everything above applies beyond Hermes. The specs that run a Hermes agent also run [Claude Code](/agents/claude-code), [Codex](/agents/codex), and OpenClaw: 2 vCPU and 4GB covers a single CLI agent, and 8GB gives headroom for browser automation. If you are setting one of these up yourself, the [Hermes self-host guide](/blog/how-to-self-host-hermes-agent) and the [OpenClaw self-host guide](/blog/how-to-self-host-openclaw) cover the setup differences.",
        `If you would rather skip the server entirely, Hivra runs all of these agents on managed VMs, with plans from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. Compare your VPS math against managed with the [hosting cost calculator](/tools/ai-agent-hosting-cost-calculator), and check plan sizes on [the pricing page](/pricing).`,
      ],
    },
  ],
  faqs: [
    {
      q: "What is the cheapest server that reliably runs Hermes Agent?",
      a: "Hetzner CX23 at €5.49/month excluding VAT (2 vCPU, 4GB RAM, 40GB NVMe), or OVH VPS-1 at about $4.54/month on annual billing for the same spec. This is the community-consensus minimum. Below 4GB RAM you see OOM errors on complex tasks; below 40GB storage you risk running out within a year of normal usage.",
    },
    {
      q: "Does Hermes Agent support ARM64 for Raspberry Pi or ARM VPS?",
      a: "Yes. The Docker image supports arm64 and the shell installer works on ARM Linux. Raspberry Pi 5 (8GB) has been tested by community members for multi-week runs with external API inference. Local Ollama inference on Pi is too slow for practical use — 5-15 tokens/second on CPU.",
    },
    {
      q: "How much does storage grow over time?",
      a: "Expect 50-200MB/year for the SQLite session database on moderate single-user usage. The sessions/ directory also grows — configure log rotation or prune old sessions. A 40GB disk handles normal single-user usage for 2-3 years.",
    },
    {
      q: "Can I run multiple Hermes agents on one VPS?",
      a: "Yes, using the profiles system introduced in v0.6.0. Each profile gets an isolated ~/.hermes-<profile>/ directory with separate memory, sessions, skills, and gateway config. For Docker multi-instance: give each container a separate volume. Never run two containers against the same data directory.",
    },
    {
      q: "Should I use Hetzner or DigitalOcean?",
      a: "Hetzner. The CX33 (4 vCPU, 8GB, €8.49/month) costs about a fifth of a comparable DigitalOcean Droplet ($48/month for 4 vCPU, 8GB). DigitalOcean has better documentation and a more polished UI, but those advantages do not justify the price premium for Hermes hosting.",
    },
    {
      q: "What if I don't want to manage a server at all?",
      a: `Hivra handles the VPS, Docker setup, gateway configuration, and updates, starting at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. No SSH required.`,
    },
  ],
  relatedArticles: [
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent on a VPS" },
    { slug: "how-to-self-host-openclaw", title: "How to self-host OpenClaw" },
    { slug: "hermes-agent-telegram-discord-setup", title: "Hermes Agent gateway setup: Telegram, Discord, and 13 more" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
  ],
};
