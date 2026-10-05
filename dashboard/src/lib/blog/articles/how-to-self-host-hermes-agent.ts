import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

// Extended 2026-10-05 for "hermes agent docker" (US 590, KD 5) and the Docker-vs-own-computer decision.
// Nous Docker and install docs read 5 October 2026:
// https://hermes-agent.nousresearch.com/docs/user-guide/docker
// https://hermes-agent.nousresearch.com/docs/getting-started/installation
// Docker Hub: nousresearch/hermes-agent
// Hivra: launch contracts hermes.ownServer=false; image ghcr.io/ashneil12/vanilla-hermes-agent (not the Nous image).
// Not claimed: that Hivra runs Docker internally; BYO My cloud / My server for Hermes; affiliation with Nous.

export const article: BlogArticle = {
  slug: "how-to-self-host-hermes-agent",
  title: "How to self-host Hermes Agent: VPS setup, Docker, or its own computer",
  metaTitle: "Self-host Hermes Agent: VPS, Docker, or a computer",
  metaDescription:
    "Self-host Hermes Agent on Ubuntu: install script, Docker image, Telegram gateway, systemd. Or run it on a Hivra computer. Docs checked 5 Oct 2026.",
  publishedDate: "2026-04-11",
  lastModified: "2026-10-05",
  readingTimeMin: 16,
  author: "Hivra team",
  tagline: "Docker can mean two different things here. Pick the one that matches the isolation you want.",
  intro:
    "Hermes Agent runs on a VPS, keeps its memory and talks over Telegram while you sleep. Getting there from a blank Ubuntu server still takes a few hours when things go right. Docker shows up in two different ways in Nous's docs, and mixing them up is how people lose a weekend. We re-read those docs on 5 October 2026. Hivra is one managed path. It is not Nous, and it does not run Hermes on My cloud or My server.",
  shortAnswer:
    "Rent Ubuntu 24.04 with at least 2 vCPU and 4 GB RAM, install Docker, run Nous's install script, finish hermes setup, then run the gateway under systemd. Or run Hermes in nousresearch/hermes-agent with ~/.hermes at /opt/data. A Hivra computer uses Hivra's maintained image on its own private computer, with no compose file for you to keep current.",
  sections: [
    {
      heading: "Docker container, or Hermes on its own computer?",
      paragraphs: [
        "Nous's [Docker guide](https://hermes-agent.nousresearch.com/docs/user-guide/docker), read on 5 October 2026, splits Docker into two jobs. Running Hermes in Docker puts the whole agent inside `nousresearch/hermes-agent`, with your config and keys on a host folder mounted at `/opt/data`. Docker as a terminal backend leaves Hermes on the host and only sandboxes the shell commands the agent runs. Same word, different blast radius.",
        [
          "| Route | What stays isolated | What you maintain | Pick it when |",
          "|---|---|---|---|",
          "| Install on the VPS + Docker terminal backend | Shell commands the agent runs | OS updates, the Hermes install, systemd, Docker | You want Hermes as a normal Linux service and a sandbox for commands |",
          "| Hermes in `nousresearch/hermes-agent` | The agent process and its tools, if you keep data on the mounted volume | Image pulls, the volume, ports you publish | You want one container to upgrade by pull, with data outside the image |",
          "| Hivra computer | Your laptop: Hermes runs on a private computer Hivra starts for it | Your model key and what you ask it to do | You want Hermes up without keeping a compose file or a VPS current |",
        ].join("\n"),
        "Hivra is not affiliated with Nous Research. On Hivra Cloud, Hermes runs from Hivra's maintained image `ghcr.io/ashneil12/vanilla-hermes-agent`, not from the Nous release on Docker Hub. Hermes does not run on My cloud or My server (`ownServer` is false for Hermes in Hivra's launch contracts), so do not treat a bring-your-own Hetzner project as a Hermes path here. OpenClaw, Claude Code, Codex and Agent Zero can use your own server. Hermes cannot.",
      ],
    },
    {
      heading: "Before you start: do you actually want to self-host?",
      paragraphs: [
        "Self-hosting makes sense if you want the data on your disk, you are already comfortable with Linux, you have a compliance reason to run it yourself, or you want to change how the agent behaves at the edges. The project is open source, so that path is real.",
        "Skip the VPS path if your time is expensive, you want to be chatting today, or you would rather spend the evening on the work the agent will do. Hivra starts a Hermes agent from the dashboard, with the computer and messaging gateway already wired, and chat in the browser. The rest of this guide is for people who still want the server under their own SSH key.",
        "What you need before the VPS path: Ubuntu 24.04 LTS (fresh install preferred), SSH as a user who can sudo, an API key from at least one LLM provider, and a Telegram account if you want the gateway. A domain helps for a public web UI. It is optional for Telegram alone.",
      ],
    },
    {
      heading: "Server requirements",
      paragraphs: [
        "Minimum: 2 vCPU, 4 GB RAM, 20 GB SSD. That runs Hermes with Docker available for sandboxed commands. Hetzner's CX23 at €5.49/month excluding VAT is the community budget option many people quote. DigitalOcean's 4 GB Basic Droplet is dearer for the same floor. Hostinger KVM 2 with 8 GB RAM shows up in setup threads when people want more RAM on one server.",
        "Recommended: 4 vCPU, 8 GB RAM, 40 GB SSD. Extra RAM matters if you run Ollama beside the agent, or you turn on the Docker terminal backend and browser tools at once. 4 GB is the hard floor: below it, complex tasks hit OOM. OS: Ubuntu 24.04 LTS. Nous's install docs target that. Debian 12 can work if you are happy fixing the gaps yourself.",
      ],
    },
    {
      heading: "Phase 1: server preparation",
      paragraphs: [
        "SSH into your VPS as root. Update the system:\n\n```\napt update && apt upgrade -y\n```\n\nCreate a non-root user for Hermes. Running as root is a bad habit on a machine that will hold API keys:\n\n```\nadduser hermes --disabled-password --gecos \"\"\nusermod -aG sudo hermes\necho 'hermes ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/hermes\nchmod 440 /etc/sudoers.d/hermes\n```\n\nCopy your SSH keys to the new user:\n\n```\nmkdir -p /home/hermes/.ssh\ncp ~/.ssh/authorized_keys /home/hermes/.ssh/\nchown -R hermes:hermes /home/hermes/.ssh\nchmod 700 /home/hermes/.ssh && chmod 600 /home/hermes/.ssh/authorized_keys\n```\n\nSwitch to that user and stay there:\n\n```\nsu - hermes\n```",
        "Turn the firewall on before you publish anything:\n\n```\nsudo apt-get install -y ufw\nsudo ufw default deny incoming\nsudo ufw default allow outgoing\nsudo ufw allow ssh\nsudo ufw --force enable\nsudo ufw status verbose\n```",
      ],
    },
    {
      heading: "Phase 2: Docker installation",
      paragraphs: [
        "You need Docker either as the terminal backend or as the runtime for the official image. Install from Docker's own Ubuntu repo, not the distro package:\n\n```\nsudo apt-get install -y ca-certificates curl gnupg\ncurl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg\necho \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable\" | sudo tee /etc/apt/sources.list.d/docker.list\nsudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io\n```\n\nAdd the hermes user to the docker group:\n\n```\nsudo usermod -aG docker hermes && newgrp docker\n```\n\nCheck it:\n\n```\ndocker run --rm hello-world\n```\n\nIf you see a permission error, log out and back in. `newgrp docker` only fixes the current shell.",
      ],
    },
    {
      heading: "Phase 3: install Hermes on the VPS",
      paragraphs: [
        "Nous's [installation page](https://hermes-agent.nousresearch.com/docs/getting-started/installation), read on 5 October 2026, gives a one-line source install for Linux, macOS and WSL2:\n\n```\ncurl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash\n```\n\nReload your shell, then check the binary:\n\n```\nsource ~/.bashrc\nhermes --version\nhermes doctor\n```\n\n`hermes doctor` checks Docker, Python, dependencies and write access under `~/.hermes/`. Fix what it flags before you go on.",
        "Run the setup wizard:\n\n```\nhermes setup\n```\n\nIt asks for the LLM provider and writes the first files under `~/.hermes/` (`.env`, config, memory). Keep those. If you already use Nous Portal, `hermes setup --portal` is the short path Nous documents for provider plus Tool Gateway in one go.",
      ],
    },
    {
      heading: "Running Hermes inside Docker instead",
      paragraphs: [
        "If you want the agent itself in a container, Nous's Docker guide (5 October 2026) starts with a host data directory and an interactive setup:\n\n```\nmkdir -p ~/.hermes\ndocker run -it --rm \\\n  -v ~/.hermes:/opt/data \\\n  nousresearch/hermes-agent setup\n```\n\nThat writes keys into `~/.hermes/.env` on the host. The image is meant to be stateless. Your config, sessions and memories live on the mounted volume, so a later `docker pull` does not wipe them.",
        "For a gateway that stays up:\n\n```\ndocker run -d \\\n  --name hermes \\\n  --restart unless-stopped \\\n  -v ~/.hermes:/opt/data \\\n  -p 8642:8642 \\\n  nousresearch/hermes-agent gateway run\n```\n\nPort 8642 is the OpenAI-compatible API and health endpoint inside the official image. Skip publishing it if you only need Telegram or Discord. Nous's guide also documents `HERMES_DASHBOARD=1` with port 9119 when you want the built-in dashboard beside the gateway. Tags on Docker Hub include `latest` / `stable`, `main`, and version pins. Use a digest when you need an exact deploy. Nous warns against pasting these commands into some browser-based VPS consoles, because characters like `:` can corrupt. Use SSH.",
        "Compose is fine once the volume and image tag are clear. The failure mode people hit is `docker compose down` recreating a fresh volume and an empty agent. Named volumes and a quick check before recreate save that. For the pain points around browser libraries and updates, the older [self-hosting notes](/blog/self-hosting-hermes-guide) still help. This page stays the install owner.",
      ],
    },
    {
      heading: "Phase 4: LLM provider and the Docker terminal backend",
      paragraphs: [
        "OpenRouter is a common starting point: one key, many models. Put the key in the env file with tight permissions:\n\n```\nchmod 600 ~/.hermes/.env\necho 'OPENROUTER_API_KEY=sk-or-v1-your-key-here' >> ~/.hermes/.env\n```\n\nSet a default model with `hermes config set`, then smoke-test:\n\n```\nhermes -m 'What is 2+2?'\n```",
        "If Hermes itself runs on the host and you want shell commands sandboxed, set the terminal backend (this is Docker-as-backend, not Hermes-in-Docker):\n\n```\nhermes config set terminal.backend docker\nhermes config get terminal\nhermes -m 'Run ls -la in a sandboxed environment and show me the output'\n```\n\nOn a 4 GB VPS, watch `free -h` before you enable that backend and browser tools together. The sandbox needs headroom.",
      ],
    },
    {
      heading: "Phase 5: Telegram gateway setup",
      paragraphs: [
        "Create a bot with @BotFather, copy the token, and get your numeric user id from @userinfobot.\n\n```\necho 'TELEGRAM_BOT_TOKEN=your-bot-token-here' >> ~/.hermes/.env\necho 'TELEGRAM_ALLOWED_USERS=your-numeric-user-id' >> ~/.hermes/.env\n```\n\nWithout the allowlist, anyone who finds the bot can talk to it. Test with `hermes gateway`, send a message, then Ctrl+C. The longer Telegram walkthrough lives in [how to set up Hermes Agent on Telegram](/blog/how-to-set-up-hermes-agent-telegram).",
      ],
    },
    {
      heading: "Phase 6: run as a persistent service",
      paragraphs: [
        "On the host install path, a gateway in an SSH session dies when the session dies. Install the user service:\n\n```\nhermes gateway install\nsystemctl --user enable hermes-gateway\nsystemctl --user start hermes-gateway\nsystemctl --user status hermes-gateway\n```\n\nFollow logs with `journalctl --user -u hermes-gateway -f`. After a reboot, if the service never comes back, enable linger so the user service can run without a login:\n\n```\nloginctl enable-linger hermes\n```",
        "On the container path, `--restart unless-stopped` (or the Compose equivalent) is the keep-alive. Inside the current official image, Nous says `gateway run` is supervised by s6-overlay so a crashed gateway restarts inside the same container. Older tini-based images behaved differently. Read the date on the Docker guide before you assume which one you pulled.",
      ],
    },
    {
      heading: "Common errors and fixes",
      paragraphs: [
        "Permission denied on Docker after adding the group: log out and back in, or `newgrp docker`.\n\n`hermes: command not found` after install: `source ~/.bashrc`.\n\n`hermes doctor` still unhappy: run the project's update path, then re-check. Missing Python packages usually mean the install did not finish.",
        "Telegram silent: token whitespace, wrong numeric user id, or gateway logs with the real error.\n\nOOM on tasks: stay at 4 GB or above.\n\nAPI errors after a good start: check the provider dashboard for spend limits.\n\nEmpty memory after a Compose recreate: confirm the named volume still mounts at `/opt/data` before you celebrate the new container.",
      ],
    },
    {
      heading: "The self-hosting calculation",
      paragraphs: [
        `Server cost: a CX23-class VPS around €5.49/month excluding VAT. LLM API: often $5-50/month depending on how hard you push it. First setup: a few hours when it goes well. Upkeep: under an hour most months. At $50/hour, one painful evening of debugging already covers many months of Hivra's ${ENTRY_PLAN_PRICE} plan (${ENTRY_PLAN_SIZE}).`,
        "Self-hosting wins when you like Linux, you will keep the agent for a long stretch, and you care about holding the disk yourself. It loses when updates break at a bad time or when the infrastructure work crowds out the actual tasks. Hivra is the managed alternative: Hermes from Hivra's maintained build, on its own private computer, without a compose file for you to babysit. If you would rather skip the install, that is what it is for.",
      ],
    },
  ],
  faqs: [
    {
      q: "Should I run Hermes in Docker or only use Docker as the terminal backend?",
      a: "In Docker means the whole agent lives in nousresearch/hermes-agent with data under ~/.hermes mounted at /opt/data. Docker as the terminal backend leaves Hermes on the host and sandboxes shell commands only. Nous documents both on 5 October 2026. Pick the first when you want pull-to-upgrade. Pick the second when Hermes is a normal host service.",
    },
    {
      q: "What Docker image does Hermes Agent use?",
      a: "The official image on Docker Hub is nousresearch/hermes-agent. Tags include latest/stable, main, and version pins. Hivra Cloud runs Hermes from ghcr.io/ashneil12/vanilla-hermes-agent instead. That is Hivra's maintained build, not the Nous release.",
    },
    {
      q: "What is the cheapest server that can actually run Hermes Agent?",
      a: "Community write-ups often cite Hetzner CX23 at €5.49/month excluding VAT (2 vCPU, 4 GB RAM). Below 4 GB RAM you will hit OOM on complex tasks. Re-check the vendor page before you pay.",
    },
    {
      q: "How long does the setup actually take?",
      a: "A few hours for someone who already knows Linux and Docker, when nothing odd breaks. First-time server work often stretches longer. On Hivra you skip the VPS setup.",
    },
    {
      q: "Do I need my own domain for self-hosting?",
      a: "Not for Telegram. You want a domain if you expose a web UI over HTTPS. Without one, keep the UI on a local port or SSH tunnel.",
    },
    {
      q: "Can I migrate from OpenClaw to Hermes Agent?",
      a: "Hermes ships a migration helper, hermes claw migrate, for config, memories, skills and env vars from an OpenClaw install. Not everything transfers cleanly, but the core path is automated.",
    },
    {
      q: "Can Hermes on Hivra run on My cloud or My server?",
      a: "No. Hermes is Hivra Cloud only in the launch contracts (ownServer is false). OpenClaw, Claude Code, Codex and Agent Zero can use your own server. Hermes cannot.",
    },
    {
      q: "What happens when a Hermes update breaks my setup?",
      a: "On the host path, update, then hermes doctor, then check gateway logs. On the container path, pin or roll back the image tag and keep the data volume. Most breakages show up in doctor or in journalctl / docker logs.",
    },
  ],
  relatedArticles: [
    {
      slug: "self-hosting-hermes-guide",
      title: "Self-hosting Hermes Agent: steps, costs and what breaks",
    },
    {
      slug: "hermes-agent-skills-guide",
      title: "Hermes Agent skills: how they work, how to create them, and what's on the Skills Hub",
    },
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent? A plain-English explanation" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
    { slug: "persistent-memory-explained", title: "How persistent memory works in AI agents" },
  ],
  relatedComparisons: [
    { slug: "vs-nous-hermes-cloud", title: "Hivra vs Nous Hermes Cloud" },
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
  ],
};
