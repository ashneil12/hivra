import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

// Written 2026-10-06 for "cursor cloud agents" (US Aug 2,900, avg 1,900, rising; UK 260)
// plus "cursor background agents" (590, old name). Niche finder score 22/25.
// Voice rewrite 2026-10-06 after Ash's "reads like a robot made the page": plain words,
// fewer bullets, one Hivra line where the closed-laptop problem is real. Facts unchanged.
//
// Vendor facts read 6 October 2026 from Cursor's own pages:
// - https://cursor.com/docs/cloud-agent (Cloud Agents overview, billing, naming history)
// - https://cursor.com/help/ai-features/cloud-agents (paid plan requirement, usage priced at API rates)
// - https://cursor.com/docs/cloud-agent/my-machines (My Machines: agent loop in Cursor cloud, tools on your machine)
// - https://cursor.com/docs/cloud-agent/self-hosted (Self-Hosted Machines overview)
//
// Caveat required by the niche brief and truth table: do NOT claim a Hivra computer
// works as a Cursor My Machine. That needs a live `agent worker start` test on canary
// that has not been run. Soft handoff is Claude Code or Codex on a computer that stays
// on, with your own subscription or key.

const READ_ON = "6 October 2026";
const CLOUD_DOCS = "https://cursor.com/docs/cloud-agent";
const CLOUD_HELP = "https://cursor.com/help/ai-features/cloud-agents";
const MY_MACHINES = "https://cursor.com/docs/cloud-agent/my-machines";
const SELF_HOSTED = "https://cursor.com/docs/cloud-agent/self-hosted";

