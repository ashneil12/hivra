import type { ComparePage } from "../types";
import { formatCheckedMonth } from "../competitor-facts";
import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT, MONEY_BACK_GUARANTEE, formatPlanSize } from "@/lib/blog/plan-facts";
import {
  AI_ACCESS_CELL,
  AI_USAGE,
  CLOSING,
  ENTRY_PRICE_PROSE,
  HIVRA_AGENTS_CELL,
  REFUND_LINKED,
  STAYS_ON,
  cautionSection,
  paragraphs,
  relatedLinks,
} from "../shared-copy";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { PRODUCT_FACTS_CHECKED } from "./checked";

/**
 * Hivra against GitHub Codespaces. Every GitHub figure below comes from GitHub's own documentation and product
 * pages (listed under the page's sources) as of PRODUCT_FACTS_CHECKED. Where GitHub's pages do not state
 * something (refund terms, an always-on option, the region list, an uptime SLA, Codespaces-specific pages on
 * running Claude Code or Codex) the copy says "its pages do not state" instead of guessing. The honest framing:
 * a codespace is a developer environment that stops when idle, and a paid Hivra computer stays on.
 */

const MONTH = formatCheckedMonth(PRODUCT_FACTS_CHECKED);

export const page: ComparePage = {
  slug: "vs-github-codespaces",
  browserTitle: "GitHub Codespaces vs Hivra: a workspace or a computer? | Hivra",
  h1: "GitHub Codespaces vs Hivra: a workspace or a computer?",
  metaDescription: `Codespaces stops when idle; Hivra is ${ENTRY_PRICE_PROSE} and stays on. When each fits. Prices as of ${MONTH}.`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "GitHub Codespaces and Hivra both give you a Linux machine in the cloud that you reach from a browser, so they look alike for the first ten seconds. They are built for different jobs. A codespace is a developer environment for a repository: you open it, work in it, and it stops when you stop. Hivra gives an AI agent a computer of its own, one that stays on, so you open it when you want to look and it carries on when you do not.",
        "That makes this less a contest than a question about who is doing the work. If you are the one typing, and you want a fast, disposable, repo-shaped place to do it with your editor of choice, a codespace is built for exactly that. If an agent is doing the work, and the work should continue while your laptop is shut, the useful thing is a machine that does not go to sleep.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: [
        ...paragraphs(
          `With Codespaces you pay for the hours a codespace is running, plus the disk it occupies while it exists. GitHub's billing documentation lists compute per hour by machine size, shown with a dollar sign and no currency named: $0.18 for 2 cores, $0.36 for 4, $0.72 for 8, $1.44 for 16 and $2.88 for 32. Storage is $0.07 per GB-month. Usage is reported hourly and billed monthly, and a stopped codespace costs storage only. As of ${MONTH}, GitHub's pages show that pricing without a sale or promotional label.`,
          "Personal accounts get some usage included. GitHub's billing page lists 120 core hours and 15 GB-month of storage for a GitHub Free account, and 180 core hours and 20 GB-month for GitHub Pro. On a 2-core codespace, 120 core hours is 60 hours of run time, which is how the product page states it. Its pages say organization and enterprise plans do not include a free quota, and that open source maintainers get generous monthly usage without giving a figure. Students get Codespaces through the GitHub Student Developer Pack.",
          "A worked example, our arithmetic from those list prices: 100 hours on a 2-core codespace is $18.00 before any included usage, and the 32 GB of storage on the smallest size is $2.24 a month at list price before any included storage; a GitHub Free account includes 15 GB-month, which would leave 17 GB, or $1.19. After the included 120 core hours, those 100 hours would use 200 core hours, leaving 80 billable core hours, or $7.20. For a person who opens a codespace a few days a week, that is a small bill.",
          "The picture changes when you want the machine to stay up. A codespace stops after at most 12 hours and has to be restarted to continue, and GitHub's pages do not describe an always-on option, so a 730-hour month ($131.40 at the 2-core list price, our arithmetic) is not a like-for-like comparison with a machine that simply stays on.",
          `Hivra is ${ENTRY_PRICE_PROSE}, and that price covers the computer around the clock, not the hours you were looking at it. The plan does not include AI usage. A Hivra account costs nothing. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
        ),
      ],
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `${STAYS_ON} That is the one difference the rest of this page keeps coming back to. A codespace times out after 30 minutes of inactivity by default, you can set that anywhere from 5 to 240 minutes, and an organization owner can set a maximum idle timeout for its repositories that overrides a longer personal setting. Typing, mouse use and terminal input or output reset the timer. GitHub says a shared port with no terminal output and no other interaction does not. When the codespace stops, its running processes end.`,
        "Hivra's computer is where the agent lives. Hivra hosts Hermes, OpenClaw, Agent Zero, Claude Code and Codex, and hosts the dashboard for Aeon, whose scheduled tasks run on your own GitHub Actions. You open the computer in the browser to see chat, a terminal and files, and the agent's files, repositories and logins stay put between visits.",
        "Hivra runs the official Claude Code and Codex command line tools, which you sign in to with your own account, or it can use Hivra credits where the agent supports it. Hivra is independent. It is not affiliated with, sponsored by or endorsed by GitHub, Microsoft, Anthropic or OpenAI.",
        "There is also an overlap worth naming. GitHub's Copilot documentation describes third-party coding agents, Anthropic's Claude and OpenAI's Codex, in public preview on paid Copilot plans, using Actions minutes and AI credits. That page does not say they run inside a codespace, and GitHub's Codespaces pages do not describe running Claude Code or Codex in a terminal there. You can install a command line tool in a codespace like any other tool, but the pages do not promise that it keeps working after you leave.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: [
        ...paragraphs(
          "Choose Codespaces when the work is yours and the repository is the unit of work. It is better than Hivra at that job, and plainly so.",
        ),
        {
          kind: "entries",
          items: [
            {
              lead: "A repository-shaped environment:",
              text: "a codespace is built from the repository's own dev container configuration, so everyone who opens it gets the same tools. Hivra's computers are set up around an agent, not a repository.",
            },
            {
              lead: "Your editor, in the browser or locally:",
              text: "GitHub lists the browser, Visual Studio Code and the GitHub CLI, and its product page adds JetBrains IDEs and JupyterLab in beta. Hivra's view is a browser one with chat, a terminal and files.",
            },
            {
              lead: "Prebuilds and team control:",
              text: "prebuilds store a ready codespace per repository, branch and configuration so new ones start faster, and organizations on Team and Enterprise plans can pay for members' codespaces with spending controls. This page does not describe team billing or fleets of developer workspaces on the Hivra side.",
            },
            {
              lead: "Bigger machines and more RAM at the bottom:",
              text: "GitHub states sizes from 2 cores with 8 GB of RAM up to 32 cores with 128 GB. Its smallest size has more memory than Hivra's entry computer.",
            },
            {
              lead: "Cost for occasional use:",
              text: "if you open a codespace for a few hours a week, paying per hour with some usage included will usually cost less than a monthly computer you do not need.",
            },
            {
              lead: "Account-level assurances:",
              text: "each codespace has its own virtual machine and virtual network, inbound connections from the internet are blocked, and the connection is a TLS tunnel authenticated with GitHub. If your team already works inside GitHub's controls, that is a real advantage.",
            },
          ],
        },
      ],
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and GitHub Codespaces compared",
          rows: [
            {
              criterion: "Price model",
              hivra: "A fixed monthly price for the computer",
              alternative: "Per hour while running, plus storage per GB-month while it exists",
            },
            {
              criterion: "Entry price",
              hivra: formatPlanSize("entry", "compact"),
              alternative: "$0.18 an hour for 2 cores; 2 cores, 8 GB RAM and 32 GB storage is the smallest size",
            },
            {
              criterion: "What you get",
              hivra: "A computer of its own for an agent, opened in the browser",
              alternative: "A development environment for a repository, in a container on a cloud VM",
            },
            {
              criterion: "What stays on",
              hivra: "A paid computer is not paused for inactivity",
              alternative: "Stops after an idle timeout of 30 minutes by default (5 to 240); 12-hour maximum lifetime",
            },
            {
              criterion: "Persistence",
              hivra: "Files, repositories, logins and CLI session history stay on the computer",
              alternative: "Saved changes remain on restart; running processes end; deleted after 30 days stopped by default",
            },
            {
              criterion: "Supported agents",
              hivra: HIVRA_AGENTS_CELL,
              alternative: "Its pages do not describe running Claude Code or Codex in a codespace; GitHub's separate Copilot agents run on GitHub Actions",
            },
            {
              criterion: "Models and AI cost",
              hivra: AI_ACCESS_CELL,
              alternative: "Compute is billed on its own; its pages do not state any AI usage for a codespace",
            },
            {
              criterion: "Access method",
              hivra: "Browser view with chat, terminal and files",
              alternative: "Browser, Visual Studio Code, GitHub CLI; JetBrains and JupyterLab in beta",
            },
            {
              criterion: "Setup effort",
              hivra: "Pick an agent and launch it from the dashboard",
              alternative: "Add a dev container to the repository; prebuilds are optional",
            },
            {
              criterion: "Who maintains it",
              hivra: "Hivra runs the computer",
              alternative: "GitHub runs the VMs; you or your team maintain the dev container",
            },
            {
              criterion: "Data and security",
              hivra: "Files sit on a computer of your own",
              alternative: "VM and virtual network per codespace; inbound internet blocked; ports private by default",
            },
            {
              criterion: "Limits",
              hivra: "The size of the plan you pay for",
              alternative: "Included quota, budgets, 12-hour lifetime; terms rule out production-facing applications",
            },
            {
              criterion: "Refund",
              hivra: REFUND_LINKED,
              alternative: "Its pages do not state refund terms for Codespaces",
            },
            {
              criterion: "Exit and portability",
              hivra: "Your files are on the computer; copy out what you need",
              alternative: "Push or export changes to a branch; not self-hostable",
            },
            {
              criterion: "Best for",
              hivra: "An agent that should keep working while you are away",
              alternative: "A person developing in a repository, in short sessions",
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
              lead: "Maya, an open source maintainer:",
              text: "she reviews pull requests across projects that each need a different toolchain. Pick Codespaces. A fresh, repository-defined environment per pull request is the thing it is built for, and her usage is occasional.",
            },
            {
              lead: "Tomas, a developer who wants Claude Code to work through a long refactor while he is offline:",
              text: "the run should continue when he closes his laptop. Pick Hivra. Start the run inside tmux in the computer's Terminal tab, because a paid computer stays on. A codespace's 12-hour maximum lifetime and its idle timeout work against that. If he already pays for Copilot, GitHub's agents run on its side without a machine of his own; they use Actions minutes and AI credits.",
            },
            {
              lead: "Priya, a team lead onboarding contractors to a large monorepo:",
              text: "she wants everyone on identical tools, billed to the organization with a spending limit. Pick Codespaces, with prebuilds. Codespaces is the documented fit for that; this page does not describe per-repository environments or organization billing on the Hivra side.",
            },
            {
              lead: "Sam, who wants a Hermes agent checking sources and running scheduled tasks every day:",
              text: "nobody is sitting at it. Pick Hivra. A scheduled agent needs a machine that is there when the schedule fires, and a codespace stops after an idle timeout and 12 hours at most, so a daily schedule needs something else. GitHub's Copilot agents are a separate option on paid Copilot plans: they run on GitHub's side, using Actions minutes and AI credits.",
            },
            {
              lead: "Lena, a student with the GitHub Student Developer Pack:",
              text: "she writes code for coursework a few hours at a time. Pick Codespaces. GitHub says students get it through the pack, and a development environment is what she needs.",
            },
            {
              lead: "Jo, who builds in a repository by day and has an agent triaging issues at night:",
              text: "use both. Develop in a codespace, keep the agent on a Hivra computer, and let the two meet in Git. Each does the part it is shaped for.",
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
              lead: "Pick one real repository and one real task.",
              text: "Choose something that runs for a while, such as a refactor or a test suite you would normally leave going. A toy task will not show the difference.",
            },
            {
              lead: "Run it in a codespace.",
              text: "Open a codespace on the repository, note the idle timeout in your preferences, and start the task. Check the usage figures on your GitHub billing page afterwards, since GitHub emails alerts at 90% and 100% of included usage.",
            },
            {
              lead: "Run it on a Hivra computer.",
              text: `Launch an agent on a paid computer (${ENTRY_PRICE_PROSE}), sign in to the agent with your own account, clone the repository and start the same task inside tmux in the Terminal tab. ${AI_USAGE}`,
            },
            {
              lead: "Walk away.",
              text: "Close the laptop for the night. Do not touch either one.",
            },
            {
              lead: "Compare the morning.",
              text: "Look at what is still running, what is saved and what you would have to start again. Then add up a month of compute and storage on one side and the monthly price on the other, plus model usage on both.",
            },
          ],
        },
        ...paragraphs(
          `If you decide Hivra is not the right fit, there is a ${MONEY_BACK_GUARANTEE}; see the terms for how it works.`,
        ),
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "In Codespaces, the answer depends on whether the codespace is running or stopped. GitHub says stopping or timing out ends running processes, and that saved changes remain when you restart it. Visible terminal contents are not preserved between sessions. Closing the browser tab does not stop a codespace: it keeps running until it is stopped or times out. GitHub also says every time you restart a codespace it is deployed to a new VM.",
        "Stopped codespaces are deleted automatically after 30 days of inactivity by default. You can set the retention period anywhere from 0 to 30 days, and at 0 a codespace is deleted as soon as it stops or times out. GitHub's documentation says automatic deletion happens whether or not a codespace holds unpushed changes, so push anything you care about. If you run out of included usage and have no payment method, you cannot create or resume billable codespaces, though you can export your changes to a new branch.",
        `On Hivra's side, the computer is the persistent thing. ${CLI_RUN_LIFETIME} Files, repositories, logins and CLI session history stay on the computer whether or not a browser tab is open. Hivra does not promise backups, so copy out anything you cannot afford to lose, as you would on any machine.`,
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: {
    checked: PRODUCT_FACTS_CHECKED,
    intro: `GitHub's figures on this page come from the pages below, as of ${MONTH}. GitHub changes quotas and prices, so check them before you pay.`,
    notes: [
      "GitHub's billing page shows prices with a dollar sign and does not name the currency. Per-hour prices and the included quota are on its billing documentation page; the product page states the free monthly usage in hours.",
      "The product page lists JetBrains IDE and JupyterLab support in beta, and a sample machine list that differs from the sizes in the documentation, so this page uses the documentation's sizes.",
      "Third-party coding agents in Copilot are a public preview on paid Copilot plans and are a separate product from Codespaces.",
      "GitHub's pages do not state refund or cancellation terms for Codespaces, a list of regions, an uptime commitment, an always-on option, or the included usage on Team and Enterprise plans (its billing page says there is none).",
    ],
    links: [
      { label: "GitHub: Codespaces billing", href: "https://docs.github.com/en/billing/concepts/product-billing/github-codespaces" },
      { label: "GitHub: Codespaces product page", href: "https://github.com/features/codespaces" },
      { label: "GitHub: idle timeout", href: "https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces" },
      { label: "GitHub: automatic deletion", href: "https://docs.github.com/en/codespaces/setting-your-user-preferences/configuring-automatic-deletion-of-your-codespaces" },
      { label: "GitHub: codespace lifecycle", href: "https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle" },
      { label: "GitHub: what are codespaces", href: "https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces" },
      { label: "GitHub: prebuilds", href: "https://docs.github.com/en/codespaces/prebuilding-your-codespaces/about-github-codespaces-prebuilds" },
      { label: "GitHub: security in Codespaces", href: "https://docs.github.com/en/codespaces/reference/security-in-github-codespaces" },
      { label: "GitHub: Codespaces with the GitHub CLI", href: "https://docs.github.com/en/codespaces/developing-in-a-codespace/using-github-codespaces-with-github-cli" },
      { label: "GitHub: restricting the idle timeout", href: "https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/restricting-the-idle-timeout-period" },
      { label: "GitHub: third-party coding agents", href: "https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents" },
      { label: "GitHub: additional product terms", href: "https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features" },
    ],
  },
  faqs: [
    {
      q: "How much does GitHub Codespaces cost compared with Hivra?",
      a: `GitHub lists compute from $0.18 an hour for a 2-core codespace, plus $0.07 per GB-month of storage, with some usage included on personal accounts, as of ${MONTH}. Hivra is ${ENTRY_PRICE_PROSE}. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} A Hivra account itself costs nothing. For occasional use Codespaces is usually cheaper. For a machine that has to stay on, the two are not comparable, because a codespace has a 12-hour maximum lifetime.`,
    },
    {
      q: "Is GitHub Codespaces free?",
      a: "Partly. GitHub's billing page lists 120 core hours and 15 GB-month of storage each month for a GitHub Free personal account, and 180 core hours and 20 GB-month for GitHub Pro. On a 2-core codespace, 120 core hours is 60 hours of run time. Its pages say organization and enterprise plans do not include a free quota, and that students can use it through the GitHub Student Developer Pack. Usage beyond the quota is blocked without a valid payment method.",
    },
    {
      q: "Can I use GitHub Codespaces and Hivra together?",
      a: "Yes. They do different jobs. You can develop in a codespace and keep an agent on a Hivra computer, with Git as the place the two meet. Give the agent access to the repository, have it push a branch, and review it from wherever you are working.",
    },
    {
      q: "Can I keep a codespace running 24/7?",
      a: "Its pages do not describe an always-on option. GitHub says a codespace has a maximum lifetime of 12 hours regardless of your idle timeout settings, and that stopping or timing out ends running processes. The idle timeout defaults to 30 minutes and can be set from 5 to 240 minutes. On Hivra, a paid computer stays on and is not paused for inactivity.",
    },
    {
      q: "What happens to my files when a codespace stops?",
      a: "Saved changes remain when you restart it, running processes end, and visible terminal contents are not preserved between sessions. A stopped codespace is deleted after 30 days of inactivity by default, and GitHub says this happens even when it holds unpushed changes. Push your work to a branch. On Hivra, files, repositories, logins and CLI session history stay on the computer, and Hivra does not promise backups.",
    },
    {
      q: "Can I run Claude Code or Codex in a codespace?",
      a: "GitHub's Codespaces pages do not describe it, and its Copilot documentation lists third-party coding agents as a public preview on paid Copilot plans without saying they run in a codespace. You can install a command line tool in a container like any other tool, but a codespace stops when idle, and its pages do not state that a terminal session keeps it alive. On Hivra, Claude Code and Codex run as the official command line tools on a computer that stays on.",
    },
    {
      q: "Which is better for AI coding agents?",
      a: "For an agent that should keep working after you leave, a Hivra computer, because a paid one stays on. For a person writing code in a repository, Codespaces, because it builds a repository-defined environment and opens in your editor. The plan does not include AI usage on Hivra, so you bring your own account or key where the agent supports it, or pay with Hivra credits.",
    },
    {
      q: "Does Codespaces have a refund policy, and what does Hivra offer?",
      a: `GitHub's pages that we found do not state refund or cancellation terms for Codespaces, so check with GitHub. Hivra has a ${MONEY_BACK_GUARANTEE}.`,
    },
    {
      q: "Can I use a codespace to host a production application?",
      a: "GitHub's terms say Codespaces should not be used to host any production-facing application, as a CDN or as part of a serverless application, and that misuse may lead to termination of Codespaces access. Treat a codespace as a place to develop and test.",
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-claude-code-on-the-web", "vs-openai-codex-cloud", "vs-cursor-cloud-agents", "vs-self-hosted"],
    blog: ["managed-vs-self-hosted-ai-agents", "ai-agent-hosting-guide"],
    agents: ["claude-code"],
    docs: ["linux-computer"],
    pricing: true,
  }),
};
