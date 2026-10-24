// /agents/claude-code. Wording from Ash's batch 02 file 04-claude-code.md, with the edits listed
// in the lane ledger. Run-level keep-going claims name tmux (and Telegram), as lib/blog/runtime-facts.ts
// requires; Claude Code takes its own sign-in only, so the AI usage note about Hivra credits is not used here.

import { fill } from "./shared";
import type { AgentPageContent } from "./types";

export const CLAUDE_CODE_CONTENT: AgentPageContent = {
  slug: "claude-code",
  h1: "Your Claude Code workspace shouldn't close with your laptop.",
  lead: [
    "You've got a refactor halfway through, tests still running and three more things you want to try. Then it's time to leave your desk.",
    fill(
      "Hivra gives Claude Code a computer that stays available when yours doesn't. You use the **official Anthropic CLI**, sign in with your own account and reach your workspace through the browser from wherever you are. {staysOn}",
    ),
  ],
  heroLinks: [
    { label: "Deploy Claude Code", target: "deploy" },
    { label: "View pricing", target: "pricing" },
  ],
  sections: [
    {
      heading: "The same coding agent, with somewhere permanent to work",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Claude Code is excellent at working through code with you, but where you run it affects how you work. A laptop is convenient until it sleeps, loses connectivity or has to go back in your bag. A VPS can solve that, but then you're responsible for setting up the server, keeping sessions alive and getting back into it from another device.",
            fill(
              "Hivra handles the computer. The official Claude Code CLI is installed when your VM is ready. Your repository, files and account session live in that environment, so you can leave the desk and return without rebuilding your setup. {staysOn}",
            ),
            "For long-running terminal jobs, **start Claude Code inside `tmux`** in the Terminal tab. That keeps the terminal session alive independently of your browser connection. Simply closing an ordinary interactive tab isn't the same thing, and we won't pretend it is.",
          ],
        },
      ],
    },
    {
      heading: "More than a remote shell",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "A terminal that's available in your browser.",
              text: "Run commands, inspect processes and work in the same persistent VM without configuring SSH every time you switch devices.",
            },
            {
              term: "Files and workspace in one place.",
              text: "Browse what the agent is changing, check the result and come back to the same project later.",
            },
            {
              term: "An optional live browser.",
              text: "Enable the self-hosted browser when you need to inspect pages or work with logged-in websites. You can watch what happens and take control when a human needs to sign in or make a judgement call.",
            },
            {
              term: "Telegram handoff.",
              text: "Hivra offers a Telegram integration in the agent's Telegram tab, under Manage. Configure it when you want another way to send work and check in. Supported behaviours depend on the installed integration.",
            },
            {
              term: "A computer reserved for this agent.",
              text: "Keep coding tools, credentials and experiments separate from your everyday laptop. Remember that Hivra administrators retain infrastructure access to managed hosts.",
            },
          ],
        },
      ],
    },
    {
      heading: "How to start",
      blocks: [
        {
          kind: "steps",
          steps: [
            {
              title: "Launch Claude Code",
              paragraphs: [
                fill(
                  "Choose Claude Code, give the agent a name and choose a plan. {paidNote} If you need more room, **{largerPrice} a month** provides {largerCompute}.",
                ),
              ],
            },
            {
              title: "Open your new computer",
              paragraphs: [
                "Hivra provisions the VM with the official CLI already installed. Open its terminal, files or chat interface and bring in the repository you want to work on.",
              ],
            },
            {
              title: "Sign in with Anthropic",
              paragraphs: [
                "Use your own Anthropic account on the computer, as you would locally, subject to the provider's terms. Hivra hosting does **not** include or replace your Anthropic subscription or model usage entitlement.",
              ],
            },
            {
              title: "Work normally, then hand off the long tasks",
              paragraphs: [
                "Start coding. When you have a job that needs to survive a disconnect, run it in `tmux` or use a supported persistent integration such as Telegram. Check the files, terminal output and results the next time you log in.",
              ],
            },
          ],
        },
      ],
    },
    {
      heading: "What about the live browser?",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            fill(
              "The browser is optional, not a requirement for every coding task. If your work involves a website, it can be useful to have a live view of what the agent is seeing and doing. The browser adds **{browserAdd}** to the computer, which fits within the entry plan's {entryCompute}.",
            ),
            "A visible browser does not make every web action safe. Log into sensitive services yourself and review permissions before allowing automation to change data.",
          ],
        },
      ],
    },
    {
      heading: "Why use Hivra rather than a VPS?",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "A VPS with Claude Code and `tmux` works. If you already enjoy maintaining servers, you may prefer it. The trade-off is time: provisioning the machine, configuring authentication, setting up browser access, keeping services running and making the workspace usable on smaller devices.",
            "Hivra's value is the finished working environment. You still bring the same Claude Code account and pay Anthropic under its own terms. You're paying Hivra for a managed computer and the tools around it, not for a different version of Claude Code.",
            fill("Hivra itself is open source, so [self-hosting]({repo}) the platform is also an option if you want to operate the infrastructure."),
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Can I use my Claude account instead of an API key?",
      a: "Yes. The current Hivra setup supports signing in with your Anthropic account inside the VM, subject to the provider's terms. Your entitlement and usage are governed by Anthropic's terms and plan.",
    },
    {
      q: "Will Claude Code keep running when I shut my laptop?",
      a: "The **computer** stays on with a paid plan. A long-running CLI job should be started inside `tmux`, or through a supported persistent integration, so the work survives closing your browser. A process that depends on an ordinary foreground terminal session may stop when that session ends.",
    },
    {
      q: "How much does it cost?",
      a: fill(
        "{paidNote} The larger size is {larger}. Anthropic usage or subscription charges are separate. {refund}",
      ),
    },
    {
      q: "Is Claude Code modified?",
      a: "No. Hivra installs the official Anthropic CLI. Hivra is not affiliated with or endorsed by Anthropic.",
    },
    {
      q: "Can I reach the same workspace from another device?",
      a: "Yes. The files and session are stored on the cloud computer, not just in your local browser. Log back into Hivra to reach the workspace. Take particular care with account credentials if you use shared devices.",
    },
    {
      q: "Is my Anthropic login private from Hivra?",
      a: "It is stored on your hosted computer, not presented as a public Hivra page. However, the service is managed hosting and administrators retain infrastructure-level access to Hivra-managed hosts. Don't treat a hosted VM as an environment the infrastructure operator is technically unable to access.",
    },
  ],
  closing: {
    heading: "Put the laptop away. Leave the computer running.",
    links: [
      { label: "Deploy Claude Code", target: "deploy" },
      { label: "See pricing", target: "pricing" },
      { label: "Explore all agents", target: "agents" },
    ],
  },
  affiliation: "Hivra is independent and is not affiliated with or endorsed by Anthropic.",
  related: {
    heading: "Related",
    slugs: ["codex", "hermes", "aeon", "openclaw", "agent-zero"],
  },
};
