import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE } from "../plan-facts";

// Written 2026-11-17 for the "Hermes Agent in the cloud" searches where Search Console showed hivra.cloud's homepage
// with no clicks (28 days to 14 Nov: "hermes cloud" 267 impressions at position 8, "hermes server" 59 at 59,
// "hermes agent" 42 at 23, "hermes on cloud", "hermes agent cloud", "hermes agent server", "hermes agent hosting").
// It is the hub page; install detail stays in how-to-self-host-hermes-agent and VPS prices in best-vps-for-hermes-agent.
// Nous docs fetched 2026-11-17:
// https://hermes-agent.nousresearch.com/docs/getting-started/installation (install.sh, layout, libatomic1, channels,
//   Desktop "Settings → Gateways" remote backend, hermes import / profile import)
// https://hermes-agent.nousresearch.com/docs/user-guide/docker (latest/stable/main/X.Y.Z tags, /opt/data, s6 supervision,
//   port 8642 API gated on API_SERVER_ENABLED, dashboard 9119 + auth providers, browser-console warning)
// Nous Hermes Cloud figures: lib/compare/competitor-facts.ts (last published; sizes and prices now behind Portal sign-in).
// Hivra facts: docs/STATUS.md (new Hermes launches get a Hivra computer running Hermes's own installer and web UI,
// updated with `hermes update`), lib/launch/contracts.ts (Hermes ownServer false), lib/blog/plan-facts.ts.
// Not claimed: affiliation with Nous; that Hivra runs Hermes on your own server; backups; setup times.

