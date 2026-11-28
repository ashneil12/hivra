import type { ComparePage } from "../types";
import {
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
import { formatCheckedMonth } from "../competitor-facts";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT, formatPlanSize } from "@/lib/blog/plan-facts";
import { PRODUCT_FACTS_CHECKED } from "./checked";

/*
 * Hivra and OpenAI Codex cloud (ChatGPT Codex).
 *
 * The honest framing: Hivra runs the Codex CLI on a persistent computer; Codex cloud runs each task in an
 * OpenAI-managed sandbox. Every OpenAI fact below comes from OpenAI's own pages (learn.chatgpt.com), read for the
 * figures dated by PRODUCT_FACTS_CHECKED. What those pages do not state (a task timeout, a refund policy, the
 * sandbox technology, a fixed cloud-task allowance) is left out, or said to be unstated.
 */

const AS_OF = formatCheckedMonth(PRODUCT_FACTS_CHECKED);

const SOURCE_LINKS = [
  { label: "Codex Cloud", href: "https://learn.chatgpt.com/docs/cloud" },
  { label: "Pricing", href: "https://learn.chatgpt.com/docs/pricing" },
  { label: "Cloud environments", href: "https://learn.chatgpt.com/codex/environments/cloud-environments" },
  { label: "Internet access", href: "https://learn.chatgpt.com/docs/cloud/internet-access.md" },
  { label: "ChatGPT Work cloud security", href: "https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security.md" },
  { label: "Codex CLI", href: "https://learn.chatgpt.com/docs/codex/cli.md" },
  { label: "Codex IDE extension", href: "https://learn.chatgpt.com/docs/codex/ide.md" },
];

