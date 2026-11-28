import type { ComparePage } from "../types";
import { formatCheckedMonth } from "../competitor-facts";
import {
  AI_ACCESS_CELL,
  AI_USAGE,
  CLOSING,
  ENTRY_PRICE_PROSE,
  HIVRA_AGENTS_CELL,
  PRICES_AS_OF_STAMP,
  REFUND_LINKED,
  STAYS_ON,
  cautionSection,
  paragraphs,
  relatedLinks,
} from "../shared-copy";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT, formatPlanSize } from "@/lib/blog/plan-facts";
import { PRODUCT_FACTS_CHECKED } from "./checked";

/**
 * Hivra against Claude Code on the web, Anthropic's own hosted sessions. Every Anthropic figure below comes
 * from Anthropic's own pages (listed under the page's sources) as of PRODUCT_FACTS_CHECKED. Where Anthropic's
 * pages do not state something (how long a paused VM waits before it is reclaimed, the longest session, the number of
 * sessions that can run at once, data residency) the copy says "its pages do not state" instead of guessing.
 * Hivra is independent of Anthropic and the copy says so wherever it mentions running the Claude Code CLI.
 */

const MONTH = formatCheckedMonth(PRODUCT_FACTS_CHECKED);

export const page: ComparePage = {
  slug: "vs-claude-code-on-the-web",
  browserTitle: "Claude Code on the web vs Hivra: a session or a computer? | Hivra",
  h1: "Claude Code on the web vs Hivra: a session or a computer?",
  metaDescription: `Hivra is ${ENTRY_PRICE_PROSE}; Claude Code on the web comes with a Claude subscription. When each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Claude Code on the web and Hivra can both keep Claude Code working after you close your laptop, so the difference is not whether it runs somewhere else. It is what that somewhere else is. Anthropic describes a cloud session as a Claude Code session that runs on cloud infrastructure instead of on your machine: you start it against a GitHub repository, it works, and you check on it or steer it from a browser, the Claude app or your terminal. Hivra gives the same official Claude Code command line tool a computer of its own, one you open, look around in and come back to.",
        "That makes this less a contest between two products than a choice between two shapes of the same work. A session is a task with a repository attached, owned and run by Anthropic. A computer is a place where your files, logins, tools and history stay between tasks, and where Claude Code can sit next to other things you run. Hivra is an independent service. It is not affiliated with, sponsored by or endorsed by Anthropic, and it runs Anthropic's own Claude Code CLI, which you sign in to with your own Claude account or run on Hivra credits.",
        "If your work is GitHub pull requests and you already pay for Claude, the session is hard to beat on simplicity, and this page says so. If you want a machine that is yours to open, or you want Claude Code beside other agents, read on.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `With Claude Code on the web you pay for a Claude subscription, not for compute. Anthropic's documentation says a cloud session counts toward your plan's usage limits alongside the rest of your Claude and Claude Code usage, and that there is no separate charge for the cloud VM. As of ${MONTH}, Anthropic's pricing page lists Claude Pro at $20 a month billed monthly or $17 a month billed annually ($200 up front), Max at $100 a month, Ultra at $200 a month, Team seats at $20 a month on annual billing or $25 monthly for Standard and $100 annual or $125 monthly for Premium, and Enterprise at $20 a seat a month billed annually with a 20-seat minimum and usage billed at API rates on top. Anthropic says its Free level does not include Claude Code, and that cloud sessions are available on Pro, Max and Team, and for Enterprise users with premium seats or Chat + Claude Code seats.`,
        "What the subscription buys is a share of usage limits, not a fixed amount of work. Anthropic says cloud sessions share rate limits with all your other Claude and Claude Code usage, and that running several tasks in parallel uses more of the allowance in proportion. Its support pages describe a five-hour session limit and a weekly limit on Pro and Max, a weekly limit only on verified Ultra accounts, and Anthropic says it may apply additional caps at its discretion. Anthropic's pages give these as multiples of Pro rather than as numbers of messages or hours, so how much a given task costs you is something you learn by using it.",
        `Hivra charges for the computer and leaves the model separate. ${ENTRY_PRICE_PROSE}. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} A Hivra account itself costs nothing, and a free account works with a server you connect yourself. ${AI_USAGE} For Claude Code that usually means signing in with your own Claude account inside the CLI, in which case your limits follow your Anthropic account wherever the work runs. So if you already pay Anthropic, Hivra is an added computer bill on top of a model bill you already have, while Claude Code on the web adds no bill beyond the subscription.`,
        "That is the honest cost picture. If all you need is the session, the web product is the cheaper way to get it. You pay for the Hivra computer because you want the computer.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra runs the official Claude Code CLI on a computer of its own, with chat, a terminal and files as tabs you open from anywhere, and a browser tab where the computer has one. ${STAYS_ON} Files, repositories, logins and the CLI's own session history stay on that computer between tasks, so the second task starts where the first left off rather than from a fresh checkout.`,
        "It also holds more than Claude Code. The same computer model runs the other agents Hivra supports, so Claude Code can share a machine, a filesystem and a browser with the rest of your setup. The repository does not have to be on GitHub: you bring it however you like and work in the terminal and Git tabs, and nothing about the remote is special. And because it is a computer rather than a session, you can open the terminal yourself and look at what the agent is doing.",
        `What Hivra does not do is match Anthropic's own integrations. It has no built-in pull request watching, it does not set up the Claude GitHub App for you, and it is not part of a Claude subscription. At the entry size it is a smaller computer than Anthropic's ceilings for a session. Hivra also has a larger size, ${formatPlanSize("larger")}, which is still below Anthropic's RAM ceiling.`,
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Choose Claude Code on the web when your work is repositories on GitHub and you already have a Claude subscription that includes it. It adds no compute bill, it starts from the browser or the Claude app, and Anthropic's own integrations are there: the Claude GitHub App can watch a pull request and respond to CI failures and review comments, sessions can be grouped into projects, and the same cloud sessions back Claude in Slack. Hivra has none of that built in.",
        "Choose it too when you need what Anthropic documents for its hosted product and Hivra does not claim: every operation in a cloud session is logged for compliance and audit, GitHub credentials stay encrypted on Anthropic's servers and never enter the VM, and Anthropic's security overview points to its Trust Center for its SOC 2 Type 2 report and ISO 27001 certificate; confirm what each covers with Anthropic. Hivra does not claim an attestation of that kind. For a team with an audit requirement, that usually decides it, subject to one check first: make sure your organization is not on Zero Data Retention, the HIPAA configuration, customer-managed keys or an IP allowlist. Anthropic says cloud sessions do not work with the first three and fail on the last unless Anthropic support exempts them.",
        "Anthropic's sessions also run on a bigger machine than Hivra's entry size, though Hivra's larger size narrows the gap. Its cloud environments page gives approximate ceilings of 4 vCPUs, 16 GB of RAM and 30 GB of disk, which may change. And if you do not want to pay for a machine that sits there between tasks, a session that pauses when idle is a sensible way to avoid it.",
        "Teams that want sessions in their own network can ask about Anthropic's self-hosted environments, a public beta on Team and Enterprise where repository checkouts and secrets stay on your machines but the conversation still goes to Anthropic.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and Claude Code on the web compared",
          rows: [
            {
              criterion: "Price model",
              hivra: `A fixed monthly computer. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
              alternative: "No separate compute charge. Included with Claude Pro, Max and Team plans, and Enterprise premium or Chat + Claude Code seats",
            },
            {
              criterion: "Entry price",
              hivra: "$9.99/month, 2 vCPU and 4 GB RAM, plus your Claude account or Hivra credits for the model",
              alternative: "Claude Pro at $20/month billed monthly or $17/month billed annually",
            },
            {
              criterion: "What you get",
              hivra: "A computer of its own with chat, terminal and files to open, and a browser where the computer has one",
              alternative: "A cloud session started against a GitHub repository, steered from browser, phone or terminal",
            },
            {
              criterion: "What stays on",
              hivra: STAYS_ON,
              alternative: "Pauses after a few idle minutes with files saved. The reclaim period is not stated",
            },
            {
              criterion: "Persistence",
              hivra: "Files, repos, logins and CLI session history stay on the computer",
              alternative: "Files kept while paused. After a reclaim, conversation history returns on a fresh VM",
            },
            {
              criterion: "Supported agents",
              hivra: HIVRA_AGENTS_CELL,
              alternative: "Claude Code only",
            },
            {
              criterion: "Models and AI cost",
              hivra: AI_ACCESS_CELL,
              alternative: "Claude models, counted against your subscription's usage limits",
            },
            {
              criterion: "Access method",
              hivra: "Browser tabs for chat, terminal and files, plus a browser tab where the computer has one; Telegram on Claude Code",
              alternative: "claude.ai/code, the Claude app, the terminal with claude --cloud, scheduled tasks",
            },
            {
              criterion: "Setup effort",
              hivra: "Launch the computer, sign in to Claude, bring your repository",
              alternative: "Sign in, connect GitHub, choose an environment",
            },
            {
              criterion: "Who maintains it",
              hivra: "Hivra runs the computer. The CLI is Anthropic's own",
              alternative: "Anthropic runs and manages the infrastructure",
            },
            {
              criterion: "Data and security",
              hivra: "A private computer for you. With your own Claude account, prompts go to Anthropic; no audit attestation claimed",
              alternative: "Isolated VM, logged operations, credentials kept outside it. Retention depends on your plan",
            },
            {
              criterion: "Limits",
              hivra: "The size of the computer. Claude usage follows your Anthropic account",
              alternative: "Shared Claude usage limits, and Anthropic may apply additional caps at its discretion. About 4 vCPUs, 16 GB RAM, 30 GB disk, subject to change",
            },
            {
              criterion: "Repositories",
              hivra: "Any, through the terminal and Git tabs",
              alternative: "GitHub (including GitHub Enterprise Server on Team and Enterprise) for clone and pull requests. Other hosts only as a bundle, with no push back",
            },
            {
              criterion: "Refund",
              hivra: REFUND_LINKED,
              alternative: "Payments are non-refundable except where the Consumer Terms or law provide. A 14-day refund in the EEA and UK",
            },
            {
              criterion: "Exit and portability",
              hivra: "Your files are on a computer you can open and copy from",
              alternative: "Pull a session into your terminal with --teleport; delete sessions at any time",
            },
            {
              criterion: "Best for",
              hivra: "A persistent environment, other agents, any Git host",
              alternative: "GitHub work on an existing Claude subscription, and audit needs",
            },
          ],
        },
      ],
    },
    {
      heading: "Who should pick which",
      blocks: [
        {
          kind: "entries",
          items: [
            {
              lead: "Priya, a backend developer on a Claude Pro subscription:",
              text: "Her work is pull requests against a GitHub repository, and she wants Claude Code to fix failing tests while she is away from her desk. Claude Code on the web. It adds no compute bill, and the GitHub integration is already there.",
            },
            {
              lead: "Tom, who runs Claude Code beside other agents:",
              text: "He wants his logins, tools, projects and session history to be there each morning, and a second agent on the same machine. A Hivra computer, which stays on and keeps them.",
            },
            {
              lead: "Dana, an engineering lead on Team seats with an audit requirement:",
              text: "She needs logged operations, an isolated VM per session and a vendor with published attestations. Claude Code on the web, after checking that her organization is not on Zero Data Retention, the HIPAA configuration, customer-managed keys or an IP allowlist: Anthropic says cloud sessions do not work with the first three and fail on the last unless Anthropic support exempts them. Hivra does not claim an attestation of that kind.",
            },
            {
              lead: "Marcus, an indie developer whose code is on GitLab:",
              text: "Anthropic's pages say a cloud session cannot push results back to a GitLab or Bitbucket remote when the repository is sent as a bundle. Marcus wants a computer he can push from. Hivra, where the Git tab and terminal work against any remote.",
            },
            {
              lead: "Lena, an open-source maintainer who already pays for Claude:",
              text: "She does one-off fixes on public repositories and does not want a monthly line item beyond her subscription. Claude Code on the web. For occasional one-off fixes, a computer that stays on would cost more than the work needs.",
            },
            {
              lead: "Sam, who builds web apps and wants a real browser next to the repository:",
              text: "He wants the agent to open and test the running app in a browser on the same machine. Hivra, on a computer that has a browser tab beside the terminal and files.",
            },
            {
              lead: "Ravi, who has no Claude subscription yet:",
              text: "Anthropic's pages say cloud sessions need Pro, Max or Team, or an Enterprise seat that includes Claude Code. Ravi can launch Claude Code on a Hivra computer and pay for model use with Hivra credits instead. Hivra credits run Claude Code on Claude models served through Hivra, not through an Anthropic subscription, so it is not identical to a subscription setup. Hivra, if he wants to start without a Claude subscription.",
            },
          ],
        },
      ],
    },
    {
      heading: "How to try both",
      blocks: [
        {
          kind: "steps",
          items: [
            {
              lead: "Pick one small, real task.",
              text: "A bug fix or a small refactor in a repository you know, with tests you can run. Use the same task for both so the comparison means something.",
            },
            {
              lead: "Run it as a cloud session.",
              text: "Open claude.ai/code, or run `claude --cloud` from the terminal, against the repository. Cloud sessions need a Claude plan that includes them, and a GitHub repository for a normal clone and pull request.",
            },
            {
              lead: "Run it on a Hivra computer.",
              text: "Launch Claude Code from [the agents page](/agents) on a paid Hivra Cloud computer, sign in with your own Claude account, and bring the repository in through the terminal or Git tab. Hivra is independent of Anthropic and runs Anthropic's own CLI.",
            },
            {
              lead: "Walk away from both.",
              text: "Close the laptop, then come back later. For the Hivra run, start Claude Code inside tmux in the computer's Terminal tab, so it keeps going. Note what is still there when you return, and what you had to set up again.",
            },
            {
              lead: "Check your usage.",
              text: "If you signed in to Hivra with the same Claude account, both runs drew on the same usage limits. Look at how much of your window each used before deciding.",
            },
            {
              lead: "Add up a month.",
              text: "Count the subscription on one side. On the other, count the Hivra computer plus any model usage you pay outside your subscription. Pick the cheaper option unless the persistence or non-GitHub needs from the scenarios above apply to you.",
            },
          ],
        },
        ...paragraphs(
          "You can also keep both. Use cloud sessions for GitHub pull requests and keep a Hivra computer for work that needs files, tools and other agents to stay put.",
        ),
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Anthropic's side, the answer depends on how long the session has been idle. Its cloud environments documentation says that after a few idle minutes a session's VM pauses with its files saved, and your next message restores the same VM and starts Claude Code again. A paused VM can later be reclaimed, and Anthropic's pages do not state how long that takes. If the paused VM has been reclaimed, reopening the session provisions a fresh VM instead. After a reclaim, conversation history is restored, but running shell commands, subagents and session-scoped scheduled tasks are not. Anthropic stores the session transcript so you can return to it.",
        "A setup script's result is cached for later sessions, so installed packages and written files carry over. Running processes and started databases do not, and packages Claude installs in the middle of a session are not carried into other sessions. A foreground command waits 2 minutes by default and up to 10; one that times out moves to the background and can run up to 30 more minutes, and an environment can raise these. Anthropic's pages do not state a longest session, or how many sessions can run at once.",
        `On Hivra's side, the computer is the persistent thing. ${CLI_RUN_LIFETIME} Files, repositories, logins and CLI session history stay on the computer, whether or not a browser tab is open. Hivra does not promise backups, so copy out anything you cannot afford to lose, as you would on any machine.`,
        "Retention is a separate question from persistence, and the two products answer it differently. Anthropic's data usage page says that for Free, Pro and Max accounts, retention is five years if data use for model improvement is allowed and 30 days if not, and that Team, Enterprise and API use standard 30-day retention. If you sign in to Claude on a Hivra computer, your prompts go to Anthropic under the same terms, while the files on the computer are yours to keep or delete there.",
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: {
    checked: PRODUCT_FACTS_CHECKED,
    intro: `Anthropic's figures on this page come from the pages below, as of ${MONTH}. Anthropic changes plans and limits, so check them before you pay.`,
    notes: [
      "Anthropic's pricing page shows its prices without a sign-in and labels none of them as promotional. It says prices and plans are subject to change, and it does not mention Claude Code on the web by name.",
      "Self-hosted environments, where cloud sessions run on runners in a customer's own network, are a public beta on Team and Enterprise, off by default. The conversation still goes to Anthropic, which stores the transcript.",
      "Claude Managed Agents, Anthropic's beta hosted agent APIs billed on tokens plus a per-session-hour rate, are a separate product and are not compared here.",
      "Anthropic's pages do not state data residency for cloud session VMs, the longest a session can run, or how many can run at once.",
    ],
    links: [
      { label: "Anthropic: Claude Code on the web", href: "https://code.claude.com/docs/en/claude-code-on-the-web" },
      { label: "Anthropic: cloud environments", href: "https://code.claude.com/docs/en/cloud-environments" },
      { label: "Anthropic: self-hosted environments", href: "https://code.claude.com/docs/en/self-hosted-environments" },
      { label: "Anthropic: security", href: "https://code.claude.com/docs/en/security" },
      { label: "Anthropic: data usage", href: "https://code.claude.com/docs/en/data-usage" },
      { label: "Claude pricing", href: "https://claude.com/pricing" },
      { label: "Anthropic support: Claude Code with Pro or Max", href: "https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan" },
      { label: "Anthropic support: refunds for a paid Claude plan", href: "https://support.claude.com/en/articles/12386328-request-a-refund-for-a-paid-claude-plan" },
      { label: "Anthropic: Claude Managed Agents", href: "https://claude.com/platform/claude-managed-agents" },
    ],
  },
  faqs: [
    {
      q: "Is Claude Code on the web free?",
      a: "Not on its own. Anthropic says cloud sessions are available on Pro, Max and Team, and for Enterprise users with premium seats or Chat + Claude Code seats, and that there is no separate charge for the cloud VM. The session counts toward your plan's usage limits. Anthropic's pricing page lists its Free level without Claude Code.",
    },
    {
      q: "How much does Hivra cost compared with Claude Code on the web?",
      a: `Hivra is ${ENTRY_PRICE_PROSE}. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} A Hivra account itself costs nothing. The plan does not include AI usage, so Claude Code on Hivra is paid for with your own Claude account or Hivra credits. Claude Code on the web has no compute charge but needs a Claude subscription, which Anthropic lists from $20 a month billed monthly, as of ${MONTH}.`,
    },
    {
      q: "Can I use Claude Code on the web and Hivra together?",
      a: "Yes. They are separate. If you sign in to Claude on a Hivra computer with the same account, both draw on the same Claude usage limits, and Anthropic says cloud sessions share limits with your other Claude and Claude Code usage. Many people use cloud sessions for GitHub pull requests and a Hivra computer for work that needs persistent files and tools.",
    },
    {
      q: "Will Claude Code keep running when I close my laptop?",
      a: "On Anthropic's side, yes: its documentation says a cloud session keeps running after you close your laptop. Anthropic says a session's VM pauses with its files saved after a few idle minutes; a paused VM can later be reclaimed, and its pages do not state how long that takes. Running shell commands are not restored after a reclaim. On Hivra, a paid computer stays on and is not paused for inactivity. A Claude Code run you start inside tmux in the computer's Terminal tab keeps going after you close the laptop.",
    },
    {
      q: "Does Claude Code on the web work with GitLab or Bitbucket?",
      a: "Only partly. Anthropic's pages say repository cloning and pull requests need GitHub, including self-hosted GitHub Enterprise Server on Team and Enterprise plans. A GitLab or Bitbucket repository can be sent to a session as a local bundle, but the session cannot push results back to that remote. On a Hivra computer you work in a terminal and Git tab, so any remote you can reach from it works.",
    },
    {
      q: "Where does my code and data go?",
      a: "With Claude Code on the web, the session runs in an Anthropic-managed VM, and Anthropic says its operations are logged and that sessions can be deleted at any time. Retention depends on your plan and on whether data use for model improvement is allowed. On Hivra, your files sit on a computer of your own. If you sign in with your own Claude account, your prompts still go to Anthropic under the same terms. Its pages do not state a data region for cloud session VMs.",
    },
    {
      q: "Which is better for a team with security or audit needs?",
      a: "Claude Code on the web, if you need what Anthropic documents: logged operations, credentials kept outside the VM, and a security overview pointing to a Trust Center for its SOC 2 Type 2 report and ISO 27001 certificate. Hivra does not claim an attestation of that kind. Confirm what each report covers with Anthropic, and check first that your organization is not on Zero Data Retention, the HIPAA configuration, customer-managed keys or an IP allowlist: Anthropic says cloud sessions do not work with the first three and fail on the last unless Anthropic support exempts them.",
    },
    {
      q: "Is Hivra affiliated with Anthropic?",
      a: "No. Hivra is an independent service. It runs Anthropic's own Claude Code CLI on a computer you control, and you sign in with your own Claude account or use Hivra credits. It is not affiliated with, sponsored by or endorsed by Anthropic.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-openai-codex-cloud", "vs-cursor-cloud-agents", "vs-github-codespaces"],
    blog: ["managed-vs-self-hosted-ai-agents"],
    agents: ["claude-code"],
    docs: ["claude-code"],
    pricing: true,
    extra: [{ label: "Blog: Will Claude Code keep running if you close your laptop?", href: "/blog/keep-claude-code-running-24-7" }],
  }),
};
