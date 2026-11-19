import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE } from "../plan-facts";

// Written 2026-11-18 for "agent zero vps hosting" (Search Console: impressions at about position 58, where the
// Agent Zero vs OpenClaw comparison ranks and no dedicated guide exists) and the backlog queries "agent zero docker
// requirements", "agent zero install", "agent zero docker" and "agent zero ai". The comparison stays in
// agent-zero-vs-openclaw-hosting; this is the hands-on guide.
// SERP read 2026-11-18: the results for "self host agent zero on a VPS" are VPS-provider landing pages (OVHcloud,
// SSD Nodes, RamNode, AccuWeb), so the gap is a neutral, command-level guide with security and updates.
// Sources fetched 2026-11-18:
// https://github.com/agent0ai/agent-zero (README: image agent0ai/agent-zero, `docker run -d -p 127.0.0.1:5080:80 -v a0_usr:/a0/usr agent0ai/agent-zero`,
//   A0 Install and A0 Launcher, headless quick start, links to docs)
// https://github.com/agent0ai/agent-zero/blob/main/docs/setup/installation.md (volume /a0/usr only, never the whole /a0,
//   container port 80, A0_SET_ variables, Settings -> Authentication, Settings UI -> Update -> Self Update (backups managed internally),
//   v1.20 to v2.0 manual move, Backup & Restore (install guide: Settings -> Check for Updates -> Backup & Restore; usage guide and
//   troubleshooting: Settings -> Backup & Restore), remove /a0/usr/settings.json to regenerate defaults)
// https://raw.githubusercontent.com/agent0ai/agent-zero/main/docs/setup/vps-deployment.md (VPS minimums 1 vCPU / 2 GB RAM, recommended
//   2 vCPU / 4 GB, 20 GB disk, 64-bit Linux, Docker Engine 24.0+, `--restart unless-stopped`, AUTH_LOGIN and AUTH_PASSWORD in an
//   .env mounted at /a0/.env, Apache reverse proxy with WebSocket rules, 302 to /login check, 502/504 troubleshooting)
// https://github.com/agent0ai/agent-zero/blob/main/docs/guides/troubleshooting.md (chat input needs API keys, "Invalid model ID",
//   OpenRouter prefix, ChatGPT Plus is not API credit, chats in /a0/usr/chats/, secrets.env not always in backups, web UI
//   unreachable without a host port mapped to 80, stuck update recovery with /exe/trigger_self_update.sh)
// https://github.com/agent0ai/agent-zero/blob/main/docs/guides/usage.md (set UI authentication before a tunnel, backups cover chats,
//   projects, knowledge, memory, settings, skills and workspace files, secrets may not be included)
// https://www.agent-zero.ai/p/docs/installation/ (`docker run -d -p 127.0.0.1:5080:80 -v a0_usr:/a0/usr agent0ai/agent-zero`,
//   local-only binding, "never expose the instance to the internet without Web UI authentication enabled")
// https://www.agent-zero.ai/p/docs/sharing/ (Settings -> Authentication; Flare Tunnel; "Always enable authentication before exposing to the internet")
// https://www.agent-zero.ai/p/docs/updating/ (Settings UI -> Update -> Self Update, `docker pull agent0ai/agent-zero:latest`, major
//   versions need a new image, side-by-side container example, original keeps running if the new one fails)
// https://www.agent-zero.ai/p/docs/onboarding/ (Cloud, Account and Local provider paths, main and utility model)
// https://www.agent-zero.ai/p/docs/ (docs hub) and https://www.agent-zero.ai/ (site)
// https://github.com/agent0ai/agent-zero/releases and /releases/latest and /releases/tag/v2.15 (release pages checked 2026-11-18; v2.15 shown as 1 Nov; v2.15 note: "existing usr/.env is kept authoritative without overwriting conflicting legacy
//   files"; v2.9 SSRF fix CVE-2026-4308; v2.12 Telegram, WhatsApp and IMAP authorization fixes)
// https://newreleases.io/project/github/agent0ai/agent-zero/release/v2.15 (same v2.15 notes)
// https://docs.docker.com/engine/network/port-publishing/ ("Publishing container ports is insecure by default"; 127.0.0.1 binding)
// https://docs.docker.com/engine/install/ubuntu/ (supported Ubuntu releases, apt repository, convenience script for testing only)
// https://caddyserver.com/docs/quick-starts/reverse-proxy and https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
//   (domain plus reverse_proxy, automatic HTTPS, ports 80 and 443 open, WebSocket connections supported)
// Hivra facts: src/app/agents/content/agent-zero.ts (own container on the VM, own browser and computer tools, native dashboard
//   behind an authenticated gateway, login created during provisioning, model via Settings or Hivra credits, paid computers not
//   paused for inactivity), docs/STATUS.md (Agent Zero runs on Hivra Cloud or a Proxmox server you connected; every Hivra Cloud
//   computer needs a paid plan), lib/launch/contracts.ts (agent-zero ownServer true), lib/blog/plan-facts.ts.
// Not claimed: affiliation with Agent Zero; backups; setup times; that /a0/usr/.env is the only .env path (the VPS guide still
//   mounts one at /a0/.env, so the copy tells readers to check their own version); a specific v2.15 date beyond "November 2026";
//   that Hivra updates Agent Zero for you; that Hivra works from a phone (copy says "from a browser" only); that local model speed
//   follows the host's memory (no source found).