export const page: ComparePage = {
  slug: "vs-openai-codex-cloud",
  browserTitle: "OpenAI Codex cloud vs Hivra: tasks or a computer | Hivra",
  h1: "OpenAI Codex cloud vs Hivra: tasks in a sandbox or a computer that stays on",
  metaDescription: `Codex cloud runs tasks in OpenAI sandboxes; Hivra runs Codex CLI on its own computer, ${ENTRY_PRICE_PROSE}. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "This is not a choice between two ways of paying for the same thing. OpenAI's Codex cloud runs a coding task in a virtual machine that OpenAI manages. You hand it a job, it works in its own workspace, and you come back to review the changes, then commit or open a pull request. Hivra runs the Codex command line tool on a computer that belongs to you and stays on, so you open it, look at its files and terminal, and carry on where you left off.",
        "Both can keep working while your own laptop is asleep. The difference is what is left behind when the work stops. With Codex cloud the unit is the task, and the saved state of a task is recoverable for a limited window. With Hivra the unit is the computer, and the computer is still there tomorrow with its files, its installed tools and its session history.",
        "Hivra is not affiliated with or endorsed by OpenAI. It runs the Codex CLI that OpenAI publishes, and you sign in with your own ChatGPT account or your own OpenAI API key inside Codex, or pay for usage with Hivra credits. You can use both, and nothing about one stops the other. The sections below say which job suits which.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `With Codex cloud you are paying for a ChatGPT plan, and Codex is one of the things in it. As of ${AS_OF}, OpenAI's pricing page lists Codex as included across its plans, from Free and Go through Plus at $20 a month, Pro from $100 a month ($100, $200 or $500, with the fastest mode on the $500 tier), and Business at $20 per user per month on annual billing for two or more users, or $25 monthly. Enterprise and Edu are by contact. Plus users get the smaller cloud VM, 2 vCPU, 8 GiB of memory and 8 GiB of disk, while ChatGPT Pro, from $100 a month, is where the 4 vCPU size and higher usage begin. The cards for Free and Go mention the desktop app, and the page says availability is subject to rollout, so check whether cloud tasks are open to you before you plan around them. The plan includes a usage allowance rather than a fixed number of cloud tasks, and OpenAI says cloud tasks may use more of it than local messages do, with weekly limits possible as well.`,
        `With Hivra you are paying for a computer. ${ENTRY_PRICE_PROSE}. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} A Hivra account itself costs nothing, and it works with a server you connect yourself. ${AI_USAGE} For Codex that means you can sign in with ChatGPT or an OpenAI API key inside the CLI and let OpenAI bill that usage, which keeps the two bills separate and easy to read.`,
        "That separation matters when you compare. A ChatGPT plan is a single price that covers the model allowance, the cloud task environment and the apps around it, so if you already pay for one, Codex cloud adds no new line to your bill. A Hivra computer is a second, smaller bill for somewhere persistent to run things, and the model usage comes from wherever you point Codex. Neither number tells you much until you know whether your work is a stream of short tasks or a long-running environment.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra fits when you want the Codex CLI to have a home. You launch Codex on a paid Hivra Cloud computer, open it from the dashboard, and use its terminal, files and git as you would on your own machine. ${STAYS_ON} Your repositories, installed packages, shell history and Codex sessions are where you left them.`,
        "It also fits work that does not look like one self-contained change. A long investigation, a dev server you leave running, a scratch environment you keep refining over several days, or a job that needs a tool installed once and used again are all natural on a computer you keep. You are not recreating the setup for each task.",
        "And it fits people who want the CLI itself, with their own configuration, on a machine they can open and inspect. Hivra gives you the computer and the agent's own interface. It does not add the OpenAI-side integrations (a ChatGPT sign-in does not become a Slack or Linear connection by living on a Hivra computer), so if those matter, the next section applies.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "Choose Codex cloud when the job is a well-defined task against a repository and you want to hand it off and review the result. OpenAI's pages describe exactly that flow: give Codex a task in the cloud, inspect the changed files and check results, ask for follow-ups, then commit or open a pull request. You can start from the web, mobile, the desktop app or the CLI, and `codex cloud` in the CLI lists cloud chats and applies results to your local repository. Hivra does not replace any of that.",
        "Choose it when you already pay for ChatGPT. The allowance is shared between local and cloud use, so the cloud adds capability to a bill you already have. Choose it when you want the integrations OpenAI's pages list, GitHub code review and Slack (its docs navigation also lists Linear). Choose it too when your team wants OpenAI's workspace controls. OpenAI says business data is not used for training by default and is encrypted in transit and at rest in Business, Enterprise and Edu workspaces. It describes a workspace conversation-retention setting and, for Enterprise and Edu workspaces, further controls such as Compliance Logs.",
        "Choose it when memory matters for the task. OpenAI lists a Plus cloud VM at 2 vCPU, 8 GiB of memory and 8 GiB of disk, and the higher plans at 4 vCPU, 16 GiB and 32 GiB, with larger and custom sizes for Enterprise. Hivra's entry computer has 2 vCPU and 4 GB of RAM, so a build or test run that needs more headroom may fit Codex cloud better than Hivra's entry size.",
        "Finally, choose it when the default isolation is what you want. OpenAI says a task runs in a VM-backed sandbox, does not inherit your local files, browser session or private network access, and blocks internet access during the agent phase unless you allow it. For a first look at what an agent does to an unfamiliar repository, a sandbox that starts clean is a feature.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and OpenAI Codex cloud compared",
          rows: [
            {
              criterion: "Price model",
              hivra: `${ENTRY_PRICE_PROSE}, flat, before AI usage`,
              alternative: "Included in ChatGPT plans: Plus $20 a month, Pro from $100 a month, Business $20 per user per month billed annually (2+ users) or $25 monthly. Free and Go: cloud tasks not stated on the pricing page",
            },
            {
              criterion: "What you get",
              hivra: "A computer of its own with a terminal, files, git and the Codex CLI",
              alternative: "Cloud tasks, each in its own workspace, with a reusable environment you configure",
            },
            {
              criterion: "What stays on",
              hivra: STAYS_ON,
              alternative: "A task keeps working while your computer sleeps. Its saved VM state is recoverable for up to seven days after you last start a turn or resume it",
            },
            {
              criterion: "Persistence",
              hivra: "Files, sessions and login stay on the computer. Hivra does not promise backups",
              alternative: "Saved files, uncommitted changes and installed tools continue within that window. OpenAI says saved state does not replace source control",
            },
            {
              criterion: "Supported agents",
              hivra: HIVRA_AGENTS_CELL,
              alternative: "Codex. OpenAI's pricing page names only OpenAI models",
            },
            {
              criterion: "Models and AI cost",
              hivra: "Not in the plan. Your own ChatGPT account or API key, or Hivra credits",
              alternative: "Included allowance shared by local and cloud use, with credits for more. API keys are billed separately and have no cloud features",
            },
            {
              criterion: "Access method",
              hivra: "Open the computer in the browser: terminal, files, git",
              alternative: "Web, mobile, desktop app, CLI, plus the IDE integrations on OpenAI's IDE page. OpenAI's pricing and cloud pages list GitHub code review and Slack, and its docs navigation lists Linear",
            },
            {
              criterion: "Setup effort",
              hivra: "Launch a computer, then sign in to Codex",
              alternative: "Connect GitHub or GitLab, pick or publish an environment with an install script if the task needs one",
            },
            {
              criterion: "Hardware",
              hivra: `2 vCPU and 4 GB of RAM on the entry size, 4 vCPU and 8 GB of RAM on the larger size. Disk is set per plan and listed on the pricing page`,
              alternative: "Plus: 2 vCPU, 8 GiB memory, 8 GiB disk (Edu Plus matches Plus). Pro, Business, Enterprise, Edu: 4 vCPU, 16 GiB, 32 GiB",
            },
            {
              criterion: "Internet access",
              hivra: "The computer has its own network access, as a computer does. An agent with network access and your keys carries the prompt injection and exfiltration risks OpenAI lists, so be careful what you give it on an untrusted repository",
              alternative: "Blocked by default during the agent phase. Per environment: off, or on with a domain allowlist and allowed HTTP methods",
            },
            {
              criterion: "Who maintains it",
              hivra: "Hivra runs the platform. You manage what is installed on your computer",
              alternative: "OpenAI runs the shared infrastructure. You maintain the environment definition",
            },
            {
              criterion: "Data and security",
              hivra: "Your work sits on a computer that is yours. Review secrets and permissions as you would anywhere",
              alternative: "OpenAI says business data is not used for training by default and is encrypted in transit and at rest in Business, Enterprise and Edu workspaces. It describes a workspace conversation-retention setting and, for Enterprise and Edu workspaces, further controls such as Compliance Logs",
            },
            {
              criterion: "Limits",
              hivra: "The size of the computer and your model account's limits",
              alternative: "Plus and Standard Business: five-hour and weekly limits, shown as local-message estimates. Pro: no five-hour limit currently. Cloud tasks may use more of the allowance. OpenAI does not state a task time limit on the pages read",
            },
            {
              criterion: "Exit and portability",
              hivra: "It is a computer with a terminal and git, so you can push repositories to a remote or copy files off with the tools it has",
              alternative: "Results come back as changes you commit or a pull request. Environments are defined in OpenAI's workspace",
            },
            {
              criterion: "Refund",
              hivra: REFUND_LINKED,
              alternative: "Check OpenAI's current terms; not stated on its Codex docs",
            },
            {
              criterion: "Best for",
              hivra: "A persistent environment for Codex and other agents",
              alternative: "Self-contained repository tasks, handed off and reviewed",
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
              lead: "Maya, a solo developer who already pays for ChatGPT Plus:",
              text: "She wants Codex to fix a bug in a repository while she is in a meeting. **Codex cloud wins.** The allowance is already hers, the task starts from her GitHub account, and she reviews a diff afterwards.",
            },
            {
              lead: "Dev, a backend engineer with a project that needs a database, a queue and a dev server running for days:",
              text: "He wants the agent to keep iterating against the live stack. **Hivra is the better fit.** Codex cloud can start services from an environment's start skill, but its tasks are bounded by the seven days of recoverable saved state and OpenAI states no task time limit, so for days of continuous iteration a kept computer suits him. The services stay up on a Hivra computer that is not paused for inactivity, and he is not rebuilding the environment for each task.",
            },
            {
              lead: "Priya, who leads a team of eight on ChatGPT Business:",
              text: "She needs the GitHub review and Slack integrations OpenAI lists, and encryption in transit and at rest for her team's data. **Codex cloud wins.** Those are OpenAI's features, and a computer running the CLI does not reproduce them.",
            },
            {
              lead: "Tomás, an AI power user who runs Codex and a second agent side by side:",
              text: "He wants both on one account with files he can open and inspect. **Hivra suits him.** Each runs on a computer of its own, and he can keep Codex on his own ChatGPT login.",
            },
            {
              lead: "Jo, an indie developer whose builds need more memory than a small machine offers:",
              text: `The project compiles a large codebase. **Codex cloud may win.** A Plus cloud VM has 8 GiB of memory against 4 GB on Hivra's entry computer, so Jo should try the build there first. Hivra's larger size, ${formatPlanSize("larger")}, matches a Plus cloud VM's memory.`,
            },
            {
              lead: "Sam, who wants Codex to work on a repository nightly and keep a scratch notes folder between runs:",
              text: "The notes and a cloned cache have to be there each evening. **Hivra is the better fit.** Files on the computer persist. OpenAI does not describe a way to schedule recurring cloud tasks on the pages read, and the notes folder would need to live in the repository or an environment's prepared filesystem, where saved task state is recoverable for a limited window and does not replace source control.",
            },
            {
              lead: "Lena, who is not sure which she needs:",
              text: "**Try both.** Use Codex cloud for the handed-off tasks it was built for, and a Hivra computer for the work that wants a home. The two do not conflict.",
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
              lead: "Pick one real task.",
              text: "Choose a bounded job on a repository you know, such as fixing a failing test or adding a small feature, so you can judge the result against your own expectations.",
            },
            {
              lead: "Run it on Codex cloud.",
              text: "Connect the repository through GitHub or GitLab, give Codex the task, and review the changed files. Note how much of the setup you had to describe in the environment, and what the task could and could not reach with internet access at its default.",
            },
            {
              lead: "Run the same task on a Hivra computer.",
              text: "Launch Codex on a paid Hivra Cloud computer, sign in with your ChatGPT account or API key, clone the repository, and give it the same task. Open the terminal and files to see what it did.",
            },
            {
              lead: "Leave it for a day, then come back.",
              text: "Reopen the Codex task and the Hivra computer. Check what state survived, what you had to rebuild and what the follow-up felt like on each.",
            },
            {
              lead: "Add up a month.",
              text: "Count the ChatGPT plan you would hold anyway, the computer if you keep one, and the model usage on each path. Enter your own figures in the [hosting cost calculator](/tools/ai-agent-hosting-cost-calculator).",
            },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On Codex cloud, OpenAI says a task's saved VM state is recoverable for up to seven days after you last start a turn or resume the task. An existing task continues with its saved files, including uncommitted changes and installed tools. OpenAI also says saved state does not replace source control, so commit or save what you need. Dependency caches are preserved when a repository is refreshed, and an environment you publish is reusable across tasks with its repositories, install script, environment variables and secrets. OpenAI does not say what happens to background processes beyond that window.",
        `On Hivra, the computer is the thing that persists. ${CLI_RUN_LIFETIME}`,
        "Those are different promises and both are reasonable. A task that lives for a week and ends in a pull request does not need a computer that lasts for months. A project that grows over months does. Hivra does not promise backups, so keep important work in git and treat the computer as you would any machine you rely on.",
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: {
    checked: PRODUCT_FACTS_CHECKED,
    intro: `OpenAI's figures on this page come from its own Codex and ChatGPT pages, as of ${AS_OF}. Plans, allowances and availability change, so check the source before you rely on them.`,
    notes: [
      "OpenAI's pricing page lists a promotional price for one of its models for a limited period. This page does not quote it. Sale prices come and go, so read the current page before you compare.",
      "The pricing page said that some features on the Free and Go cards depend on rollout, so cloud availability on those plans was not confirmed here. No price on the pages read needed a sign-in.",
      "GitHub code review and Slack come from OpenAI's pricing and cloud pages, and Linear appears only in its docs navigation. The Codex CLI page does not list them. IDE integrations come from the IDE page.",
      "Not stated on the pages read: a maximum run time for a cloud task, the sandbox technology, a fixed number of cloud tasks, refund and cancellation terms for ChatGPT plans, and which regions cloud tasks run in.",
    ],
    links: SOURCE_LINKS,
  },
  faqs: [
    {
      q: "Is OpenAI Codex cloud cheaper than Hivra?",
      a: `It depends on what you already pay for. As of ${AS_OF}, OpenAI lists Codex as included in its ChatGPT plans, including Plus at $20 a month, so if you already hold one, cloud tasks add no separate line to your bill. Hivra is ${ENTRY_PRICE_PROSE} and does not include AI usage, so a Hivra computer is an extra cost on top of whatever your model account costs. They buy different things: tasks in a managed sandbox, or a computer that stays on. If you already pay for ChatGPT and your work is handed-off repository tasks, Codex cloud costs nothing extra. If you need a persistent environment, Hivra is the extra line.`,
    },
    {
      q: "Can I use Codex cloud and Hivra together?",
      a: "Yes. Nothing about one stops the other. You can hand well-defined repository tasks to Codex cloud and keep a Hivra computer for work that needs a persistent environment, such as a dev server, a scratch folder or a long investigation. Hivra is not affiliated with or endorsed by OpenAI and runs the Codex CLI that OpenAI publishes.",
    },
    {
      q: "What is the difference between Codex cloud and the Codex CLI?",
      a: "Codex cloud runs a task in an OpenAI-managed virtual machine and returns changes for you to review. The Codex CLI is a command line tool you run on a computer you control. OpenAI says the CLI can also list cloud chats, send work to a cloud environment and apply results to a local repository. Hivra runs the CLI on a computer that stays on.",
    },
    {
      q: "Does my work survive on Codex cloud?",
      a: "OpenAI says a task's saved VM state is recoverable for up to seven days after you last start a turn or resume the task, including uncommitted changes and installed tools. It also says saved state does not replace source control. For anything you need to keep, commit it or open a pull request.",
    },
    {
      q: "Can Codex run 24/7 on Hivra?",
      a: "On a paid Hivra plan the computer stays on and keeps your files, sessions and login. A Codex run you start inside tmux in the computer's Terminal tab keeps going after you close the laptop. A paid Hivra Cloud computer is not paused for inactivity.",
    },
    {
      q: "Does Codex cloud have internet access?",
      a: "OpenAI says Codex blocks internet access during the agent phase by default, while setup scripts still run with internet access. Per environment you can turn it off, or turn it on with a domain allowlist and allowed HTTP methods. OpenAI lists risks of enabling it, including prompt injection and exfiltration.",
    },
    {
      q: "Do I need a ChatGPT subscription to run Codex on Hivra?",
      a: "No. Inside Codex on a Hivra computer you can sign in with ChatGPT, use your own OpenAI API key, or pay for usage with Hivra credits. The plan does not include AI usage. OpenAI's pricing page says an API key gives Codex in the CLI, SDK or IDE without cloud features such as GitHub code review and Slack.",
    },
    {
      q: "Which is better for a team?",
      a: "For a team that wants shared workspace controls, GitHub review and Slack or Linear integrations, OpenAI's Business and Enterprise plans describe those, and Codex cloud is the better fit. For a person or small group who want a persistent computer with their own tools and files, Hivra is the better fit. Hivra does not reproduce OpenAI's workspace features.",
    },
    {
      q: "What does Hivra's refund cover?",
      a: "Hivra has a 7-day money-back guarantee on card payments. OpenAI's refund and cancellation terms for ChatGPT plans were not stated on the pages read for this comparison, so check its current terms.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-claude-code-on-the-web", "vs-github-codespaces", "vs-cursor-cloud-agents"],
    agents: ["codex"],
    docs: ["codex"],
    pricing: true,
    extra: [{ label: "Blog: Codex cloud, or Codex on a computer that stays on?", href: "/blog/run-codex-24-7-in-the-cloud" }, { label: "Blog: Codex pricing by ChatGPT plan", href: "/blog/codex-pricing-by-chatgpt-plan" }],
  }),
};
