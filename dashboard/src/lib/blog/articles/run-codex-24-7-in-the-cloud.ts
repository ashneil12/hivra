import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "run-codex-24-7-in-the-cloud",
  title: "How to run Codex 24/7 in the cloud (Codex CLI hosting explained)",
  metaTitle: "How to run Codex 24/7 in the cloud",
  metaDescription:
    "The Codex CLI dies with your terminal. How to keep it alive: tmux, codex exec for headless runs, a DIY VPS, and managed hosting with your ChatGPT login.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-24",
  readingTimeMin: 8,
  author: "Hivra team",
  tagline: "Codex works as long as your terminal lives. Fix that.",
  intro:
    "OpenAI's Codex CLI is an interactive terminal agent. Close the terminal, drop the SSH connection, or let your laptop sleep, and the run dies with it. Here is how to give Codex a machine that stays awake: tmux, a cheap VPS, or a managed computer with your own ChatGPT login.",
  sections: [
    {
      heading: "The problem: Codex lives and dies with your terminal",
      paragraphs: [
        "The Codex CLI runs as a child of your shell. That gives it three failure modes that have nothing to do with the agent itself:\n\n- **Laptop sleep.** Lid closes, the OS suspends everything, Codex stops mid-task.\n- **SSH drop.** Running Codex on a remote machine? A dropped connection sends SIGHUP to your shell and Codex dies with it.\n- **Closed terminal.** Quit the app, lose the process.\n\nNone of these are Codex bugs. Any interactive CLI has the same constraint: it needs a live terminal on a machine that stays awake.",
        "Worth repeating because it trips people up: tmux on your laptop does not beat laptop sleep. tmux protects against disconnects. It cannot keep a suspended machine computing. The process has to live somewhere that stays awake. Not sure whether your current setup has one of these gaps? Run it through the [agent survival check](/tools/agent-survival-check).",
      ],
    },
    {
      heading: "Fix 1: tmux on an always-on machine",
      paragraphs: [
        "If you have a desktop, home server, or VPS that stays up, tmux keeps your Codex session alive across every disconnect:\n\n```bash\n# Start a named session and launch Codex inside it\ntmux new -s codex\ncodex\n\n# Detach without killing anything: press Ctrl+b, then d\n\n# Reattach later, from anywhere\ntmux attach -t codex\n```\n\nThe session runs on the server, not in your terminal app. Your connection can drop, your laptop can sleep, and Codex keeps working. `screen -S codex` does the same job if you prefer the older tool (detach with Ctrl+a d, reattach with `screen -r codex`).",
      ],
    },
    {
      heading: "Fix 2: codex exec for headless one-shot runs",
      paragraphs: [
        "Codex has a non-interactive mode built in. `codex exec` takes a prompt, runs the task without the interactive UI, and exits. Combine it with `nohup` and the run survives your logout:\n\n```bash\nnohup codex exec \"fix the failing tests and open a PR\" > codex-run.log 2>&1 &\n\n# Watch progress\ntail -f codex-run.log\n```\n\nRight tool for fire-and-forget jobs. Wrong tool when you want to steer the agent mid-task. For an interactive session you can leave and rejoin, use tmux.",
      ],
    },
    {
      heading: "Fix 3: the DIY VPS route",
      paragraphs: [
        "A small VPS costs $5-10/month and runs the Codex CLI fine. The setup:\n\n```bash\n# 1. SSH in\nssh root@your-vps-ip\n\n# 2. Install Node.js, then the Codex CLI\ncurl -fsSL https://deb.nodesource.com/setup_22.x | bash -\napt-get install -y nodejs\nnpm install -g @openai/codex\n\n# 3. Sign in with your ChatGPT account. On a headless server,\n#    the device-code flow avoids opening a browser on the server\ncodex login --device-auth\n\n# 4. Run inside tmux so it survives disconnects\ntmux new -s codex\ncodex\n```\n\nDetach and walk away. The agent keeps working on the server.",
        "The hidden costs of DIY, stated plainly:\n\n- **Setup and auth friction.** The ChatGPT login on a headless server means moving a code between machines. Budget an hour or two total.\n- **Maintenance.** Node updates, CLI updates, OS patches, disk cleanup. All yours now.\n- **Security.** A public server with your logged-in agent on it. SSH keys only, firewall on. Also yours.\n- **No interface.** SSH is the whole experience. No browser view, no file browser, nothing friendly on a phone.",
      ],
    },
    {
      heading: "Fix 4: managed Codex hosting",
      paragraphs: [
        `[Hivra](/) runs the official OpenAI Codex CLI on a private virtual machine provisioned for you. Hivra's chat runs it with approvals and the Codex sandbox bypassed by default inside that VM, and the Permissions setting on the agent's Manage tab narrows that to Limited (workspace sandbox) or Read-only. What the product actually ships:\n\n- **Your own ChatGPT login.** After launch, you sign in with your own ChatGPT account on the computer, or provide your own OpenAI API key inside Codex. The login is stored on that VM.\n- **Browser access to the computer.** Chat, terminal, files, and skills tabs wrap the standard CLI, so you can check on it from any device.\n- **Optional live self-hosted browser.** Turn on browser automation and the Codex computer gets a real Chrome browser the agent can drive.\n- **A machine that stays on, with one rule to know.** ${CLI_RUN_LIFETIME}\n- **A Terminal tab with tmux installed.** The computer's Terminal tab, under Computer, is a plain shell with tmux ready. Start a long run inside tmux there and it keeps going after you close the tab.\n\nLaunch it from [the Codex agent page](/agents/codex).`,
        `Plan facts: paid plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, enough for Codex with the browser on. Paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. Numbers on [the pricing page](/pricing). Hivra is independent and is not affiliated with OpenAI.`,
      ],
    },
    {
      heading: "DIY vs managed",
      paragraphs: [
        `| | DIY VPS + tmux | Hivra managed |\n|---|---|---|\n| Cash cost | $5-10/mo | From ${ENTRY_PLAN_PRICE}/mo |\n| Setup | 1-2 hours of your time | Pick the agent, then sign in |\n| Login | Your ChatGPT account | Your ChatGPT account, entered on the computer |\n| Interface | SSH terminal only | Browser: chat, terminal, files, skills |\n| Agent browser automation | You install and maintain it | Optional toggle on the Codex computer |\n| Server setup | You | Done for you |\n| Root access to the machine | Yes | Managed VM, resize CPU/RAM in the dashboard |\n\nBoth routes end in the same place: the official Codex CLI, on your own OpenAI account, on a machine that stays on. The difference is who runs the server. On either one, put a long run where you know it survives a disconnect: tmux, \`codex exec\`, or on Hivra tmux in the computer's Terminal tab.`,
      ],
    },
    {
      heading: "Pick your route",
      paragraphs: [
        "- **One overnight task:** `nohup codex exec \"...\"` on any machine that stays awake.\n- **You own an always-on machine:** tmux. Free and done in a minute.\n- **Permanent setup, you like server work:** $5-10/month VPS plus tmux.\n- **Permanent setup, zero server work:** [deploy Codex on Hivra](/agents/codex), sign in with ChatGPT, and start long runs inside tmux in the computer's Terminal tab, so they keep going after you close the laptop.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can I run the Codex CLI on a server?",
      a: "Yes. Install Node.js, run npm install -g @openai/codex, sign in with codex login --device-auth, and start it inside tmux so it survives SSH drops. Any small $5-10/month VPS handles the CLI itself.",
    },
    {
      q: "Does Codex keep running when I close my terminal?",
      a: "Not by default. The CLI is a child of your shell and dies with it. Run it inside tmux or screen on an always-on machine, or use codex exec with nohup for one-shot headless runs. A managed computer stays up too; on Hivra, start long runs inside tmux in the computer's Terminal tab and they keep going after you close the laptop.",
    },
    {
      q: "Do I need an OpenAI API key to run Codex in the cloud?",
      a: "No. On Hivra you sign in with your own ChatGPT account on the computer after launch, the same login the CLI uses on your laptop. You can provide your own OpenAI API key inside Codex instead if you prefer. The login is stored on the agent's VM.",
    },
    {
      q: "How much does 24/7 Codex hosting cost?",
      a: `DIY: $5-10/month for a small VPS plus your setup and maintenance time. Managed on Hivra: plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, with browser automation available and no pausing for inactivity.`,
    },
    {
      q: "Is the hosted Codex modified in any way?",
      a: "No. Hivra runs the official OpenAI Codex CLI on a private VM. Hivra's chat runs it with approvals and the sandbox bypassed by default, and the agent's Manage tab can narrow that to Limited or Read-only. The chat, terminal, files, and skills tabs are a convenience layer around the standard CLI. Hivra is independent and is not affiliated with OpenAI.",
    },
    {
      q: "Can hosted Codex use a browser?",
      a: "Yes, optionally. The Codex computer on Hivra can run a live self-hosted browser (a real Chrome browser on the VM) that the agent drives for web tasks. It is a toggle, and turning it on adds 1 vCPU and 2 GB of RAM to the computer.",
    },
  ],
  relatedArticles: [
    {
      slug: "ai-agent-browser-automation-tools",
      title: "AI agent browser automation in 2026: Browser Use, Stagehand, Playwright, and Puppeteer",
    },
    { slug: "keep-claude-code-running-24-7", title: "How to keep Claude Code running 24/7" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser automation" },
  ],
};