export const article: BlogArticle = {
  slug: "hermes-agent-cloud",
  title: "How to run Hermes Agent in the cloud: VPS, Docker, Nous Hermes Cloud or a computer of its own",
  metaTitle: "Hermes Agent in the cloud: every way to run it 24/7",
  metaDescription:
    "Four ways to run Hermes Agent on a server so it keeps working when your laptop is shut: a VPS, Docker, Nous Hermes Cloud, or a managed computer.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-17",
  readingTimeMin: 13,
  author: "Hivra team",
  tagline: "Your laptop is a bad home for an agent that's meant to work while you sleep.",
  intro:
    "Hermes Agent is built to remember things, run scheduled jobs and answer you on Telegram at 3am. None of that works if it lives on a laptop that goes to sleep. Here are the four real ways to give Hermes a home in the cloud, what each one costs you in money and upkeep, and how to pick.",
  shortAnswer:
    "To run Hermes Agent in the cloud, rent a Linux server (community setups start at 2 vCPU and 4 GB RAM) and run Nous's install script or the official Docker image, use Nous's own Hermes Cloud, or use a managed host such as Hivra. All four keep Hermes's gateway, memory and scheduled jobs running while your computer is off.",
  sections: [
    {
      heading: "Why Hermes wants a server, not your laptop",
      paragraphs: [
        "Hermes does three things that need a machine that stays on. Its gateway listens for your messages on Telegram, Discord, Slack or WhatsApp. Its scheduler runs cron jobs you set up, like a morning research brief. And its memory and skills live in a data folder (`~/.hermes/` on Linux and macOS) that it reads and writes as it works.",
        "Close your laptop's lid and all three stop. Messages queue up unanswered, the 7am job never fires, and the agent picks up where it left off only when you open the lid again. That's fine for trying Hermes out. It's not fine for an agent you want to rely on.",
        "So \"Hermes in the cloud\" really means one thing: the Hermes process and its data folder live on a computer that stays on, and you talk to it from wherever you are. There are four ways to get there.",
      ],
    },
    {
      heading: "The four options at a glance",
      paragraphs: [
        [
          "| Option | What you run | What you maintain | Rough monthly cost before model usage | Best for |",
          "|---|---|---|---|---|",
          "| VPS + Nous's install script | Hermes as a normal Linux service | The OS, firewall, updates, the gateway service | About €5 to €10 for a 2 to 4 vCPU server | People happy on a Linux command line |",
          "| VPS + official Docker image | Hermes inside `nousresearch/hermes-agent` | The server, the data volume, image updates | Same server cost | People who already run things in Docker |",
          "| Nous Hermes Cloud | A Hermes instance Nous runs for you | Your Portal credit balance | About $16.80 for 30 days of the 4 vCPU, 2 GB size at its last published rate | People already paying for Nous Portal |",
          `| Hivra computer | Hermes on a private computer Hivra starts for it | Your model key or credits, and what you ask it to do | ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE} | People who want Hermes running without a server to look after |`,
        ].join("\n"),
        "Model usage is extra on every option. Hermes needs a model provider (OpenRouter, Anthropic, OpenAI, Nous Portal, Venice and others), and that bill depends on how much the agent does, not where it runs.",
        "A fifth option people ask about is a spare computer at home, like a Mac mini or an old PC. It works the same way as a VPS, and it's free if you already own the machine. The trade-offs are your home internet, power cuts, and opening your network to the outside if you want a web UI. For chat over Telegram or Discord you don't need to open any ports, because the gateway connects outwards.",
      ],
    },
    {
      heading: "Option 1: a VPS with Nous's install script",
      paragraphs: [
        "This is the most common route and the one Nous's own docs lead with. You rent a small Linux server, install Hermes with one command, and run its gateway as a background service.",
        "**Pick a server.** Nous tests on the latest Ubuntu and its docs give no minimum specs. In community setups, 2 vCPU and 4 GB RAM is the floor most people land on, and below 4 GB, browser tools and bigger tasks tend to run out of memory. 4 vCPU and 8 GB gives you more room for the Docker sandbox and the browser at the same time. Our [VPS comparison for Hermes](/blog/best-vps-for-hermes-agent) has current specs and prices from Hetzner, OVH, DigitalOcean and Vultr.",
        "**Install Hermes.** SSH in as a normal user (not root) and run Nous's installer:\n\n```\ncurl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash\nsource ~/.bashrc\nhermes setup\n```\n\nThe script puts the code in `~/.hermes/hermes-agent/`, your data in `~/.hermes/`, and a `hermes` command in `~/.local/bin/`. It brings its own Python, Node.js and a pinned Chromium for the browser tools. On minimal Ubuntu and Debian images it also installs `libatomic1`, which its Node.js needs. If you don't want the browser on a small server, add `--skip-browser`.",
        "**Keep it running.** Set up a chat channel with `hermes gateway setup`, then install the gateway as a user service so it survives logouts and reboots:\n\n```\nhermes gateway install\nhermes gateway start\nsudo loginctl enable-linger $USER\n```\n\nThe last line matters. Without it, a user service stops when you log out of SSH, which is the most common reason people's Hermes \"goes quiet\" overnight.",
        "Our [full self-hosting walkthrough](/blog/how-to-self-host-hermes-agent) covers the firewall, a non-root user, the Docker terminal sandbox and the errors people hit most.",
      ],
    },
    {
      heading: "Option 2: the official Docker image",
      paragraphs: [
        "Nous publishes Hermes as `nousresearch/hermes-agent` for amd64 and arm64. All your config, keys, sessions, skills and memories live in one folder on the host, mounted into the container at `/opt/data`. The image itself holds nothing you'd lose, so upgrading is a `docker pull` and a restart.",
        "First run the setup wizard once:\n\n```\nmkdir -p ~/.hermes\ndocker run -it --rm -v ~/.hermes:/opt/data nousresearch/hermes-agent setup\n```\n\nThen start the gateway in the background:\n\n```\ndocker run -d --name hermes --restart unless-stopped \\\n  -v ~/.hermes:/opt/data \\\n  nousresearch/hermes-agent gateway run\n```",
        "A few details from Nous's Docker guide that save real pain:",
        "- **Pick your tag on purpose.** `latest` and `stable` follow stable releases. `main` is the development build. A version number like `X.Y.Z` pins a release, and a digest pins it exactly.\n- **The gateway restarts itself.** In the current image, `gateway run` is supervised by s6-overlay, so a crashed gateway comes back within seconds without the container dying. Older tini-based images didn't do this.\n- **Don't publish ports you don't need.** Port 8642 is an OpenAI-compatible API, and it's off unless you set `API_SERVER_ENABLED=true`. If you only chat over Telegram or Discord, publish nothing.\n- **The dashboard needs a login now.** With `HERMES_DASHBOARD=1` the web dashboard runs on port 9119. Since Nous's June 2026 hardening, a dashboard bound to a public address requires an auth provider: a username and password, Nous Portal sign-in, or your own OIDC provider. The old \"insecure\" switch no longer turns that off.\n- **Use SSH, not your host's browser console.** Nous warns that some browser consoles (Hetzner's included) mangle characters like `:` and `@`, which quietly breaks `-v ~/.hermes:/opt/data` and pasted keys.",
        "Docker can also mean something else with Hermes: running Hermes on the host and using Docker only as a sandbox for the shell commands it runs (`terminal.backend docker`). That's a safety setting, not a hosting choice, and you can use it with Option 1.",
      ],
    },
    {
      heading: "Option 3: Nous Hermes Cloud",
      paragraphs: [
        "Nous Research, who make Hermes, run their own hosted version through the Nous Portal. You buy credit, deploy an instance, and pay by the second while it runs. Its last published price for the 4 vCPU, 2 GB size was $0.56 a day running and $0.03 a day stopped, which is about $16.80 for a month of running all the time. You need at least $2 of credit to deploy. Nous now shows sizes and prices only after you sign in, so check the Portal for today's numbers.",
        "It suits you if you already use Nous Portal for models, because one account covers both. The metered price also works well if you only run the agent some of the time. If it runs all month, compare the total against a fixed monthly price. Our [side-by-side with Hivra](/compare/vs-nous-hermes-cloud) goes through both in detail.",
      ],
    },
    {
      heading: "Option 4: a managed computer on Hivra",
      paragraphs: [
        "Hivra gives each agent a private cloud computer of its own. When you launch Hermes on Hivra, Hivra starts the computer and runs Hermes's own installer on it, so you get the same Hermes the steps above would give you, with its own web app for chat. You update it the same way too, with `hermes update` or the update button in Hermes's app.",
        `There is no server, firewall or service file for you to look after. You pick a model provider with your own key or pay with Hivra credits, and the computer stays on so the gateway and scheduled jobs keep running while you're away. Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}.`,
        "Two honest limits. Hermes on Hivra runs on Hivra Cloud only, so you can't point Hivra at your own server for Hermes (you can for OpenClaw, Claude Code, Codex and Agent Zero). And Hivra is not affiliated with Nous Research: Hermes is Nous's open-source project, and Hivra hosts it.",
        "[Launch Hermes on Hivra](/agents/hermes) if you'd rather spend the evening on what the agent does than on the server it runs on.",
      ],
    },
    {
      heading: "How to talk to Hermes once it's in the cloud",
      paragraphs: [
        "A cloud Hermes is only useful if reaching it is easy. You have four ways in, and you can use more than one:",
        "- **Chat apps.** Telegram is the most popular because setup is a bot token and your user id. Set `TELEGRAM_ALLOWED_USERS` to your own user id so only you can talk to your agent. Our [Telegram setup guide](/blog/how-to-set-up-hermes-agent-telegram) walks through it.\n- **Hermes Desktop.** The desktop app can connect to a Hermes backend on another machine from Settings → Gateways, so your Mac or Windows app talks to the agent on your server.\n- **The web dashboard or web app,** behind the login described above.\n- **SSH and the terminal.** `hermes` on the server opens the same agent with all its memory.",
      ],
    },
    {
      heading: "Moving an existing Hermes to the cloud",
      paragraphs: [
        "If Hermes already runs on your laptop, you don't have to start again. Nous documents two tools for this. `hermes backup` on the old machine and `hermes import` on the new one move everything. `hermes profile export` and `hermes profile import` move a single agent profile, but leave credentials out on purpose, so you'll re-enter your keys.",
        "With Docker, copying the whole `~/.hermes` folder to the server and mounting it at `/opt/data` does the same job. Stop Hermes on the old machine first, so two copies aren't answering the same Telegram bot.",
      ],
    },
    {
      heading: "Security checklist for a cloud Hermes",
      paragraphs: [
        "An agent with your API keys, a shell and a browser on a public server deserves ten minutes of care:",
        "- Run Hermes as a normal user, not root.\n- Turn on a firewall that allows SSH and nothing else, unless you deliberately serve a web UI.\n- Keep the dashboard behind its login, a VPN or an SSH tunnel. Never publish it bare.\n- Set an allowlist on every chat channel.\n- Put a spending limit on your model provider account. An agent stuck in a loop at 3am can run up a bill.\n- Use `terminal.backend docker` so the commands Hermes runs happen in a sandbox, not on the host.\n- Review new skills before you give them access to anything sensitive.",
        "Our guide on [leaving an agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended) goes further.",
      ],
    },
    {
      heading: "Keeping it updated",
      paragraphs: [
        "On a script install, `hermes update` follows the stable channel the installer picked. Nous's installer can also track `main` with `--channel main` if you want every change as it lands, at the cost of more breakage. After an update, run `hermes doctor` and restart the gateway service.",
        "On Docker, pull the tag you chose and recreate the container. Your data folder isn't touched. If an update breaks something, go back to the previous version number and keep your data where it is.",
      ],
    },
    {
      heading: "Which one should you pick?",
      paragraphs: [
        "Pick a **VPS with the install script** if you like Linux and want the cheapest always-on setup with full control.",
        "Pick **Docker** if your server already runs other containers and you want upgrades to be a pull.",
        "Pick **Nous Hermes Cloud** if you're already on Nous Portal or only run the agent part of the time.",
        "Pick **a Hivra computer** if you want Hermes running on its own computer today without becoming its sysadmin.",
        "Whichever you choose, the agent you get is the same open-source Hermes. The choice is only about who looks after the computer it lives on.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can Hermes Agent run in the cloud?",
      a: "Yes. Hermes runs on any Linux server through Nous's install script or the official nousresearch/hermes-agent Docker image. Nous also runs a hosted version, Nous Hermes Cloud, and managed hosts such as Hivra give it a computer of its own.",
    },
    {
      q: "What server specs does Hermes Agent need?",
      a: "Nous's docs give no minimum specs and say they test on the latest Ubuntu. In community setups, 2 vCPU and 4 GB RAM is the usual floor, because browser tools and larger tasks tend to run out of memory below it. 4 vCPU and 8 GB is more comfortable if you use the Docker sandbox and the browser together.",
    },
    {
      q: "Does Hermes keep running when I close my laptop?",
      a: "Not if it runs on the laptop. A sleeping computer runs nothing, so the gateway and scheduled jobs stop until you wake it. Run Hermes on a server or a managed computer if you want it working while you're away.",
    },
    {
      q: "What is the Hermes Agent Docker image called?",
      a: "nousresearch/hermes-agent. The latest and stable tags follow stable releases, main is the development build, and version tags pin a release. Mount your data folder at /opt/data.",
    },
    {
      q: "How much does it cost to run Hermes Agent in the cloud?",
      a: "A small VPS costs roughly €5 to €10 a month before VAT. Nous Hermes Cloud's last published rate for its 4 vCPU, 2 GB size works out to about $16.80 for a month of running all the time. Model usage is extra everywhere and depends on how much the agent does.",
    },
    {
      q: "Can I use Hermes Desktop with a Hermes running on a server?",
      a: "Yes. Install a Hermes Desktop package, then connect it to the remote backend from Settings → Gateways.",
    },
    {
      q: "Is it safe to expose the Hermes dashboard to the internet?",
      a: "Only behind a login. Since June 2026 the dashboard requires an auth provider when it listens on a public address: a username and password, Nous Portal sign-in, or your own OIDC provider. A VPN or SSH tunnel is safer still.",
    },
    {
      q: "Is Hivra part of Nous Research?",
      a: "No. Hermes is Nous Research's open-source project. Hivra is an independent host that gives Hermes a private cloud computer and installs it with Hermes's own installer.",
    },
  ],
  relatedArticles: [
    { slug: "how-to-self-host-hermes-agent", title: "How to self-host Hermes Agent: VPS setup, Docker, or its own computer" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026: Hetzner, DigitalOcean, OVH compared" },
    { slug: "how-to-set-up-hermes-agent-telegram", title: "How to set up Hermes Agent on Telegram" },
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent? A plain-English explanation" },
  ],
  relatedComparisons: [
    { slug: "vs-nous-hermes-cloud", title: "Hivra vs Nous Hermes Cloud" },
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
  ],
};
