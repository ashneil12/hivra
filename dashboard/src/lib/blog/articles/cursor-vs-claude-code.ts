import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

// Written 2026-10-06 for "cursor vs claude code" (US Aug 6,600, avg 8,100; UK 1,000)
// plus "claude code vs cursor" (Aug 1,900, avg 6,600; UK 880). Niche finder score 20/25.
// Voice rewrite 2026-10-06 after Ash's "reads like a robot made the page": plain words,
// prose over stacked bullets, one Hivra line where the closed-laptop problem is real.
// Also fixes the cost section, which printed raw ${...} placeholders on canary.
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
    "Cursor vs Claude Code, sorted by the job: editing while you watch, or work that keeps going after you leave. No speed contest, no made-up winner.",
  publishedDate: "2026-10-06",
  lastModified: "2026-10-06",
  readingTimeMin: 7,
  author: "Hivra team",
  tagline: "They do different jobs. Pick by where the work needs to happen once you leave your desk.",
  intro: `Most Cursor vs Claude Code posts crown a winner on vibes. We're not doing that. The useful question is simpler. Do you want to sit and watch the agent edit, or do you need it to keep working after you leave? We checked Cursor's and Anthropic's docs on ${READ_ON}. No speed race, and no "smarter model" verdict, because we haven't timed either one on your code.`,
  shortAnswer: `Cursor is a code editor with agents inside it. You watch them work. Claude Code is a terminal agent that can live on a computer that stays on. If the work has to keep going after you walk away, use Cursor Cloud Agents, or run Claude Code or Codex in tmux on a computer that stays on.`,
  sections: [
    {
      heading: "What's the actual difference?",
      paragraphs: [
        "Cursor is a code editor built around AI agents. You sit in the editor, and the agent edits files, runs commands and opens PRs right there in front of you. Need it to keep going without your laptop? Cursor sends that work to [Cloud Agents](/blog/cursor-cloud-agents) (they used to be called Background Agents), which run on Cursor's own servers.",
        `Claude Code is Anthropic's coding agent. According to Anthropic's [overview](${CLAUDE_OVERVIEW}), read ${READ_ON}, it runs in the terminal, in IDE extensions, in a desktop app and in the browser. The terminal version is the one that suits a computer that stays on. Install it, sign in, start it inside tmux, walk off.`,
        "Same kind of work. Different homes. Cursor wants you in the editor, and Claude Code is perfectly happy in a terminal window.",
      ],
    },
    {
      heading: "Which one fits which job?",
      paragraphs: [
        [
          "| Job | Cursor | Claude Code |",
          "|---|---|---|",
          "| Live edits while you watch the diff | Yes. That's what the editor is for | Possible through the IDE extension, but the terminal is its home |",
          "| Multi-file refactors you review as you go | Good fit | Good fit too. You review the diffs in the terminal afterwards |",
          "| You close the laptop and leave | Use Cloud Agents. A local agent will pause | Run it on a computer that stays on, or use Claude Code on the web for GitHub-only work |",
          "| You already spend all day in Cursor | Stay. Add Cloud Agents for the unattended stuff | Only worth switching if you want to work from a terminal |",
          "| You already pay for Claude Pro or Max | You still need a Cursor plan plus Cloud Agent usage | Bills through the Claude plan you already have |",
          "| A long overnight run you can reattach to | Cloud Agents give you Cursor's cloud shell and PR screenshots | tmux on your own computer gives you a shell that's yours |",
        ].join("\n"),
        "If most of your work is \"sit with me while we edit,\" Cursor is built for that. If it's \"keep going after I leave,\" your shortlist is Claude Code on a computer that stays on, or Cursor Cloud Agents. We're not calling either one faster or smarter. Want a winner? Give both the same task on your own repo and see what comes back.",
      ],
    },
    {
      heading: "What does \"keeps going when I walk away\" really mean?",
      paragraphs: [
        "People use the word \"unattended\" for three very different setups, and it's worth knowing which one you're actually getting.",
        "The first is an agent running on your laptop. Close the lid and it pauses, because the laptop is asleep. That goes for local Cursor agents and for Claude Code started on your laptop.",
        "Then there's the vendor's cloud. Cursor Cloud Agents run on Cursor's machines, and Claude Code on the web runs on Anthropic's. Your laptop can sleep all it likes. In return, you live with their environment, their limits and their billing.",
        "Last is a terminal agent on a computer that stays on: Claude Code or Codex inside tmux on a desktop at home, a VPS, or a managed computer. You reattach whenever you want. Your files and logins stay put on that machine.",
        `Cursor's [Cloud Agents docs](${CURSOR_CLOUD}), read ${READ_ON}, cover the vendor-cloud route for Cursor users. Anthropic's cloud sessions do the same for Claude Code, as long as your work lives on GitHub. The third setup is the one we can vouch for: start the official CLI in tmux, keep the computer on, come back when you like.`,
        "Quick note on Claude Code Remote Control. It's a window into a session that's still running on some machine, and that machine still has to stay awake. More in [Claude Code Remote Control](/blog/claude-code-remote-control).",
      ],
    },
    {
      heading: "What will each one cost?",
      paragraphs: [
        "Every setup has two bills. One for the model. One for wherever the agent runs.",
        "With Cursor, Cloud Agents need a paid Cursor plan, and then you pay the selected model's API rates up to a spend limit you set. The [Cloud Agents cost page](/blog/cursor-cloud-agents) has the details.",
        "Claude Code bills through Claude Pro, Max or an API key with Anthropic. We did the plan maths in [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code).",
        "Running a terminal agent on a computer that stays on adds a computer bill: your own hardware, a VPS or a managed computer. The model still bills to Anthropic or OpenAI on your own login.",
        "We won't tell you one is cheaper than the other. That comes down to your hours, your model, and whether you already pay for one of them. The vendors' own dated pricing pages beat any total a blog invents.",
      ],
    },
    {
      heading: "Fix the closed-laptop problem first",
      paragraphs: [
        "If the real pain is \"I shut my laptop and the agent dies,\" sort that out before you worry about which tool is smarter.",
        "Staying in Cursor? Use [Cursor Cloud Agents](/blog/cursor-cloud-agents). Is the work all on GitHub, and you already pay for Claude? Claude Code on the web will do it. And if you want a terminal you own, run Claude Code or Codex in tmux on a computer that stays on.",
        `That last one is what Hivra is for: a computer that stays on for [Claude Code](/agents/claude-code) or [Codex](/agents/codex), signed in with your own account, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}.`,
        "Choosing between Claude Code and Codex for this? See [Claude Code vs Codex](/blog/claude-code-vs-codex-24-7).",
        "Hivra is independent and is not affiliated with Cursor, Anthropic or OpenAI.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is Cursor better than Claude Code?",
      a: "There's no universal winner. Cursor suits live editing in an IDE. Claude Code suits a terminal agent you leave running on a computer that stays on. We don't call either one better or faster without a real test on your repo.",
    },
    {
      q: "Can Cursor keep working when I walk away?",
      a: "Local Cursor agents pause when your laptop sleeps. Cursor Cloud Agents run on Cursor's servers and keep going after you close the lid. Our Cloud Agents page covers how that's billed.",
    },
    {
      q: "Can Claude Code keep working when I walk away?",
      a: "Not on a sleeping laptop. Use Claude Code on the web for GitHub-only work, or run the CLI inside tmux on a machine that stays on. Our closed-laptop guide walks through both.",
    },
    {
      q: "Should I use Cursor or Claude Code for long unattended runs?",
      a: "Either works. Pick Cursor Cloud Agents if you want Cursor's editor and PRs with screenshots. Pick the terminal CLI if you want your own shell, your own files and your own subscription login on a computer you control.",
    },
    {
      q: "Do I need both Cursor and Claude Code?",
      a: "Plenty of people use Cursor for hands-on editing and a terminal agent for overnight work. You don't have to marry one. Use whichever survives the job in front of you.",
    },
    {
      q: "Does Hivra replace Cursor?",
      a: "No. Hivra is a computer that runs agents like Claude Code and Codex. It doesn't replace Cursor's editor, and we haven't tested it as a Cursor My Machine.",
    },
    {
      q: "Cursor vs Claude Code vs Codex?",
      a: "Cursor is the editor. Claude Code and Codex are terminal agents, signed in with Anthropic and OpenAI accounts. For running those two around the clock, see Claude Code vs Codex. For Cursor's cloud option, see Cursor Cloud Agents.",
    },
  ],
  relatedArticles: [
    { slug: "cursor-cloud-agents", title: "Cursor Cloud Agents: what they cost, and what happens when you close your laptop" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude Code keep running if you close your laptop? (And how to run it 24/7)" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "claude-code-remote-control", title: "Claude Code Remote Control" },
    { slug: "claude-max-vs-pro-for-claude-code", title: "Claude Code pricing: Pro vs Max, and when API billing is cheaper" },
  ],
};
