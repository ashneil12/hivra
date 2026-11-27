import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "what-is-aeon-agent",
  title: "What is Aeon? The agent that runs its tasks on your GitHub",
  metaTitle: "What is Aeon? The agent that runs on your GitHub Actions",
  metaDescription:
    "Aeon is an agent framework with a dashboard and scheduled tasks that run on your own GitHub Actions. How the split works and what you need to set it up.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-27",
  readingTimeMin: 6,
  author: "Hivra Team",
  tagline: "Set it once. Your GitHub does the running.",
  intro:
    "Most agents sit on a computer and work there. Aeon splits the job in two: a dashboard where you set things up, and scheduled tasks that run in your own GitHub account. That split changes what hosting it means, and what it costs.",
  shortAnswer:
    "Aeon is an autonomous agent framework built around scheduled tasks. Its dashboard runs on a small computer, and the tasks themselves run on your own GitHub Actions, using the GitHub credentials you connect. On Hivra, the dashboard lives on a Hivra Cloud computer that needs a paid plan. GitHub governs the task compute.",
  sections: [
    {
      heading: "What Aeon is",
      paragraphs: [
        "Aeon is an autonomous agent framework for work that should happen on a schedule: a daily briefing, a recurring repository check, a research update that arrives without you asking. You describe a task and when it runs, and it happens whether you are online or not.",
        "It is different from agents you open and talk to. You are not sitting in a chat while it works. You configure tasks in a dashboard, and the agent does them when the schedule fires. If you want a conversation, other agents fit better. If you want a routine that runs on its own, that is what Aeon is for.",
      ],
    },
    {
      heading: "Where the work actually runs",
      paragraphs: [
        "This is the part that surprises people. Aeon's dashboard runs on a small computer. Its tasks do not. They run as GitHub Actions workflows in a fork of Aeon inside your own GitHub account.",
        "That separation has practical effects. The dashboard is always there when you want to check in or change a task. The work itself does not compete for the CPU and memory of the computer hosting the dashboard. And the limits and pricing for task runs are GitHub's, not Hivra's: your GitHub account may incur its own Actions usage charges.",
        "Your agent needs computer access. It doesn't need your computer. Here the agent gets two homes: a hosted computer for its dashboard, and GitHub's runners for its tasks. Nothing runs on your laptop.",
      ],
    },
    {
      heading: "What Hivra hosts, and what it does not",
      paragraphs: [
        "Hivra hosts the dashboard. It sets up a small computer for it, puts it behind Hivra's authenticated gateway, and gives you a connection flow for your GitHub account and your Aeon fork. You come back to that dashboard to inspect and change tasks.",
        "Hivra does not take over your fork, and it does not turn your scheduled jobs into Hivra compute. They stay in GitHub, with your repository settings and your task credentials. Hivra cannot exempt them from GitHub's Actions limits or pricing.",
        "The dashboard computer is small, with a floor of 0.5 vCPU and 1 GB of RAM. On Hivra Cloud, the entry plan is " + ENTRY_PLAN_PRICE + " a month for " + ENTRY_PLAN_SIZE + ". You can use your own server if your account is eligible to connect it.",
      ],
    },
    {
      heading: "Connecting GitHub",
      paragraphs: [
        "After the dashboard is up, you connect a GitHub token. The current integration needs read and write access to Secrets, Actions, Contents and Workflows. Grant it the narrowest repository scope you can, rather than your whole account.",
        "The connection flow creates or syncs your fork, enables Actions and stores the task secrets as GitHub repository secrets. If the token does not have enough permission to write secrets, the connection stops and tells you what to change.",
        "Treat that token as a powerful credential. It can change workflows in your repository. If you stop using Aeon, revoke it and review the secrets stored in the fork.",
      ],
    },
    {
      heading: "Models and what to automate first",
      paragraphs: [
        "A task needs a model to think with. Aeon on Hivra can use Hivra credits, which reach models through Venice, or the model access you set up yourself. Either way, model usage is a separate cost from the dashboard computer and from GitHub's minutes.",
        "Start with a low-risk task you can read the output of: a research digest on a topic you follow, or a scheduled review of a repository you own. Check the first few runs before you widen what a task is allowed to touch. You stay responsible for what each task can access and change.",
        "For more on turning routines into agent work, see [AI agent automation examples](/blog/ai-agent-automation-examples). The [Aeon docs page](/docs/aeon) covers setup, and the [Aeon agent page](/agents/aeon) shows the launch options.",
      ],
    },
    {
      heading: "Aeon or an agent that stays open",
      paragraphs: [
        "Pick Aeon when the unit of work is a scheduled job and you are happy for GitHub to run it. Pick an agent such as [Agent Zero](/blog/what-is-agent-zero) when the unit of work is a goal you hand over and watch. Aeon's tasks run on a schedule you set, and they only do what the credentials and tools you connect allow.",
        "Hivra is an independent hosting service and is not affiliated with or endorsed by the Aeon project.",
      ],
    },
  ],
  faqs: [
    {
      q: "Does Aeon run its tasks on my Hivra computer?",
      a: "No. The dashboard lives on a Hivra computer, but Aeon's scheduled tasks run on your own GitHub Actions. That is the main difference from the other agents.",
    },
    {
      q: "What GitHub permissions does it need?",
      a: "A token with read and write access to Secrets, Actions, Contents and Workflows. Scope it to the repository where possible, and revoke it if you stop using Aeon.",
    },
    {
      q: "What does Aeon cost to host?",
      a: "If you host the dashboard on a paid Hivra Cloud plan, that bill covers the computer. GitHub Actions usage and model usage are separate.",
    },
    {
      q: "Will tasks keep running when I close my laptop?",
      a: "Yes, as long as your GitHub Actions setup is active and the tasks are configured correctly. They do not depend on an open browser.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-automation-examples", title: "AI agent automation examples" },
    { slug: "what-is-an-ai-agent", title: "What is an AI agent?" },
    { slug: "run-ai-agents-24-7", title: "Run AI agents 24/7" },
    { slug: "cost-of-running-ai-agent", title: "What it costs to run an AI agent" },
  ],
};
