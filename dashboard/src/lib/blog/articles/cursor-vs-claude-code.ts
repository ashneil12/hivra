import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

// Written 2026-10-06 for "cursor vs claude code" (US Aug 6,600, avg 8,100; UK 1,000)
// plus "claude code vs cursor" (Aug 1,900, avg 6,600; UK 880). Niche finder score 20/25.
//
// Sources read 6 October 2026:
// - https://cursor.com/docs/cloud-agent (Cloud Agents for laptop-closed Cursor work)
// - https://cursor.com/help/ai-features/cloud-agents
// - https://code.claude.com/docs/en/overview (Claude Code surfaces: terminal, IDE, desktop, web)
// - Existing Hivra truth: Claude Code / Codex on own login; keeps-working via tmux / Telegram tab
//
// Rules for this page: sort by job, no unbacked "better" or "faster", soft handoff to an
// always-on terminal agent. Interlink the Cloud Agents cost page.

const READ_ON = "6 October 2026";
const CURSOR_CLOUD = "https://cursor.com/docs/cloud-agent";
const CLAUDE_OVERVIEW = "https://code.claude.com/docs/en/overview";

export const article: BlogArticle = {
  slug: "cursor-vs-claude-code",
  title: "Cursor vs Claude Code: which keeps going when you walk away?",
  metaTitle: "Cursor vs Claude Code: which keeps going",
  metaDescription:
    "Cursor vs Claude Code by job: IDE edits vs runs that keep going when you walk away. No better or faster claims. Soft path to a terminal agent.",
  publishedDate: "2026-10-06",
  lastModified: "2026-10-06",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "Different jobs. Pick by where the work has to live when you leave the desk.",
  intro: `Most \"Cursor vs Claude Code\" posts pick a winner on vibes. This one sorts by the job: editing inside an IDE while you watch, versus a run that has to keep going after you walk away. Facts below were checked against Cursor and Anthropic docs on ${READ_ON}. No speed race. No \"better model\" claim without a recorded bake-off on your repo.`,
  shortAnswer: `Cursor is an IDE with agents that edit in your editor. Claude Code is a terminal agent that can live on a computer that stays on. For work that keeps going after you walk away, use Claude Code or Codex in tmux, or Cursor Cloud Agents. This page sorts by job, with no speed claims.`,
  sections: [
    {
      heading: "What each product is",
      paragraphs: [
        "Cursor is a code editor built around AI agents. You stay in the IDE. The agent edits files, runs commands and opens PRs from that editor workflow. When you need the agent to keep working without your laptop, Cursor's answer is [Cloud Agents](/blog/cursor-cloud-agents) (formerly Background Agents), which run in Cursor's cloud VMs.",
        `Claude Code is Anthropic's agentic coding tool. Anthropic's [overview](${CLAUDE_OVERVIEW}), read ${READ_ON}, lists it in the terminal, IDE extensions, a desktop app and the browser. The terminal CLI is the surface that fits a computer that stays on: install it, sign in, leave it inside tmux.`,
        "Same problem space. Different homes. Cursor wants you in the editor. Claude Code is happy living in a shell.",
      ],
    },
    {
      heading: "Sort by job, not by hype",
      paragraphs: [
        [
          "| Job | Lean Cursor | Lean Claude Code |",
          "|---|---|---|",
          "| Live edits while you watch the diff | Yes. That is the IDE loop. | Possible via IDE extension, but the CLI is the native home. |",
          "| Multi-file refactors you review in the editor | Strong fit | Strong fit in the terminal with diffs you inspect after |",
          "| You close the laptop and leave | Use Cursor Cloud Agents, not a local agent | Use Claude Code on a machine that stays on (or Claude Code on the web for GitHub-only work) |",
          "| You already live in Cursor all day | Stay. Add Cloud Agents for unattended work. | Only switch if you want a terminal-first workflow |",
          "| You already pay for Claude Pro or Max | Cursor still needs its own plan and Cloud Agent usage | Claude Code bills through the Claude plan you have |",
          "| Long overnight CLI run with a reattachable shell | Cloud Agents give you Cursor's cloud shell and artifacts | tmux on your own computer gives you a shell you own |",
        ].join("\n"),
        "If your backlog is mostly \"sit with me and edit,\" Cursor wins the workflow. If your backlog is mostly \"keep going after I leave,\" Claude Code on a computer that stays on (or Cursor Cloud Agents) is the honest shortlist. We are not calling either one faster or smarter here. Run the same task on your repo if you need a winner.",
      ],
    },
    {
      heading: "What \"keeps going when I walk away\" actually means",
      paragraphs: [
        "Three different setups get sold as \"unattended\":",
        [
          "1. **Local agent on your laptop.** Walk away and close the lid, and sleep pauses it. True for local Cursor agents and for Claude Code started on the laptop.",
          "2. **Vendor cloud agent.** Cursor Cloud Agents run in Cursor's VMs. Claude Code on the web runs on Anthropic's machines. Your laptop can sleep. You trade that for the vendor's environment, limits and billing.",
          "3. **Terminal agent on a computer that stays on.** Claude Code or Codex inside tmux on a desktop, home server, VPS or managed computer. You reattach later. Files and logins stay on that machine.",
        ].join("\n"),
        `Cursor's own [Cloud Agents docs](${CURSOR_CLOUD}), read ${READ_ON}, are option 2 for Cursor users. Anthropic's cloud sessions are option 2 for Claude Code users who live in GitHub. Option 3 is the soft handoff this site can back today: start the official CLI inside tmux, keep the computer up, come back when you want.`,
        "Remote Control for Claude Code is a window into a session that is still running on a machine. The machine still has to stay awake. Details: [Claude Code Remote Control](/blog/claude-code-remote-control).",
      ],
    },
    {
      heading: "Cost shape (no invented totals)",
      paragraphs: [
        "Two bills show up in every setup: the model bill and the place the agent runs.",
        [
          "- **Cursor:** paid Cursor plan for Cloud Agents, then usage at the selected model's API rates with a spend limit ([Cloud Agents cost page](/blog/cursor-cloud-agents)).",
          "- **Claude Code:** Claude Pro, Max or API key through Anthropic. Plan math: [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code).",
          "- **Host (only for option 3):** your own hardware, a VPS, or a managed computer. Hivra is ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, with a ${MONEY_BACK_GUARANTEE}. That is the computer bill only. Model usage still goes to Anthropic or OpenAI on your login.",
        ].join("\n"),
        "We are not publishing a \"Cursor is cheaper\" or \"Claude Code is cheaper\" line. Your hours, model choice and whether you already pay for one subscription decide that. Dated vendor pages beat any blog total.",
      ],
    },
    {
      heading: "Where Hivra fits (and where it does not)",
      paragraphs: [
        `Hivra is a computer for you and your agents. Launch [Claude Code](/agents/claude-code) or [Codex](/agents/codex), sign in with your own account, and start long runs inside tmux in the Terminal tab. Claude Code also has a Telegram tab for sending work from your phone. Those runs execute on the Hivra computer, so they keep going after you close the laptop.`,
        "Hivra is a weak fit when:",
        [
          "- You want Cursor's IDE loop and Cloud Agent artifacts. Stay in Cursor.",
          "- You only need Claude Code on GitHub and Anthropic's cloud is enough.",
          "- You want Hivra to act as a Cursor My Machine. **Not tested.** See the caveat on the [Cloud Agents page](/blog/cursor-cloud-agents).",
        ].join("\n"),
        "Hivra is independent and is not affiliated with Cursor, Anthropic or OpenAI.",
      ],
    },
    {
      heading: "Try the walk-away path without a bake-off sermon",
      paragraphs: [
        "If the pain is \"I close the lid and the agent dies,\" fix that first. Pick one:",
        [
          `- [Cursor Cloud Agents](/blog/cursor-cloud-agents) if you want to stay in Cursor.`,
          `- Claude Code on the web if the work is GitHub-only and you already pay for Claude.`,
          `- Claude Code or Codex in tmux on a computer that stays on if you want a shell you own.`,
        ].join("\n"),
        `On Hivra that last path is [Claude Code](/agents/claude-code) or [Codex](/agents/codex) at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. Paid plans are not paused for inactivity. Compare Claude Code with Codex for 24/7 work on [Claude Code vs Codex](/blog/claude-code-vs-codex-24-7).`,
      ],
    },
  ],
  faqs: [
    {
      q: "Is Cursor better than Claude Code?",
      a: "No universal winner. Cursor fits live IDE work. Claude Code fits a terminal agent you can leave on a computer that stays on. For walk-away runs, compare Cursor Cloud Agents with Claude Code in tmux (or Claude Code on the web). We do not claim either is better or faster without a recorded run on your repo.",
    },
    {
      q: "Can Cursor keep working when I walk away?",
      a: "Local Cursor agents on your laptop pause when the laptop sleeps. Cursor Cloud Agents run in Cursor's cloud and keep going after you close the lid. Details and cost: the Cloud Agents page.",
    },
    {
      q: "Can Claude Code keep working when I walk away?",
      a: "Not on a sleeping laptop. Use Claude Code on the web for GitHub-only cloud sessions, or run the CLI inside tmux on a machine that stays on. See the laptop-closed guide.",
    },
    {
      q: "Should I use Cursor or Claude Code for long unattended runs?",
      a: "Either Cursor Cloud Agents or Claude Code (or Codex) on a computer that stays on. Pick Cursor Cloud Agents if you want Cursor's editor workflow and PR artifacts. Pick the terminal CLI if you want your own shell, files and subscription login on hardware you control.",
    },
    {
      q: "Do I need both Cursor and Claude Code?",
      a: "Many people use Cursor for interactive editing and a terminal agent for overnight work. You do not have to pick only one product forever. Match each job to the surface that survives that job.",
    },
    {
      q: "Does Hivra replace Cursor?",
      a: "No. Hivra is a computer that runs agents such as Claude Code and Codex. It does not replace Cursor's IDE. It also is not a proven Cursor My Machine host.",
    },
    {
      q: "Cursor vs Claude Code vs Codex?",
      a: "Cursor is the IDE. Claude Code and Codex are terminal agents with different vendor logins. For 24/7 hosting of the two CLIs, see Claude Code vs Codex. For Cursor's cloud path, see Cursor Cloud Agents.",
    },
  ],
  relatedArticles: [
    { slug: "cursor-cloud-agents", title: "Cursor Cloud Agents: cost, laptop-closed runs, and a simpler path" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude Code keep running if you close your laptop? (And how to run it 24/7)" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "claude-code-remote-control", title: "Claude Code Remote Control" },
    { slug: "claude-max-vs-pro-for-claude-code", title: "Claude Code pricing: Pro vs Max, and when API billing is cheaper" },
  ],
};
