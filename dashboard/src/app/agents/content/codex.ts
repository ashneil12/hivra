// /agents/codex. Wording from Ash's batch 02 file 05-codex.md, with the edits listed in the lane
// ledger. A run is promised to keep going only inside tmux (lib/blog/runtime-facts.ts); Telegram is
// never offered for Codex.

import { fill } from "./shared";
import type { AgentPageContent } from "./types";

export const CODEX_CONTENT: AgentPageContent = {
  slug: "codex",
  h1: "Codex, with a computer you can come back to.",
  lead: [
    "A coding agent is most useful when it can get into the repository, run the tests and make changes in a real workspace. It becomes less useful when that workspace disappears every time you shut the lid.",
    fill(
      "Hivra runs the **official OpenAI Codex CLI** on a private cloud VM. Sign in with your own ChatGPT account or OpenAI API key, subject to the provider's terms, give it a project and work from the same computer even when you're away from your main machine. {staysOn}",
    ),
  ],
  heroLinks: [
    { label: "Deploy Codex", target: "deploy" },
    { label: "See pricing", target: "pricing" },
  ],
  sections: [
    {
      heading: "Your development environment, hosted",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Codex can inspect code, make edits, execute commands and help you work through build failures. On Hivra, those actions happen on the agent's cloud computer, where the repositories and tooling live.",
            "That separation is useful for practical reasons. You don't need your everyday laptop to remain switched on, and the agent's files stay in the same place between visits. It also means experiments and commands don't need to run directly on the machine where you keep personal files.",
            "For tasks that need to continue without an open browser, start the CLI within **`tmux`** in Hivra's Terminal tab. A paid VM stays available for background work; an ordinary foreground process doesn't become persistent merely because the VM is hosted.",
          ],
        },
      ],
    },
    {
      heading: "What you get",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "The real Codex CLI.",
              text: "Hivra installs the official OpenAI tool, not a replacement interface pretending to be Codex.",
            },
            {
              term: "A proper workspace.",
              text: "Use the terminal, files and chat-related tools around the CLI. Inspect the changes instead of treating the agent's answer as the whole job.",
            },
            {
              term: "Your own model access.",
              text: "Authenticate through your ChatGPT account or an OpenAI API key supported by the CLI, subject to the provider's terms. Any applicable provider billing or usage limitations stay with OpenAI.",
            },
            {
              term: "An optional live browser.",
              text: "Enable the browser when the work involves sites, UI checks or logged-in services. You can observe the session and take over where necessary.",
            },
            {
              term: "A VM that stays available.",
              text: "Paid Hivra computers aren't paused for inactivity, so you can reconnect to your projects later.",
            },
          ],
        },
      ],
    },
    {
      heading: "From signup to first commit",
      blocks: [
        {
          kind: "steps",
          steps: [
            {
              title: "Choose Codex",
              paragraphs: [
                fill(
                  "Start a deployment with Codex selected. Name it and choose the amount of compute you need. {paidNote} The **{largerPrice} a month** plan provides {largerCompute}.",
                ),
              ],
            },
            {
              title: "Let Hivra provision it",
              paragraphs: [
                "Your computer comes up with the official Codex CLI installed and the Hivra working interfaces available. Add your repository and any project-specific tools you need.",
              ],
            },
            {
              title: "Sign in",
              paragraphs: [
                fill(
                  "Use your own ChatGPT login or OpenAI API key inside the VM. These credentials are associated with your account. {aiNote}",
                ),
              ],
            },
            {
              title: "Give Codex a real task",
              paragraphs: [
                "Ask it to review a code path, implement a feature or investigate a failing test. Use the terminal and file viewer to check the results. If the task should survive closing the tab, run it inside `tmux`.",
              ],
            },
          ],
        },
      ],
    },
    {
      heading: "The live browser is optional",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Some development tasks are purely about the repository. Others need a visual check: the app builds, but does the layout look right? The optional live browser lets you work with that part of the process without reaching for your own machine.",
            fill(
              "The browser adds **{browserAdd}** when it is enabled, which fits within the entry plan. More demanding builds, browser sessions or multiple simultaneous processes may benefit from the larger option.",
            ),
          ],
        },
      ],
    },
    {
      heading: "Self-hosted or managed?",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "You can rent a VPS, install Codex, manage your keys, configure `tmux` and set up remote access. For a developer who wants full infrastructure control, that's a reasonable choice.",
            "Hivra takes away much of that preparation. It provisions the computer, keeps the managed service available and supplies a browser-based workspace. You still decide what code and credentials the agent can access.",
            "The key point is that you are **not buying Codex from Hivra**. You are paying us to give Codex somewhere to work.",
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need an OpenAI API key?",
      a: "Not necessarily. The Hivra deployment supports using a ChatGPT sign-in or your own OpenAI API key, subject to the CLI's current supported authentication methods and OpenAI's terms.",
    },
    {
      q: "What happens when I log off?",
      a: "Your paid VM stays available, with its workspace and stored session. To keep an interactive terminal job alive across disconnections, use `tmux`. You can return later from another device.",
    },
    {
      q: "Does hosting include OpenAI usage?",
      a: "No. Hivra's hosting charge is for the computer. Provider use is governed and billed through the account or key you connect, where applicable.",
    },
    {
      q: "Can Codex use a browser?",
      a: "Yes. The current deployment includes an optional live browser, with additional resource allocation. Use it for web research and UI work, and supervise sensitive account actions.",
    },
    {
      q: "Is the CLI modified?",
      a: "No. This is the official OpenAI Codex CLI. Hivra is an independent host, not an OpenAI product.",
    },
    {
      q: "Is this more secure than running Codex on my laptop?",
      a: "It separates Codex's environment from your personal computer, which can limit what an accidental command touches. But the VM still holds whatever code, data and credentials you put there, and administrators retain infrastructure access to managed hosts. Isolation is a useful boundary, not a guarantee against every failure.",
    },
    {
      q: "Can I host Hivra myself?",
      a: fill(
        "The Hivra platform is open source. If you want to manage your own infrastructure, explore the [self-hosting]({repo}) option rather than a paid managed computer.",
      ),
    },
  ],
  closing: {
    heading: "Keep the repository moving.",
    links: [
      { label: "Deploy Codex", target: "deploy" },
      { label: "View pricing", target: "pricing" },
      { label: "See all agents", target: "agents" },
    ],
  },
  affiliation: "Hivra is independent and is not affiliated with or endorsed by OpenAI.",
  related: {
    heading: "Related",
    slugs: ["claude-code", "hermes", "aeon", "openclaw", "agent-zero"],
  },
};
