import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

// Written 2026-11-12, the day both vendors let managed agents run their tools on
// machines the customer controls. Live since 2026-11-13 (Ash: leave it on); the
// copy says plainly that neither worker has been run on a Hivra computer yet.
//
// Vendor facts read 12 November 2026 from the vendors' own pages:
// - https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
//   (self_hosted environment, environment key generated in the Console only,
//   `ant beta:worker poll --workdir /workspace`, outbound HTTPS only, keep the
//   API key off the worker host, ant CLI release binaries on GitHub)
// - https://platform.claude.com/docs/en/managed-agents/choosing-an-environment
//   (self-hosted sandbox vs the whole self-hosted service, private beta via
//   the account team)
// - https://aistudio.google.com/docs/agent-environment#self-hosted-environments
//   (POST /v1beta/environments {"mode":"self_hosted"}, one-time
//   environment_key, `gemini-api environments connect`, preview, inactive
//   offline environments kept 7 days)
// - https://github.com/google-gemini/gemini-api-cli/tree/main/docs/self-hosted
//   (install script, --environment-key/--root-dir/--workdir, --disable-bash,
//   --root-dir does not confine execute_bash, agent antigravity-preview-05-2026)
//
// Caveat, same rule as cursor-cloud-agents: do NOT claim either worker has been
// tested on a Hivra computer until it has.

const CLAUDE_SELF_HOSTED = "https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes";
const CLAUDE_CHOOSING = "https://platform.claude.com/docs/en/managed-agents/choosing-an-environment";
const GEMINI_ENVIRONMENTS = "https://aistudio.google.com/docs/agent-environment#self-hosted-environments";
const GEMINI_SELF_HOSTED_GUIDE = "https://github.com/google-gemini/gemini-api-cli/tree/main/docs/self-hosted";
const ANT_RELEASES = "https://github.com/anthropics/anthropic-cli/releases";

