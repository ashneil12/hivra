import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "run-codex-24-7-in-the-cloud",
  title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7",
  metaTitle: "Codex cloud or your own computer? Run Codex 24/7",
  metaDescription:
    "Codex cloud keeps working while your laptop sleeps. Here's when it's enough, and when you'd want Codex on a computer that stays on instead.",
  publishedDate: "2026-07-15",
  lastModified: "2026-10-05",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "Four places to run Codex, and the one question that picks between them.",
  intro:
    "OpenAI announced reusable Codex cloud environments at DevDay on 29 September 2026 and is rolling them out gradually, so for some jobs you don't need a computer of your own any more. The table below puts it next to the Codex CLI on a computer that stays on, your laptop and a rented VPS.",
  shortAnswer:
    "Codex cloud runs coding tasks on OpenAI's computers and keeps going while your laptop sleeps. If your ChatGPT plan includes it and the job is one self-contained change to a GitHub repo, it's enough. Want a shell that stays up, with files outside GitHub? Run the Codex CLI in tmux on a computer that stays on.",
  sections: [
    {
      heading: "What is Codex cloud, and what changed on 29 September?",
      paragraphs: [
        "Codex cloud runs coding tasks on computers OpenAI manages. Since OpenAI's DevDay on 29 September 2026 ([TechCrunch's report](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/)), you set up an environment once (the repositories, dependencies, tools and access settings a task needs), publish it, and every new task starts from it in its own isolated workspace. OpenAI's [cloud environments docs](https://learn.chatgpt.com/docs/environments/cloud-environments) say you create and publish on desktop or web, then use it from web, mobile or the desktop app.",
        "Every OpenAI fact on this page comes from those docs, OpenAI's [pricing page](https://learn.chatgpt.com/docs/pricing), [authentication](https://learn.chatgpt.com/docs/auth), [remote connections](https://learn.chatgpt.com/docs/remote-connections), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [agent approvals](https://learn.chatgpt.com/docs/agent-approvals-security) and its [changelog](https://learn.chatgpt.com/docs/changelog). Other OpenAI docs are linked where they come up. There's also an older flow, Codex Cloud (Legacy). Code Review, Security Review and the existing Linear and GitHub integrations still run on it for now, and OpenAI says it plans to retire it.",
        "A quick word on names. OpenAI's docs say Codex Cloud. Its pricing table says Codex cloud. The plan cards on the same page say Codex on the web, and plenty of people just search \"codex web\". It's all one product (we couldn't find any OpenAI page announcing a rename), so we call it Codex cloud here.",
      ],
    },
    {
      heading: "Will Codex keep working when I close my laptop?",
      paragraphs: [
        "Yes, with Codex cloud. The work runs on OpenAI's computers, and OpenAI's cloud environments docs say tasks can continue while your computer is asleep. The Codex CLI on your laptop won't, because it needs the laptop awake. A computer that stays on, with the CLI inside tmux, keeps going too.",
        `On Hivra, what survives a closed laptop depends on where you start the run. ${CLI_RUN_LIFETIME}`,
        "Codex Remote is a fifth option with a catch. It lets you reach a Codex session on your own computer from your phone or another computer, but OpenAI's [remote connections docs](https://learn.chatgpt.com/docs/remote-connections) say the host has to run the ChatGPT desktop app on macOS or Windows, awake, online and signed in. Remote access stops if that computer sleeps or the app closes, and a Mac laptop with the lid closed needs an external display. For longer work OpenAI suggests a dedicated always-on Mac or Windows PC. The Codex agent on Hivra is the CLI, and we haven't tested Codex Remote on a Hivra computer.",
      ],
    },
    {
      heading: "Codex cloud, Codex on a Hivra computer, your laptop or a VPS: which should I use?",
      paragraphs: [
        "Pick by the job. One self-contained change to a GitHub repo goes to Codex cloud. Files outside GitHub and a shell you can rejoin go to a computer that stays on.",
        `| Route | Laptop closed | What it costs | Pick it when |\n|---|---|---|---|\n| OpenAI's Codex cloud | Yes, tasks keep going | Inside your ChatGPT plan (Plus: $20 a month) | One self-contained change to a GitHub repo, on a plan that lists it |\n| Codex CLI in tmux on a Hivra computer | Yes, if you start it inside tmux in the Terminal tab | ${ENTRY_PLAN_PRICE} a month (${ENTRY_PLAN_SIZE}) or ${LARGER_PLAN_PRICE} a month (${LARGER_PLAN_SIZE}), plus your ChatGPT plan or OpenAI API usage | Files outside GitHub, a shell you can rejoin |\n| Your laptop | No, it stops when the laptop sleeps | Your ChatGPT plan or an OpenAI API key | Short sessions at your desk |\n| A VPS you rent, with tmux | Yes, if you start it inside tmux | Hostinger KVM 2 (2 vCPU, 8 GB of RAM): $8.99 a month on the 24-month plan (paid upfront), then $14.99, plus your ChatGPT plan or OpenAI API usage | You like server work and want more hardware for the money, and can pay 24 months upfront |`,
      ],
    },
    {
      heading: "When is OpenAI's Codex cloud enough?",
      paragraphs: [
        "If the job is one self-contained change to a GitHub repo and your ChatGPT plan includes Codex cloud, use it. No server to look after. For that job Hivra can't beat it, and we won't pretend otherwise.",
        "OpenAI's [pricing page](https://learn.chatgpt.com/docs/pricing) lists Codex cloud for Plus ($20 a month as of October 2026), Pro (from $100 a month), Business and Enterprise or Edu. An API key doesn't get you in. The same page says API key access has no cloud features at all. The Free and Go cards only mention Codex in the desktop app. One oddity: OpenAI's [GitLab docs](https://learn.chatgpt.com/docs/third-party/gitlab) say the GitLab beta, which runs in Codex cloud, is open on every ChatGPT plan. So check that your own account shows Codex cloud before you count on it. For the dated Plus and Pro cards, see [Codex pricing by ChatGPT plan](/blog/codex-pricing-by-chatgpt-plan).",
        `Hardware isn't a reason to switch either. By default OpenAI gives each cloud task a VM with 2 vCPUs, 8 GiB of memory and 8 GiB of disk on Plus, and 4 vCPUs, 16 GiB and 32 GiB on Pro, Business and Enterprise. A Plus task VM has more memory than Hivra's ${ENTRY_PLAN_PRICE} a month plan, which is ${ENTRY_PLAN_SIZE}.`,
      ],
    },
    {
      heading: "What does Codex cloud leave out?",
      paragraphs: [
        "GitHub is the big one. Cloud environments check out GitHub repositories, and [OpenAI's docs](https://learn.chatgpt.com/docs/environments/cloud-environments) list GitLab and self-hosted GitHub Enterprise Server as not supported yet. There is a separate GitLab integration in beta since 19 August 2026 ([GitLab docs](https://learn.chatgpt.com/docs/third-party/gitlab)), but it starts legacy cloud chats, not the new environments.",
        "Computer use and browser use aren't supported in cloud environments yet either. Skills that live in your repo come along. Personal skills on your own machine don't.",
        "Then there's memory. A task's saved VM state can be recovered for up to 7 days after you last start a turn or resume it. After that it's gone, and a new task never picks up another task's uncommitted changes. Treat git as the only thing that lasts.",
        "Sign-in is ChatGPT only. An API key works for the CLI, the desktop app and the IDE extension, but not for cloud. If you log in with email and password, OpenAI wants MFA switched on first ([authentication page](https://learn.chatgpt.com/docs/auth)).",
        "Usage comes out of the same pool as everything else. OpenAI's [pricing page](https://learn.chatgpt.com/docs/pricing) says local messages and cloud chats share one allowance, cloud tasks can eat more of it, and weekly limits can kick in. You also pick, per environment, whether a task can reach the internet and which domains. How long can one cloud task run? None of the pages we read give a number, so we won't guess.",
      ],
    },
    {
      heading: "When does a computer that stays on make more sense?",
      paragraphs: [
        "When the work isn't a tidy task on a GitHub repo. Think files that aren't in git, or a shell you want to come back to. Codex cloud starts each new task in its own isolated workspace and, by default, recovers a task's saved state for up to 7 days. On a computer that stays on, your files and half-finished sessions are still there when you come back.",
        "Codex cloud and the CLI both sign in with ChatGPT, and one cloud environment can hold several GitHub repositories. So neither of those settles it. Still choosing between agents? [Claude Code vs Codex for 24/7 work](/blog/claude-code-vs-codex-24-7) compares them.",
        "What Hivra adds over a plain VPS is mostly setup you skip. The dashboard starts Codex's device-code sign-in for you. A Sign in with ChatGPT window shows a code, you type it into OpenAI's sign-in page with your own account, and Codex on the computer is signed in. No terminal. OpenAI's rule still applies, so switch on device code login (marked beta) in your ChatGPT security settings first. tmux is already installed, and the Terminal tab under Computer is a plain shell. Paid plans aren't paused for inactivity. You reach the computer from a browser, on a phone too. There's no native app.",
        `Now the trade-offs, because there are real ones. Hivra is a second bill on top of your ChatGPT plan, and it adds no Codex allowance. Codex on a Hivra computer still bills through your own ChatGPT or OpenAI account, from the same shared pool.`,
        `You also get less hardware per dollar. Hostinger's KVM 2 is 2 vCPU and 8 GB of RAM for $8.99 a month on its 24-month plan, paid upfront. Hivra's ${ENTRY_PLAN_PRICE} plan is ${ENTRY_PLAN_SIZE}. And Agent 37, which also hosts Codex, works out to $4.76 a month for an always-on 2 vCPU, 4 GB shape on its metered Cloud API, as long as you keep a prepaid balance topped up ([Hivra vs Agent 37](/compare/vs-agent-37) has the figures).`,
        "Two smaller ones. Hivra installs the Codex CLI version it has tested and turns off the startup update check, so you can trail OpenAI's newest release by a bit. And there's no SSH into the underlying server. You reach the computer from a browser, which also means you can't point the ChatGPT desktop app's SSH-host feature at it ([remote connections docs](https://learn.chatgpt.com/docs/remote-connections)). A VPS can do that.",
        "If you run Codex through Hivra's chat, it runs with approvals and the sandbox bypassed by default on the computer. That bypass is Codex's `--dangerously-bypass-approvals-and-sandbox` flag. OpenAI's approvals docs say to use it only inside a controlled environment, and the [skip-permissions guide](/blog/claude-code-dangerously-skip-permissions) sets it beside Claude Code's. The Permissions setting on the agent's Manage tab narrows that to Limited (workspace sandbox) or Read-only.",
      ],
    },
    {
      heading: "How do I run Codex 24/7 on my own server or a Hivra computer?",
      paragraphs: [
        "Install the CLI, sign in, and start it inside tmux on a machine that stays awake. The Codex CLI is an interactive terminal agent that runs as a child of your shell, so a laptop that sleeps, an SSH connection that drops or a terminal you close takes the run with it. tmux protects against disconnects. It can't keep a suspended laptop computing. Not sure your setup has a gap? Run it through the [agent survival check](/tools/agent-survival-check).",
        "**On a VPS or a home server.** One example: Hostinger's [VPS pricing page](https://www.hostinger.com/pricing/vps-hosting) lists KVM 2 with 2 vCPU, 8 GB of RAM and 100 GB of NVMe at $8.99 a month on its 24-month plan, paid upfront (about $216 in one payment by our arithmetic), renewing at $14.99 a month, as of October 2026. [Hivra vs Hostinger](/compare/vs-hostinger) has more. Then:\n\n```bash\n# 1. SSH in\nssh root@your-vps-ip\n\n# 2. Install Node.js, then the Codex CLI\ncurl -fsSL https://deb.nodesource.com/setup_22.x | bash -\napt-get install -y nodejs\nnpm install -g @openai/codex\n\n# 3. Sign in with your ChatGPT account. On a headless server,\n#    the device-code flow avoids opening a browser on the server\ncodex login --device-auth\n\n# 4. Run inside tmux so it survives disconnects\ntmux new -s codex\ncodex\n\n# Detach: Ctrl+b, then d. Reattach later: tmux attach -t codex\n```\n\nOpenAI's [authentication page](https://learn.chatgpt.com/docs/auth) marks device-code sign-in as beta, and you have to switch on device code login in your ChatGPT security settings first (or in workspace permissions, if an admin runs your workspace). A rented server is yours to look after, too: Node and CLI updates, OS patches, disk space, SSH keys and the firewall.",
        "**For a one-shot job**, `codex exec` runs a prompt and exits when it's done. Add nohup and the run survives your logout:\n\n```bash\nnohup codex exec --sandbox workspace-write \"fix the failing tests\" > codex-run.log 2>&1 &\n\n# Watch progress\ntail -f codex-run.log\n```\n\nBy default `codex exec` runs in a read-only sandbox, so it needs `--sandbox workspace-write` to edit files ([OpenAI's non-interactive mode docs](https://learn.chatgpt.com/docs/non-interactive-mode)). That sandbox keeps network access off by default ([approvals docs](https://learn.chatgpt.com/docs/agent-approvals-security)), so the run can't push or open a PR. It suits fire-and-forget jobs. To steer mid-task, use tmux.",
        `**On a Hivra computer** you skip the install. Launch Codex from [the Codex agent page](/agents/codex), sign in with ChatGPT in the window the dashboard opens, then open the Terminal tab, under Computer, and start Codex inside tmux. The [tmux cheat sheet](/tools/tmux-cheat-sheet) lists the keys. To pick a chat back up after Codex exits, see [how to resume a Codex session](/blog/codex-resume-session). Hivra runs the official Codex CLI on a private virtual machine. Plans are on [the pricing page](/pricing), with a ${MONEY_BACK_GUARANTEE}. Hivra is independent and is not affiliated with OpenAI.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Is Codex cloud free?",
      a: "No separate free Codex cloud plan. OpenAI's pricing page lists Codex cloud for Plus ($20 a month as of October 2026), Pro, Business and Enterprise or Edu, and says an API key gets no cloud features. The Free and Go cards only mention Codex in the desktop app. The exception is OpenAI's GitLab beta, which runs in Codex cloud and is open on every plan. Check what your own account shows.",
    },
    {
      q: "Can I use Codex cloud with an OpenAI API key?",
      a: "No. OpenAI's authentication page says Codex cloud requires signing in with ChatGPT, while the CLI, desktop app and IDE extension also accept an API key. On a Hivra computer the CLI takes either your ChatGPT sign-in or your own OpenAI API key.",
    },
    {
      q: "Does Codex cloud keep working when my laptop is closed or asleep?",
      a: "Yes. OpenAI's cloud environments docs say Codex Cloud runs coding tasks in the cloud so work can continue while your computer is asleep. Codex Remote is a separate feature, and OpenAI's docs say its host has to stay awake, online and signed in.",
    },
    {
      q: "Do I need GitHub to use Codex cloud?",
      a: "For the new cloud environments, the setup steps have you select GitHub repositories, and OpenAI's docs list GitLab and self-hosted GitHub Enterprise Server as not supported there yet. We found nothing that says you can set one up without a GitHub repository. OpenAI's changelog also lists a separate GitLab integration in beta (19 August 2026) that runs in Codex cloud and starts legacy cloud chats.",
    },
    {
      q: "How long does Codex cloud keep a task's files?",
      a: "Up to 7 days by default, for that same task. OpenAI's help center says a task's saved VM state is recoverable for up to 7 days after the last turn start or task resume. A new task starts from your published environment and doesn't recover another task's uncommitted changes, so commit what matters.",
    },
    {
      q: "What's the difference between Codex cloud and the Codex CLI?",
      a: "Mostly where each one runs. Codex cloud runs on OpenAI's computers, so a closed laptop doesn't stop it, and it needs a ChatGPT sign-in. The CLI runs on a machine you pick, takes a ChatGPT sign-in or an API key, and needs that machine awake.",
    },
    {
      q: "Is Codex cloud the same as Codex web?",
      a: "We treat them as the same thing. OpenAI's docs and help center say Codex Cloud, the feature table on its pricing page says Codex cloud, and the plan cards on that page say Codex on the web. We found no OpenAI page announcing a rename.",
    },
    {
      q: "How do I run Codex 24/7 on my own computer or server?",
      a: "Install the CLI, sign in, and start it inside tmux on a machine that stays awake. On a headless one, sign in with codex login --device-auth after switching on device code login in your ChatGPT security settings, which OpenAI marks as beta. Use codex exec with nohup for one-shot jobs.",
    },
    {
      q: "How much does it cost to run Codex 24/7 on a Hivra computer?",
      a: `Hivra is ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, on top of your own ChatGPT plan or OpenAI API usage. Codex itself bills through your own account with OpenAI, and paid plans aren't paused for inactivity. Paid plans come with a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "Is it the official Codex CLI on Hivra?",
      a: "Yes. Hivra runs the official Codex CLI on a private virtual machine, and installs the version it has checked, which can trail OpenAI's newest release. Hivra's chat runs it with approvals and the sandbox bypassed by default, and the agent's Manage tab can narrow that to Limited or Read-only. Hivra is independent and is not affiliated with OpenAI.",
    },
  ],
  relatedArticles: [
    { slug: "codex-pricing-by-chatgpt-plan", title: "Codex pricing by ChatGPT plan: Plus, Pro 100/200/500 and API keys" },

    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "keep-claude-code-running-24-7", title: "How to keep Claude Code running 24/7" },
    { slug: "ai-agent-vps", title: "AI agent VPS guide: specs, providers, and setup that actually works (2026)" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
  ],
  relatedComparisons: [
    { slug: "vs-hostinger", title: "Hivra vs Hostinger" },
    { slug: "vs-agent-37", title: "Hivra vs Agent 37" },
  ],
};
