import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

// Written 2026-10-06 for "cursor cloud agents" (US Aug 2,900, avg 1,900, rising; UK 260)
// plus "cursor background agents" (590, old name). Niche finder score 22/25.
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
  title: "Cursor Cloud Agents: cost, laptop-closed runs, and a simpler path",
  metaTitle: "Cursor Cloud Agents: cost and laptop-closed",
  metaDescription:
    "Cursor Cloud Agents cost, laptop-closed runs, and when Claude Code or Codex on your own computer is simpler. Dated 6 Oct 2026.",
  publishedDate: "2026-10-06",
  lastModified: "2026-10-06",
  readingTimeMin: 11,
  author: "Hivra team",
  tagline: "Cloud Agents keep going after the laptop closes. So can a terminal agent on a computer that stays on.",
  intro: `Cursor renamed Background Agents to Cloud Agents. People searching the new name want two things: what it costs, and whether the agent keeps working after they shut the lid. We re-read Cursor's docs on ${READ_ON} and put the dated answers below, then the path that uses Claude Code or Codex on a computer you control.`,
  shortAnswer: `Cursor Cloud Agents run in Cursor's cloud VMs on a paid Cursor plan. Usage bills at the selected model's API rates, with a spend limit you set. They keep working after you close your laptop. Another option is Claude Code or Codex in tmux on a computer that stays on. We have not tested Hivra as a Cursor My Machine.`,
  sections: [
    {
      heading: "What Cursor Cloud Agents are",
      paragraphs: [
        `Cursor's [Cloud Agents docs](${CLOUD_DOCS}), read ${READ_ON}, say Cloud Agents use the same agent fundamentals as local agents, but run in isolated VMs in Cursor's cloud with a full development environment: cloned repos, dependencies, secrets, startup commands and network access.`,
        "They were formerly called Background Agents. Same product, new name.",
        `You can start them from Cursor desktop (Cloud in the agent dropdown), [cursor.com/agents](https://cursor.com/agents), the Cursor iOS app, Slack, GitHub or Bitbucket comments, Linear, or the API. Cursor's [help page](${CLOUD_HELP}) lists those entry points.`,
        "What you get in practice: parallel agents that do not need your laptop online, PRs with screenshots or videos, remote desktop control of the agent's VM, and optional MCP servers. Multi-repo work is supported when the task spans more than one repository.",
      ],
    },
    {
      heading: `What Cursor Cloud Agents cost (read ${READ_ON})`,
      paragraphs: [
        `Cursor's own billing line is short and clear. From the [Cloud Agents docs](${CLOUD_DOCS}) and [help page](${CLOUD_HELP}), both read ${READ_ON}:`,
        [
          "| Fact | What Cursor states |",
          "|---|---|",
          "| Plan gate | Cloud Agents need a paid Cursor plan |",
          "| How usage is billed | At API pricing for the selected model |",
          "| Context window | You can pick a larger window on supported models; that can raise token use and cost |",
          "| Spend limit | You set one the first time you use Cloud Agents |",
          "| Separate VM fee | Cursor's public docs do not list a separate VM or compute charge for managed Cloud Agents |",
        ].join("\n"),
        "There is no fixed \"Cloud Agents cost $X a month\" number on those pages. Your bill moves with the model, the context window, and how long each run thinks and tools. Check Cursor's models and pricing page for the per-token rates that apply to the model you pick.",
        "Forum replies sometimes add detail about included plan usage versus on-demand. Prefer the product docs above when the two disagree, and re-check before you buy.",
        "If the job is a tidy change to a GitHub repo and you already live in Cursor, Cloud Agents can be the whole answer. You pay Cursor's usage, not a second host.",
      ],
    },
    {
      heading: "Do Cloud Agents keep working after I close my laptop?",
      paragraphs: [
        "Yes for managed Cloud Agents. The work runs in Cursor's cloud VMs, so your laptop does not have to stay awake or online. That is the point of the product.",
        `Cursor's help page also notes that \"Move to Cloud\" does not snapshot local uncommitted changes. The cloud agent starts from a clean git state on the remote repository. Commit or stash first if you want it to see your latest dirty work ([help page](${CLOUD_HELP}), read ${READ_ON}).`,
        "Local Cursor agents on the laptop are a different story. Close the lid, sleep the machine, and those local runs pause with everything else on the laptop. Cloud Agents are the Cursor-side fix for that.",
      ],
    },
    {
      heading: "My Machines: bring your own hardware (with a hard caveat)",
      paragraphs: [
        `Cursor also ships [My Machines](${MY_MACHINES}) under [Self-Hosted Machines](${SELF_HOSTED}). A worker on your laptop, devbox or remote VM opens an outbound connection to Cursor. The agent loop, inference and planning stay in Cursor's cloud. Terminal commands, file edits, browser actions and other tool calls run on your machine.`,
        "That matters for privacy, private networks and machine-local state you do not want to rebuild in a Cursor-managed VM. It also means My Machines is still a Cursor Cloud Agent product. You are not leaving Cursor's agent loop.",
        "**We have not tested a Hivra computer as a Cursor My Machine.** Nobody here has run `agent worker start` on a canary computer and proven the picker, hooks and long runs. Until that test is recorded, do not treat Hivra as a drop-in My Machine host. If you try it yourself, you are on uncharted ground for this site.",
        "Cursor's docs recommend managed Cloud Agents for most teams, including teams that need private network access through allowlists or Tailscale-style clients, without running your own worker.",
      ],
    },
    {
      heading: "When Claude Code or Codex on your own computer is simpler",
      paragraphs: [
        "Cloud Agents are the right pick when you want Cursor's editor workflow, parallel cloud VMs and PR artifacts, and you are fine paying Cursor's model API rates.",
        "A terminal agent on a computer that stays on is the simpler pick when:",
        [
          "- You already pay for Claude or ChatGPT and want the CLI to bill through that subscription.",
          "- You need files, logins and tools that live outside a single GitHub checkout.",
          "- You want a shell you can reattach to with tmux after you walk away.",
          "- You do not want a second vendor's cloud agent loop in the middle.",
        ].join("\n"),
        `On that path you install [Claude Code](/agents/claude-code) or [Codex](/agents/codex), sign in with your own Anthropic or ChatGPT account (or use your own API key), and start the CLI inside tmux. The computer bill and the model bill stay separate. Hivra's computer plans are ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, with a ${MONEY_BACK_GUARANTEE}. Paid plans are not paused for inactivity. Hivra adds no markup on BYO keys or subscription logins.`,
        "The laptop-closed rules for Claude Code are spelled out in [Will Claude Code keep running if you close your laptop?](/blog/keep-claude-code-running-24-7). The job sort between Cursor and Claude Code is on [Cursor vs Claude Code](/blog/cursor-vs-claude-code).",
      ],
    },
    {
      heading: "Honest chooser",
      paragraphs: [
        [
          "| Your job | Prefer | Why |",
          "|---|---|---|",
          "| Parallel PRs from Cursor, laptop closed | Cursor Cloud Agents | Built for that workflow; bills at model API rates on a paid Cursor plan |",
          "| Deep work inside the Cursor editor while you stay at the desk | Local Cursor agent | No cloud hop; laptop must stay awake |",
          "| Long unattended CLI run on your Claude or ChatGPT plan | Claude Code or Codex in tmux on a computer that stays on | Your subscription caps the model bill; the computer keeps the shell up |",
          "| Tool execution on hardware you already run, still inside Cursor | Cursor My Machines | Agent loop stays in Cursor's cloud; we have not tested this on Hivra |",
          "| Tidy GitHub-only Claude tasks | Claude Code on the web | Anthropic's cloud; no second host |",
        ].join("\n"),
        "Pick the product that matches the job. A second host only pays for itself when you need a shell, files or agents that outlive one vendor's cloud session.",
      ],
    },
    {
      heading: "Running Claude Code or Codex on a Hivra computer",
      paragraphs: [
        `Launch [Claude Code](/agents/claude-code) or [Codex](/agents/codex), sign in with the subscription you already have, and start long runs inside tmux in the Terminal tab. On Claude Code you can also send work through the Telegram tab. Those runs execute on your Hivra computer, so they keep going after you close the laptop.`,
        "That is a terminal-agent path. It is not Cursor Cloud Agents, and it is not a proven Cursor My Machine setup.",
        "Hivra is independent and is not affiliated with Cursor, Anthropic or OpenAI.",
      ],
    },
  ],
  faqs: [
    {
      q: "What are Cursor Cloud Agents?",
      a: `Cloud Agents are Cursor's cloud-hosted coding agents. They run in isolated VMs in Cursor's cloud with repos, dependencies and secrets prepared for the task. Formerly called Background Agents (Cursor docs, read ${READ_ON}).`,
    },
    {
      q: "How much do Cursor Cloud Agents cost?",
      a: `Cursor bills Cloud Agents at API pricing for the selected model, on a paid Cursor plan, with a spend limit you set. Larger context windows can raise token use. Cursor's public docs do not list a separate VM fee for managed Cloud Agents (read ${READ_ON}).`,
    },
    {
      q: "Do I need a paid Cursor plan for Cloud Agents?",
      a: `Yes. Cursor's help page, read ${READ_ON}, says Cloud Agents are available on paid Cursor plans.`,
    },
    {
      q: "Do Cursor Cloud Agents keep working when I close my laptop?",
      a: "Yes for managed Cloud Agents. They run in Cursor's cloud, so your laptop does not need to stay awake. Local Cursor agents on the laptop pause when the laptop sleeps.",
    },
    {
      q: "What is Cursor My Machines?",
      a: `My Machines runs Cloud Agent tool calls on a machine you connect. The agent loop stays in Cursor's cloud; shells and file edits run on your worker ([My Machines docs](${MY_MACHINES}), read ${READ_ON}).`,
    },
    {
      q: "Can I use a Hivra computer as a Cursor My Machine?",
      a: "Not proven here. We have not run Cursor's worker on a Hivra computer. Do not assume it works until that test is recorded. For unattended runs on Hivra today, use Claude Code or Codex in tmux instead.",
    },
    {
      q: "Is there a cheaper alternative to Cursor Cloud Agents?",
      a: `Cheaper depends on your bill. If you already pay for Claude or ChatGPT, running that CLI in tmux on a computer that stays on can avoid a second cloud-agent meter. Hivra's computer is ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE} on top of your own model plan. Cursor Cloud Agents may still win when you want Cursor's editor workflow and PR artifacts.`,
    },
    {
      q: "Were Cloud Agents called Background Agents?",
      a: `Yes. Cursor's Cloud Agents docs, read ${READ_ON}, say Cloud Agents were formerly called Background Agents.`,
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