export const howToSelfHostAgentZero: BlogArticle = {
  slug: "how-to-self-host-agent-zero",
  title: "How to self-host Agent Zero on a VPS with Docker (2026 guide)",
  metaTitle: "Self-host Agent Zero on a VPS with Docker",
  metaDescription:
    "Run Agent Zero on a VPS with the official Docker image: requirements, the run command, ports, login, HTTPS, model setup, updates and backups.",
  publishedDate: "2026-11-18",
  lastModified: "2026-11-18",
  readingTimeMin: 14,
  author: "Hivra team",
  tagline: "One Docker command starts it. Making it safe to leave on the internet is the real job.",
  intro:
    "Agent Zero is an open-source agent that plans, writes and runs code, and browses the web from its own dashboard. The install is a single docker run. The parts people get wrong are the ones around it: what to put on a server, where the data lives, how to lock the login before it faces the internet, and how to update without losing your work.",
  shortAnswer:
    "To self-host Agent Zero, rent a 64-bit Linux VPS (the project's minimum is 1 vCPU and 2 GB RAM, 2 vCPU and 4 GB recommended), install Docker, and run the agent0ai/agent-zero image with the /a0/usr folder on a volume. Set a login in Settings, then put HTTPS in front of it.",
  sections: [
    {
      heading: "What you are actually hosting",
      paragraphs: [
        "Agent Zero ([agent0ai/agent-zero on GitHub](https://github.com/agent0ai/agent-zero)) is a general-purpose agent. You give it a goal in a web dashboard, and it plans the steps, runs code in a Linux environment, uses a browser inside its container, and reports back. You supply the model.",
        "Because the agent runs code, \"self-hosting\" here means hosting a machine that can do things, not just a web page. The project's own docs say never to expose an instance to the internet without Web UI authentication turned on, and updates matter: recent releases include an SSRF fix tracked as CVE-2026-4308 in v2.9 and security fixes for the Telegram, WhatsApp and IMAP connectors in v2.12 (a webhook authentication bypass, a media path traversal and a sender whitelist bypass).",
        "For a side-by-side with another agent, see [Agent Zero vs OpenClaw hosting](/blog/agent-zero-vs-openclaw-hosting). For what running any agent on a server involves, see the [AI agent VPS guide](/blog/ai-agent-vps).",
      ],
    },
    {
      heading: "Hardware and Docker requirements",
      paragraphs: [
        "The project's [VPS deployment guide](https://github.com/agent0ai/agent-zero/blob/main/docs/setup/vps-deployment.md) gives the numbers. As of November 2026 they are:",
        "- **CPU:** 1 vCPU minimum, 2 or more recommended.\n- **RAM:** 2 GB minimum, 4 GB or more recommended.\n- **Disk:** 20 GB minimum, 50 GB or more recommended.\n- **OS:** 64-bit Linux, such as Ubuntu 22.04 or newer.\n- **Docker:** Docker Engine 24.0 or newer is the project's minimum. For the loopback port binding used in this guide, install Docker Engine 28.0.0 or newer: Docker's [port publishing page](https://docs.docker.com/engine/network/port-publishing/) says that before 28.0.0, other hosts on the same network segment could reach a port published to `127.0.0.1`.\n- **Network:** a static IP and, if you want a proper address, a domain you control.",
        "Treat the minimum as a floor for trying it out; for real browsing or heavier work, start at 2 vCPU and 4 GB.",
        "You do not need a GPU. Agent Zero sends its model calls to a provider over the internet. A GPU only matters if you run a local model on the same machine. Our guide on [whether you need a GPU to run an AI agent](/blog/do-you-need-a-gpu-to-run-an-ai-agent) covers that decision.",
        "Docker's install page lists Ubuntu 22.04, 24.04, 26.04 and 26.10 as supported and says its convenience script is only recommended for testing and development, so use the [apt repository method](https://docs.docker.com/engine/install/ubuntu/) on a machine you plan to keep.",
      ],
    },
    {
      heading: "Laptop Docker, a VPS or a managed host",
      paragraphs: [
        [
          "| | Laptop with Docker | Your own VPS | Managed host (Hivra) |",
          "|---|---|---|---|",
          "| Setup | One docker run, or the A0 Launcher | Server, Docker, firewall, login, HTTPS, updates | No server to prepare |",
          "| Stays on when you close the lid | No, the container stops when the machine sleeps or shuts down | Yes, if the container restarts after a reboot | The computer stays on while your plan is active |",
          "| Reachable from other devices | Only from the laptop itself, because the port is bound to loopback; other devices need a tunnel or a LAN binding you set up yourself | Yes, through your domain | Yes, through a browser |",
          "| Who secures it | You, but it is not exposed by default | You, and it faces the internet | The dashboard sits behind an authenticated gateway |",
          "| Who updates it | You, with Self Update or a new image | You | Check Hivra's Agent Zero page for how updates work |",
          `| Cost before model usage | Free if you already own the machine | Whatever the server costs; the specs above set the price | ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE} |`,
        ].join("\n"),
        "Model usage is extra everywhere. Start on a laptop; move to a VPS if you want the agent working while you are away. The rest of this guide is the VPS route, and its checklist is: loopback port binding, a login confirmed with a 302 to `/login`, HTTPS through a proxy with WebSocket support, a spending limit at your model provider, and a backup of `/a0/usr` stored off the server.",
      ],
    },
    {
      heading: "Step 1: prepare the server",
      paragraphs: [
        "Create a 64-bit Ubuntu server with at least the specs above, then SSH in with a normal sudo user and keys. Install Docker from Docker's apt repository using the [official steps](https://docs.docker.com/engine/install/ubuntu/), then check it works. A new sudo user is not in the `docker` group, so the commands in this guide start with `sudo`. (Adding yourself to the `docker` group removes the need, but anyone in that group effectively has root on the server, so we leave it out.)\n\n```\nsudo docker --version\nsudo docker run hello-world\n```",
        "Open only what you need in your server's firewall: SSH, plus ports 80 and 443 once you add HTTPS below. Do not open the Agent Zero port itself, and keep any local model server port (Ollama uses 11434) private too. The next section binds Agent Zero to the server's own loopback address so nothing outside can reach it directly.",
      ],
    },
    {
      heading: "Step 2: run the official image",
      paragraphs: [
        "The image is `agent0ai/agent-zero`. The README, the install guide and the docs site all show `docker run -d -p 127.0.0.1:5080:80 -v a0_usr:/a0/usr agent0ai/agent-zero` (add `sudo` on a server), which publishes the port to the local machine only. For a VPS, add a name and a restart policy, which the project's own VPS guide uses too:",
        "```\nsudo docker pull agent0ai/agent-zero\n\nsudo docker run -d \\\n  --name agent-zero \\\n  --restart unless-stopped \\\n  -p 127.0.0.1:5080:80 \\\n  -v a0_usr:/a0/usr \\\n  agent0ai/agent-zero\n```",
        "`-d` runs it in the background, and `--restart unless-stopped` brings it back after a crash or a reboot. `-p 127.0.0.1:5080:80` maps port 5080 on the server's loopback address to the container's port 80, where the web UI always listens (the project's examples use host ports 5080 and 50080, and you can pick another). `-v a0_usr:/a0/usr` keeps your data in a named Docker volume, so replacing the container does not delete it.",
        "Docker's documentation says published container ports are reachable from the outside world, and that publishing to `127.0.0.1` restricts them to the host. Without the `127.0.0.1:` prefix, `-p 5080:80` puts an unauthenticated agent on the public internet.",
        "The project also offers a terminal installer for servers, `curl -fsSL https://bash.agent-zero.ai | bash`, with a headless `--quick-start` mode, and a desktop app, the A0 Launcher. The plain `docker run` above is easier to audit, and the rest of this guide assumes it.",
        "To see the dashboard before you add HTTPS, tunnel to it from your own computer:\n\n```\nssh -L 5080:127.0.0.1:5080 you@your-server\n```\n\nThen open `http://localhost:5080` in your browser. Nothing is exposed while you do this.",
      ],
    },
    {
      heading: "Where your data and settings live",
      paragraphs: [
        "Everything that is yours lives in one folder inside the container: `/a0/usr`. The install guide says it holds settings, chats, memory, projects and custom plugins, and the troubleshooting page puts chat history in `/a0/usr/chats/`.",
        "Map only `/a0/usr`. The install guide warns that mapping the whole `/a0` directory can break upgrades, because it contains the application code.",
        "On the `.env` file, be careful, because the project's pages are not fully consistent. The v2.15 release notes (November 2026) say an existing `usr/.env` is kept authoritative during startup migration without overwriting conflicting legacy files. But the VPS deployment guide still mounts a separate `.env` file at `/a0/.env`, and the install guide mentions an `.env` file without giving its full path.",
        "So check your own version before relying on either path: after any upgrade, look at what is actually there with `sudo docker exec -it agent-zero ls -a /a0/usr`. Secrets are a separate case. The troubleshooting page says they live in `/a0/usr/secrets.env`, and that backups do not always include them, so keep your own copy.",
      ],
    },
    {
      heading: "Set a login before you expose it",
      paragraphs: [
        "Do this before anything else leaves your server. The docs say: \"never expose the instance to the internet without Web UI authentication enabled.\" The dashboard controls an agent that can run code, so an open port is an open shell.",
        "Over your SSH tunnel, open Settings, then Authentication. There are three fields: a UI login username, a UI password, and a root password for SSH access to the container. Set a long, unique UI password and save. The [sharing guide](https://www.agent-zero.ai/p/docs/sharing/) gives the same path and says to enable authentication before exposing the instance to the internet.",
        "The project's VPS guide describes another route: `AUTH_LOGIN` (the username) and `AUTH_PASSWORD` set in an `.env` file, followed by a restart, and it advises at least 8 characters and avoiding the characters `' \" \\ ` and `$` in the password. That guide's own check is a 302 redirect to `/login` from `curl -I` on the container's host port. With the mapping above, `curl -I http://127.0.0.1:5080/` should do the same instead of serving the dashboard.",
        "The built-in Flare Tunnel is a quick share only: the docs warn that anyone with the tunnel URL can try to open your instance.",
      ],
    },
    {
      heading: "HTTPS with a reverse proxy",
      paragraphs: [
        "A login over plain HTTP sends your password in the clear, so put HTTPS in front. The project's guide shows Apache with Let's Encrypt; Caddy is shorter because it gets and renews certificates itself. Point a DNS A record for your domain at the server, open ports 80 and 443, install Caddy, and use a Caddyfile like this:\n\n```\nagent.example.com {\n  reverse_proxy 127.0.0.1:5080\n}\n```\n\nReload Caddy and open `https://agent.example.com`. Caddy's documentation says it serves HTTPS automatically when it knows the domain name, with ports 80 and 443 open to the public, and that `reverse_proxy` supports WebSocket connections. The project's own guide tests WebSockets with `wscat -c wss://<domain>/ws`.",
        "With Nginx or Apache instead, pass WebSocket upgrade headers through. Once HTTPS works and the login is confirmed, close your SSH tunnel and use the domain.",
      ],
    },
    {
      heading: "Choosing a model provider",
      paragraphs: [
        "Agent Zero needs a model. On first run, [onboarding](https://www.agent-zero.ai/p/docs/onboarding/) offers three paths:",
        "- **Cloud:** paste an API key for a hosted provider such as OpenRouter, OpenAI, Anthropic, Google or Venice.\n- **Account:** sign in with an existing account, such as Codex with ChatGPT, GitHub Copilot, Google Cloud Gemini or xAI Grok.\n- **Local:** point it at a model server you run, such as Ollama, LM Studio, oMLX, llama.cpp or vLLM. Inside the container, `localhost` means the container itself, and the plain Linux `docker run` above does not add the host alias that Agent Zero's Ollama default expects. Follow the networking steps in the project's [installation guide](https://github.com/agent0ai/agent-zero/blob/main/docs/setup/installation.md), use an address Docker can reach, and keep port 11434 closed to the public.",
        "You pick a main model and a utility model. The utility model handles quick internal jobs such as summaries, naming and memory, and the docs recommend a small, fast, low-cost one.",
        "Three gotchas from the troubleshooting page. Chat input does nothing until you have finished model setup in Settings, which means a key for a hosted provider, an account sign-in, or a reachable local model. \"Invalid model ID\" usually means the provider and model name do not match: OpenRouter needs a prefix such as `openai/gpt-5.3`, while the native OpenAI provider does not. And a ChatGPT Plus subscription does not include API credits, so for the OpenAI API you need your own API key.",
        "Put a spending limit on the provider account too, because an agent stuck in a loop costs real money (our [guide to cutting API costs](/blog/ai-agent-api-cost-optimization) covers where it goes). For the wider safety picture, read [is it safe to leave an AI agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended).",
      ],
    },
    {
      heading: "Updating Agent Zero",
      paragraphs: [
        "For normal releases, use the built-in updater: Settings, then Update, then Self Update. The [updating guide](https://www.agent-zero.ai/p/docs/updating/) and the install guide describe it, and the app prompts you when a new version ships. The install guide says backups are managed internally during the update, but take your own backup first anyway.",
        "A major version is different. Self Update can flag a newer major line, but for the jump from v1 to v2 the docs say you must pull the new image and move your data across. The same manual method works any time you want a safe rollback:\n\n```\nsudo docker pull agent0ai/agent-zero:latest && \\\n  sudo docker run -d --name agent-zero-new \\\n  --restart unless-stopped \\\n  -p 127.0.0.1:5081:80 \\\n  -v a0_usr_new:/a0/usr \\\n  agent0ai/agent-zero:latest\n```\n\nThe `&&` means the new container only starts if the pull worked, so you never test a stale cached image by mistake. Confirm it is up with `sudo docker ps --filter name=agent-zero-new` before you touch the old one. If it isn't listed, run `sudo docker ps -a --filter name=agent-zero-new`: no entry means the pull failed, so retry it; an exited entry means it failed to start (a port already in use, for example), so read `sudo docker logs agent-zero-new`, fix the cause, remove it with `sudo docker rm agent-zero-new` and run the command again. Your old container keeps serving the whole time.\n\nOnce the new one is up, freeze the old one so no chat is lost: let any running task finish, set each scheduled task to Disabled (note which ones) and stop chatting, then create and download a fresh in-app backup, then run `sudo docker stop agent-zero`. Your public address is down from here until the switch, so pick a quiet moment. Open the new one over a tunnel on port 5081 and restore that backup into it through Backup & Restore. If you set your login with `AUTH_LOGIN` and `AUTH_PASSWORD` in `/a0/.env`, set it again in the new one under Settings, then Authentication: that file sits outside `/a0/usr`, so neither the volume nor the backup carries it. Then check four things: the new container runs the image you just pulled (the IDs from `sudo docker inspect --format '{{.Image}}' agent-zero-new` and `sudo docker image inspect --format '{{.Id}}' agent0ai/agent-zero:latest` match), your chats and memory are there, the login page still appears (a 302 to `/login` from `curl -I http://127.0.0.1:5081/`), and a test prompt gets a model reply. The troubleshooting page says backups do not always include `secrets.env`, so if the model call fails, re-enter your provider key in Settings or copy `/a0/usr/secrets.env` over from the old container. Next, change the Caddyfile to `reverse_proxy 127.0.0.1:5081`, reload Caddy, and test your HTTPS address. Keep the old container (stopped, data intact) until that works, then remove it. Then set the scheduled tasks you disabled back to Idle on the container you keep, whether that is the new one or, after a rollback, the old one. If the new one fails while the old container still exists, start the old container again, point Caddy back at the port it used (5080 the first time; note the live name and port before every upgrade), reload Caddy, and check your HTTPS address loads before you call the rollback done. Anything chatted on the new one in between stays on its volume, so run that HTTPS check straight after the switch, before you use the agent. After the switch, your live container is `agent-zero-new` with the volume `a0_usr_new`, so use those two names wherever the commands below say `agent-zero` and `a0_usr`. For the next upgrade after that, treat whichever container is live as the old one and pick a name, port and volume you have not used yet (for example `agent-zero-v3`, `5082` and `a0_usr_v3`).",
        "Do not copy the update command in the VPS guide verbatim: its final line is malformed, so write the full command yourself as above. And stay current: an old version on a public server is the risk you took on by self-hosting.",
        "If an update leaves the UI stuck on the updating screen, the troubleshooting page says to reload, then restart the container, and if that fails to queue another self-update and read its log:\n\n```\nsudo docker exec -it agent-zero /exe/trigger_self_update.sh\nsudo docker restart agent-zero\nsudo docker exec -it agent-zero tail -n 200 /exe/a0-self-update.log\nsudo docker exec -it agent-zero cat /exe/a0-self-update-status.yaml\n```\n\nThe script only schedules the update, so the restart comes before you read the log and status: they report on the attempt made at that startup.",
      ],
    },
    {
      heading: "Backing up the usr folder",
      paragraphs: [
        "Your agent's memory, chats, projects, plugins and settings are all in `/a0/usr`, so that is the one thing to back up. There are two layers.",
        "**In the app.** Settings, then Backup & Restore, then Create Backup (the install guide lists it under Settings, then Check for Updates, so look there if you do not see it). The usage guide says backups cover chats, projects, knowledge, memory, settings, skills and workspace files, and that secrets may not always be included. Download the zip and keep it off the server.",
        "**At the volume.** A plain Docker volume copy does not depend on the app. This is a standard Docker pattern, not an Agent Zero command:\n\n```\nmkdir -p ~/a0-backups && chmod 700 ~/a0-backups && \\\n  sudo docker stop agent-zero && \\\n  sudo docker run --rm -v a0_usr:/data -v ~/a0-backups:/backup alpine \\\n    tar czf \"/backup/a0_usr-backup-$(date +%F-%H%M).tar.gz\" -C /data .\nsudo docker start agent-zero\nsudo chown \"$USER\": ~/a0-backups/a0_usr-backup-*.tar.gz\nchmod 600 ~/a0-backups/a0_usr-backup-*.tar.gz\n```\n\nStopping the container first means no file changes while `tar` runs, so the copy is consistent. The `&&` chain means nothing is stopped unless the private folder is ready, and the copy only runs if the stop worked. The `chown` hands the root-written archive back to you so you can copy it off the server. If `tar` printed an error (a full disk, say), delete that file: it is incomplete, and your previous dated backup is still the good one. The archive gets a new dated name each time, so an earlier backup is never overwritten, and it holds your provider key in `secrets.env`, which is why it goes in a folder only you can open and is set to owner-only. If the copy fails, run `sudo docker start agent-zero` anyway and keep your previous backup. Copy the file to another machine or storage you control; a backup on the same server will not survive losing it. Test a restore once, on a throwaway volume that never touches the live one:\n\n```\nsudo docker rm -f agent-zero-test 2>/dev/null; sudo docker volume rm a0_usr_test 2>/dev/null\nsudo docker volume create a0_usr_test && \\\n  sudo docker run --rm -v a0_usr_test:/data -v ~/a0-backups:/backup alpine \\\n    tar xzf /backup/a0_usr-backup-YYYY-MM-DD-HHMM.tar.gz -C /data && \\\n  sudo docker run -d --name agent-zero-test -p 127.0.0.1:5090:80 \\\n    -v a0_usr_test:/a0/usr agent0ai/agent-zero:latest\n```\n\nOpen port 5090 over your tunnel, check your chats and memory are there, then remove the test container and the `a0_usr_test` volume.",
      ],
    },
    {
      heading: "Common failures and fixes",
      paragraphs: [
        "- **The page will not load.** You need a host port mapped to container port 80. Check `sudo docker ps` shows `127.0.0.1:5080->80/tcp`, then test with `curl -I http://127.0.0.1:5080/`. A 302 to `/login` means it is up.\n- **502 or 504 from the proxy.** A 502 means the container is stopped or the port is wrong: run `sudo docker ps` and `sudo docker logs agent-zero`. A 504 means the container is overloaded or unresponsive: run `sudo docker stats`, and resize the server if a 2 GB machine is full.\n- **Settings will not load.** The install guide says to remove `/a0/usr/settings.json` and restart to regenerate defaults. Copy the file aside first (for example to `settings.json.bak`) so you can put it back if the reset does not help.\n- **Login behaves oddly after an upgrade.** Check where your `.env` lives, as covered above, and restart the container after any change.",
        "Never publish the port to the whole internet just to test. Use the SSH tunnel.",
      ],
    },
    {
      heading: "Running Agent Zero on Hivra instead",
      paragraphs: [
        "Everything above is a job you do once and then keep doing: patching the server, watching disk and memory, keeping the login and certificates healthy. Hivra provisions the machine and the container for you, so there is no server for you to run, and you are not tied to one agent: the same account can run Agent Zero today and a different agent tomorrow.",
        "- **More than one agent.** The same Hivra account launches [Hermes](/agents/hermes), [OpenClaw](/agents/openclaw), [Claude Code](/agents/claude-code), [Codex](/agents/codex) and [Agent Zero](/agents/agent-zero), each on a computer of its own, and you reach them from a browser. If Agent Zero turns out not to be the right fit, you switch agents on the same account instead of rebuilding a server.\n- **The real Agent Zero.** Hivra hosts the open-source stack in its own container on a separate VM, with the browser and computer tools the project supplies, and you use Agent Zero's native dashboard.\n- **A protected dashboard.** It is reached through an authenticated gateway, with login details created during provisioning, so there is no Docker install, proxy or certificate for you to get wrong.\n- **Your choice of model.** Set your own provider in Agent Zero's Settings, or pay with Hivra credits where they are available.\n- **It stays on.** Paid Hivra computers are not paused for inactivity, so the environment is still there after you close the page.\n- **Your own server.** Agent Zero can also run on a Proxmox server you connect, and a free account works with a server you connect yourself.",
        `Every computer Hivra Cloud runs for you needs a paid plan. Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}. Agent Zero's minimum on Hivra is 1 vCPU and 2 GB of RAM, so the entry plan leaves room, though heavier browser use needs more.`,
        "Honest limits. Hivra is independent and not affiliated with or endorsed by the Agent Zero project. The VM keeps the agent apart from your own computer, but that does not remove the risks of agent mistakes or credentials with too much access, and Hivra administrators have infrastructure access to managed hosts, so keep keys tightly scoped. Backups are not something Hivra promises, so keep your own copy of anything important. If you want full control of the network layer, firewall rules, or a specific region or provider, a VPS you run yourself fits better.",
        "[Launch Agent Zero on Hivra](/agents/agent-zero) if you would rather spend the evening on what the agent does than on the server it runs on. See also [managed vs self-hosted](/blog/managed-vs-self-hosted-ai-agents) and [Hivra vs self-hosted VPS](/compare/vs-self-hosted).",
      ],
    },
  ],
  faqs: [
    {
      q: "What are the requirements to self-host Agent Zero?",
      a: "The project's VPS guide lists 1 vCPU and 2 GB RAM as the minimum, 2 vCPU and 4 GB or more recommended, 20 GB of disk (50 GB recommended), 64-bit Linux such as Ubuntu 22.04 or newer, and Docker Engine 24.0 or newer (28.0.0 or newer for the loopback port binding in this guide, because earlier versions let hosts on the same network segment reach a port published to 127.0.0.1). No GPU is needed unless you run a local model on the same machine.",
    },
    {
      q: "What is the Agent Zero Docker command?",
      a: "The image is agent0ai/agent-zero. The README's command is docker run -d -p 127.0.0.1:5080:80 -v a0_usr:/a0/usr agent0ai/agent-zero. On a server, add a name and a restart policy: docker run -d --name agent-zero --restart unless-stopped -p 127.0.0.1:5080:80 -v a0_usr:/a0/usr agent0ai/agent-zero.",
    },
    {
      q: "Which port does Agent Zero use?",
      a: "Port 80 inside the container. Map any host port to it, such as 5080 in the project's examples, publish it to 127.0.0.1 only, and put a reverse proxy on ports 80 and 443 in front.",
    },
    {
      q: "Where does Agent Zero store its data?",
      a: "In /a0/usr inside the container: settings, projects, memory, custom plugins and chats. Mount only that folder as a volume, never the whole /a0 directory. Secrets live in /a0/usr/secrets.env, which backups do not always include, so copy that file yourself.",
    },
    {
      q: "How do I add a password to Agent Zero?",
      a: "Open Settings, then Authentication, and set a UI login username and password. Do this before exposing it to the internet. The project's VPS guide also describes AUTH_LOGIN and AUTH_PASSWORD in an .env file. A working login redirects to /login instead of serving the dashboard.",
    },
    {
      q: "How do I update Agent Zero in Docker?",
      a: "Back up first, then use Settings, Update, Self Update for normal releases. For a major version, pull agent0ai/agent-zero:latest, start a new container on another port with a fresh volume, restore your backup into it, check your data, and only then remove the old container.",
    },
    {
      q: "Can I run Agent Zero for free?",
      a: "The software is open source and free to run. You still pay for the server if you rent one, and for model usage unless you run a local model. Some providers have free tiers, according to the project's troubleshooting page, but limits and terms are the provider's.",
    },
    {
      q: "Is Hivra the official Agent Zero host?",
      a: "No. Hivra is an independent host that runs the open-source Agent Zero project on a computer of its own and is not affiliated with or endorsed by the project.",
    },
  ],
  relatedArticles: [
    { slug: "agent-zero-vs-openclaw-hosting", title: "Agent Zero vs OpenClaw hosting: requirements, costs, and which to run" },
    { slug: "ai-agent-vps", title: "AI agent VPS guide: specs, providers, and setup that actually works (2026)" },
    { slug: "how-to-self-host-openclaw", title: "How to self-host OpenClaw: complete setup guide (2026)" },
    { slug: "managed-vs-self-hosted-ai-agents", title: "Managed vs self-hosted AI agents" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended?" },
  ],
  relatedComparisons: [{ slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" }],
};

// blog-data.ts imports `article` from every module.
export const article = howToSelfHostAgentZero;