export const article: BlogArticle = {
  slug: "run-managed-agents-on-your-own-computer",
  title: "Run Claude and Gemini managed agents on a computer you control",
  metaTitle: "Claude and Gemini managed agents on your own computer",
  metaDescription:
    "Claude Managed Agents and Gemini managed agents can now run their tools on your own machine. What that means, and how to set up the worker for each.",
  publishedDate: "2026-11-12",
  lastModified: "2026-11-12",
  readingTimeMin: 7,
  author: "Hivra team",
  tagline: "The agent thinks in their cloud. Its hands work on your computer.",
  intro: `In the same week, Anthropic and Google both let their managed agents run tools on a machine you control. The agent still plans in the vendor's cloud. The shell commands and file edits happen on your computer. Here's how each one works, and what you need to set it up.`,
  shortAnswer: `Both vendors now let you run a small worker on your own Linux machine. The worker connects out over HTTPS, picks up the agent's tool calls, runs them in a folder you choose and sends the results back. For Claude it's \`ant beta:worker poll\`. For Gemini it's \`gemini-api environments connect\`. You need an API key from each vendor.`,
  sections: [
    {
      heading: "What changed?",
      paragraphs: [
        `Until now, a managed agent from Anthropic or Google ran its tools in a sandbox the vendor hosted. That's still the default. What's new is a second option: you run the sandbox yourself.`,
        `Anthropic calls it a [self-hosted sandbox](${CLAUDE_SELF_HOSTED}). You create an environment of type \`self_hosted\`, run a worker on your machine, and Claude's tool calls run there. Claude itself still runs on Anthropic's side and decides what to do next.`,
        `Google calls it a [self-hosted environment](${GEMINI_ENVIRONMENTS}). Same idea: you create an environment in \`self_hosted\` mode, run the open-source \`gemini-api\` CLI on your machine, and the agent's file and shell tools run there. It's in preview, so details may change.`,
        `Anthropic went one step further for big companies: you can now run the whole Managed Agents service yourself, with the agent loop and session history on your own servers. That's a private beta you request through Anthropic's account team, and it's a much bigger install than a worker. See [Choosing an agent environment](${CLAUDE_CHOOSING}). This guide covers the worker, which anyone with an API key can use today.`,
      ],
    },
    {
      heading: "Why run the tools on your own computer?",
      paragraphs: [
        "Three reasons come up again and again.",
        "Your files and logins are already there. The agent works on the real repo, the real database dump, the tools you've already installed, instead of a fresh sandbox that has to be set up every session.",
        "The work stays put. A vendor sandbox is usually thrown away or expires. On your own machine, whatever the agent built is still in the folder tomorrow.",
        "You set the rules. You decide what the machine can reach on the network and what's installed on it.",
        "The trade-off is that a shell run by a model is a real shell. Both vendors say so plainly. Put the worker on a machine that doesn't hold anything you'd hate to lose, and give it its own folder.",
      ],
    },
    {
      heading: "Set up a worker for Claude Managed Agents",
      paragraphs: [
        `These steps follow Anthropic's [self-hosted sandbox quickstart](${CLAUDE_SELF_HOSTED}). You need an agent already made in Managed Agents, a Claude API key, and a Linux machine with \`/bin/bash\`.`,
        "**1. Create the environment.** In the Claude Console, open Environments, click Create environment and choose Self-hosted. Or call the API from your own laptop:",
        [
          "```bash",
          "curl -sS --fail-with-body https://api.anthropic.com/v1/environments \\",
          "  -H \"x-api-key: $ANTHROPIC_API_KEY\" \\",
          "  -H \"anthropic-version: 2026-10-21\" \\",
          "  -H \"anthropic-beta: managed-agents-2026-04-01\" \\",
          "  -H \"content-type: application/json\" \\",
          "  -d '{\"name\": \"my-computer\", \"config\": {\"type\": \"self_hosted\"}}'",
          "```",
        ].join("\n"),
        "**2. Make an environment key.** Open the environment in the Console and click Generate environment key. You can only do this in the Console. This key lets the worker pick up work for this one environment. It is not your API key, and your API key should never go on the worker machine, because the agent's commands could read it.",
        `**3. Install the \`ant\` CLI on the worker machine.** Grab the Linux build from the [releases page](${ANT_RELEASES}). Version 2.9.0 is the one Anthropic's docs use; take the newest:`,
        [
          "```bash",
          "curl -fsSL \"https://github.com/anthropics/anthropic-cli/releases/download/v2.9.0/ant_2.9.0_linux_amd64.tar.gz\" \\",
          "  | sudo tar -xz -C /usr/local/bin ant",
          "ant --version",
          "```",
        ].join("\n"),
        "**4. Start the worker.** Give it a folder of its own. Start it inside tmux so it keeps going when you close the terminal:",
        [
          "```bash",
          "export ANTHROPIC_ENVIRONMENT_KEY=\"sk-ant-oat01-...\"",
          "export ANTHROPIC_ENVIRONMENT_ID=\"env_...\"",
          "sudo mkdir -p /workspace && sudo chown \"$USER\" /workspace",
          "tmux new -s claude-worker 'ant beta:worker poll --workdir /workspace'",
          "```",
        ].join("\n"),
        "**5. Send it a session.** From your laptop, start a session for your agent that targets this environment. The agent's bash and file tool calls now run in `/workspace` on your machine. Anthropic's quickstart shows how to check the worker is polling and how to confirm the commands ran on your host.",
      ],
    },
    {
      heading: "Set up a worker for Gemini managed agents",
      paragraphs: [
        `These steps follow Google's [self-hosted environments guide](${GEMINI_SELF_HOSTED_GUIDE}). You need a Gemini API key and a Linux machine.`,
        "**1. Create the environment** from your own laptop. Save the `environment_key` from the reply straight away: Google only shows it once.",
        [
          "```bash",
          "curl -fsSL -X POST \"https://generativelanguage.googleapis.com/v1beta/environments\" \\",
          "  -H \"x-goog-api-key: $GEMINI_API_KEY\" \\",
          "  -H \"Content-Type: application/json\" \\",
          "  -d '{\"mode\": \"self_hosted\"}'",
          "```",
        ].join("\n"),
        "**2. Install the `gemini-api` CLI on the worker machine:**",
        [
          "```bash",
          "curl -fsSL https://raw.githubusercontent.com/google-gemini/gemini-api-cli/main/scripts/install.sh | bash",
          "export PATH=\"$HOME/.local/bin:$PATH\"",
          "```",
        ].join("\n"),
        "**3. Connect the worker** with only the environment key, never your API key. Again, use tmux so it outlives the terminal:",
        [
          "```bash",
          "mkdir -p ~/gemini-workspace",
          "tmux new -s gemini-worker \\",
          "  'gemini-api environments connect --environment-key \"$GEMINI_ENVIRONMENT_KEY\" --root-dir ~/gemini-workspace --workdir ~/gemini-workspace'",
          "```",
        ].join("\n"),
        "`--root-dir` keeps the file tools inside that folder, but it does not fence in the shell tool. Google's guide is clear about that. Add `--disable-bash` if you only want file edits.",
        "**4. Run the agent** from your laptop and pass the environment ID:",
        [
          "```bash",
          "gemini-api agent run \"Create hello.txt and list the workspace.\" \\",
          "  --agent antigravity-preview-05-2026 \\",
          "  --body \"{\\\"environment\\\": \\\"$GEMINI_ENVIRONMENT_ID\\\"}\"",
          "```",
        ].join("\n"),
        "Google keeps an offline environment for 7 days of inactivity, then deletes it. A worker that stays connected avoids that.",
      ],
    },
    {
      heading: "Claude or Gemini: how do they compare?",
      paragraphs: [
        [
          "| | Claude Managed Agents | Gemini managed agents |",
          "|---|---|---|",
          "| Status | Open to API users, under the Managed Agents beta | Preview |",
          "| Worker command | `ant beta:worker poll` | `gemini-api environments connect` |",
          "| Worker key | Environment key, made in the Claude Console | Environment key, shown once when you create the environment |",
          "| Network | Outbound HTTPS only | Outbound HTTPS only |",
          "| Shell on your machine | Yes | Yes, unless you pass `--disable-bash` |",
          "| Whole service on your own servers | Private beta, through Anthropic's account team | Not offered |",
        ].join("\n"),
        "Either way, you pay the vendor for the model at their API prices, and you pay for the machine the worker runs on.",
      ],
    },
    {
      heading: "Where should the worker run?",
      paragraphs: [
        "Not on your main laptop. It has your SSH keys, your browser sessions and your password manager, and the worker's shell can reach all of them. A laptop also sleeps, and a sleeping worker drops the agent's work.",
        "A small server that stays on is the usual answer: a VPS, a spare box at home, or a cloud computer of its own. It needs very little. The heavy thinking happens in the vendor's cloud, and the worker just runs commands.",
        `A Hivra computer is one option. Each one is a separate Linux machine that stays on, with a Terminal tab where you can paste the steps above, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. You bring your own Anthropic or Gemini key. We're still testing both workers on Hivra computers ourselves, so treat this as a guide rather than a promise.`,
        "Hivra is independent and is not affiliated with Anthropic or Google.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is a self-hosted sandbox in Claude Managed Agents?",
      a: `A setup where Claude keeps running on Anthropic's side but its bash and file tool calls run on a machine you control. A worker on that machine picks up the work over outbound HTTPS. Anthropic's [docs](${CLAUDE_SELF_HOSTED}) have the full quickstart.`,
    },
    {
      q: "Can Gemini managed agents run on my own server?",
      a: `Their tools can. You create a self-hosted environment, run \`gemini-api environments connect\` on your server, and the agent's file and shell tools run there. The agent and the model stay on Google's side. It's in preview.`,
    },
    {
      q: "Do I need to open a port for the worker?",
      a: "No. Both workers connect out over HTTPS and poll for work, so nothing on your machine needs to accept incoming connections.",
    },
    {
      q: "Should I put my API key on the worker machine?",
      a: "No. Both vendors give the worker its own environment key for exactly this reason. The agent can run shell commands on that machine, so anything stored there is within its reach.",
    },
    {
      q: "Is the worker safe to run on my laptop?",
      a: "It runs model-written shell commands with your user's permissions, so it can read anything you can. Use a separate machine that holds nothing you'd mind losing, and give the worker its own folder.",
    },
    {
      q: "Can I run the whole Claude Managed Agents service myself?",
      a: "Yes, as of November 2026, in private beta. You ask Anthropic's account team for access, then run the server, a PostgreSQL database and the workers yourself. That's a much bigger job than running a worker.",
    },
  ],
  relatedArticles: [
    { slug: "cursor-cloud-agents", title: "Cursor Cloud Agents: what they cost, and what happens when you close your laptop" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended? The four risks that matter" },
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
  ],
};