export const article: BlogArticle = {
  slug: "cursor-cloud-agents",
  title: "Cursor Cloud Agents: what they cost, and what happens when you close your laptop",
  metaTitle: "Cursor Cloud Agents: cost, and closing your laptop",
  metaDescription:
    "What Cursor Cloud Agents cost, whether they keep working with your laptop shut, and when Claude Code or Codex is simpler. Checked 6 Oct 2026.",
  publishedDate: "2026-10-06",
  lastModified: "2026-10-06",
  readingTimeMin: 8,
  author: "Hivra team",
  tagline: "Shut the lid and they keep working. Here's what that costs.",
  intro: `Cursor renamed Background Agents to Cloud Agents, and people keep asking the same two things. What does it cost? And does it keep going when I shut my laptop? We read Cursor's own docs on ${READ_ON}. Here's what they actually say.`,
  shortAnswer: `Cloud Agents run on Cursor's own cloud machines, so yes, they keep working after you shut your laptop. You need a paid Cursor plan, and you pay the model's API rates up to a spend limit you set. If you'd rather use your Claude or ChatGPT subscription, run Claude Code or Codex on a computer that stays on.`,
  sections: [
    {
      heading: "What are Cursor Cloud Agents?",
      paragraphs: [
        `They're Cursor's coding agents, moved off your laptop and onto Cursor's servers. Each one gets its own isolated virtual machine with your repo cloned, dependencies installed, secrets loaded and internet access ([Cursor's docs](${CLOUD_DOCS}), read ${READ_ON}).`,
        "Until recently they were called Background Agents. Same product. New name.",
        `You can start one from pretty much anywhere: the Cloud option in Cursor's agent dropdown, [cursor.com/agents](https://cursor.com/agents), the Cursor iPhone app, Slack, a GitHub or Bitbucket comment, Linear, or the API. Cursor's [help page](${CLOUD_HELP}) has the list.`,
        "Why bother? You can run several at once, and your laptop doesn't have to be online for any of them. When one finishes you get a PR, often with screenshots or a video of what it did. You can also take over the agent's desktop remotely, plug in MCP servers, or point a single agent at more than one repo.",
      ],
    },
    {
      heading: `What do Cursor Cloud Agents cost? (read ${READ_ON})`,
      paragraphs: [
        `There's no flat monthly price. You need a paid Cursor plan, and every run is billed at the API price of the model you picked. That's the whole model. Here's what the [docs](${CLOUD_DOCS}) and [help page](${CLOUD_HELP}) say, both read ${READ_ON}:`,
        [
          "| Question | What Cursor's docs say |",
          "|---|---|",
          "| Do I need a paid plan? | Yes. Cloud Agents need a paid Cursor plan |",
          "| How is usage billed? | At API pricing for the model you select |",
          "| Can a bigger context window cost more? | Yes. Supported models let you pick a larger window, which can mean more tokens and a bigger bill |",
          "| Is there a spend limit? | You set one the first time you use Cloud Agents |",
          "| Is there a separate fee for the VM? | Cursor's public docs don't list a separate VM or compute charge for managed Cloud Agents |",
        ].join("\n"),
        "So your bill moves with the model, the size of the context window, and how long the agent spends thinking and running tools. A long run on a big model costs more than a quick one on a small model. Cursor's models and pricing page has the per-token rates.",
        "You'll find forum threads arguing about included usage versus on-demand. If a forum post and the docs disagree, go with the docs. And check again before you buy, because pricing pages change.",
        "Already living in Cursor, and the job is a clean change to a GitHub repo? Then Cloud Agents are all you need. One bill. No extra computer to rent.",
      ],
    },
    {
      heading: "Do Cloud Agents keep working after I close my laptop?",
      paragraphs: [
        "Yes. They run on Cursor's machines, not yours. Shut the lid, go to bed, and the work carries on. That's the whole reason the product exists.",
        `One catch. Hitting "Move to Cloud" doesn't bring your uncommitted changes with it. The cloud agent starts from a clean copy of your remote repo, so commit or stash first if you want it to see what you were just working on ([help page](${CLOUD_HELP}), read ${READ_ON}).`,
        "Local Cursor agents are a different story. They run on your laptop, so when the laptop sleeps, they pause right along with it.",
      ],
    },
    {
      heading: "Can Cloud Agents use my own computer? (My Machines)",
      paragraphs: [
        `Kind of. Cursor has a feature called [My Machines](${MY_MACHINES}), part of [Self-Hosted Machines](${SELF_HOSTED}). You run a small worker on your laptop, a spare desktop or a remote server, and it connects out to Cursor. The planning and the model calls stay in Cursor's cloud. The hands-on work happens on your machine: terminal commands, file edits, browser actions.`,
        "That's useful when your code sits on a private network, or your machine has setup you don't want to rebuild somewhere else. But Cursor's agent is still the one in charge. You're lending it your hardware.",
        "**We haven't tested a Hivra computer as a Cursor My Machine.** Nobody here has run `agent worker start` on one and watched it pick up jobs, run hooks and get through a long run. So don't treat Hivra as a ready-made My Machine host. If you try it, you're ahead of us.",
        "For most teams, Cursor's own docs point you back to the managed Cloud Agents anyway, even if you need access to a private network. They cover that with allowlists and Tailscale-style clients, no worker of your own required.",
      ],
    },
    {
      heading: "When is Claude Code or Codex simpler?",
      paragraphs: [
        "Stick with Cloud Agents if you like working in Cursor, want a handful of agents running side by side, and are fine paying API rates for the model.",
        "A terminal agent on a computer that stays on is simpler when you already pay for Claude or ChatGPT and want that subscription to cover the work. Or when the job needs files, logins or tools that don't live in one GitHub repo. Some people just want to walk away, come back six hours later and pick up the exact same terminal session with tmux. Others would rather not have a second company's agent sitting in the middle at all.",
        `The setup is short. Install [Claude Code](/agents/claude-code) or [Codex](/agents/codex), sign in with your own Anthropic or ChatGPT account (or an API key), and start it inside tmux. You end up with two separate bills, one for the computer and one for the model.`,
        `Don't have a computer that stays on? That's what Hivra is: Claude Code or Codex on a computer that keeps running after you close your laptop, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, signed in with your own account.`,
        "Want the full story on Claude Code and a closed laptop? Read [Will Claude Code keep running if you close your laptop?](/blog/keep-claude-code-running-24-7). Still torn between the two tools in general? That's [Cursor vs Claude Code](/blog/cursor-vs-claude-code).",
      ],
    },
    {
      heading: "Which one should you pick?",
      paragraphs: [
        [
          "| Your job | Pick | Why |",
          "|---|---|---|",
          "| Parallel PRs from Cursor, laptop closed | Cursor Cloud Agents | Made for exactly this. Paid Cursor plan, model API rates |",
          "| Deep work in the Cursor editor while you're at your desk | Local Cursor agent | Nothing goes to the cloud. Laptop has to stay awake |",
          "| A long, unattended terminal run on your Claude or ChatGPT plan | Claude Code or Codex in tmux on a computer that stays on | Your subscription covers the model. The computer keeps the session alive |",
          "| Tool runs on hardware you already have, still inside Cursor | Cursor My Machines | Cursor's agent still runs in Cursor's cloud. Not tested on Hivra |",
          "| Small Claude jobs that only touch GitHub | Claude Code on the web | Runs on Anthropic's cloud. No second computer needed |",
        ].join("\n"),
        "Match the tool to the job. Paying for a second computer only makes sense when you need a terminal, files or agents that outlast one company's cloud session.",
        "Hivra is independent and is not affiliated with Cursor, Anthropic or OpenAI.",
      ],
    },
  ],
  faqs: [
    {
      q: "What are Cursor Cloud Agents?",
      a: `Cursor's coding agents, running on Cursor's servers instead of your laptop. Each one gets an isolated virtual machine with your repo, dependencies and secrets ready to go. They used to be called Background Agents (Cursor docs, read ${READ_ON}).`,
    },
    {
      q: "How much do Cursor Cloud Agents cost?",
      a: `There's no flat price. You need a paid Cursor plan, then usage is billed at the API price of the model you pick, up to a spend limit you set. Bigger context windows can push token use up. Cursor's public docs don't list a separate VM fee (read ${READ_ON}).`,
    },
    {
      q: "Do I need a paid Cursor plan for Cloud Agents?",
      a: `Yes. Cursor's help page, read ${READ_ON}, says Cloud Agents are only on paid plans.`,
    },
    {
      q: "Do Cursor Cloud Agents keep working when I close my laptop?",
      a: "Yes. They run on Cursor's machines, so your laptop can sleep. Local Cursor agents are different. They run on the laptop and pause when it sleeps.",
    },
    {
      q: "What is Cursor My Machines?",
      a: `It lets a Cloud Agent run its commands and file edits on a machine you connect. The agent itself still runs in Cursor's cloud ([My Machines docs](${MY_MACHINES}), read ${READ_ON}).`,
    },
    {
      q: "Can I use a Hivra computer as a Cursor My Machine?",
      a: "We don't know yet. We haven't run Cursor's worker on a Hivra computer, so don't count on it. If you want unattended runs on Hivra today, use Claude Code or Codex in tmux.",
    },
    {
      q: "Is there a cheaper alternative to Cursor Cloud Agents?",
      a: "Depends what you already pay for. If you have a Claude or ChatGPT subscription, running that CLI in tmux on a computer that stays on avoids a second per-token meter. You'll pay for the computer instead. Cloud Agents still make sense if you want Cursor's editor and PRs with screenshots.",
    },
    {
      q: "Were Cloud Agents called Background Agents?",
      a: `Yes. Cursor's docs, read ${READ_ON}, say Cloud Agents were formerly called Background Agents.`,
    },
  ],
  relatedArticles: [
    { slug: "cursor-vs-claude-code", title: "Cursor vs Claude Code: which keeps going when you walk away?" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude Code keep running if you close your laptop? (And how to run it 24/7)" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "run-codex-24-7-in-the-cloud", title: "How to run Codex 24/7 in the cloud (Codex CLI hosting explained)" },
    { slug: "byo-api-key-explained", title: "BYO API key explained" },
  ],
};
