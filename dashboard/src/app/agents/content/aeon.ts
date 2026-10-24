// /agents/aeon. Wording from Ash's batch 02 file 02-aeon.md, with the edits listed in the lane ledger.
// Facts: the dashboard runs on a small pool-exempt computer (agent-catalog poolExempt); the tasks run on the
// owner's GitHub Actions; the GitHub token needs read and write on Secrets, Actions, Contents and Workflows,
// and the connect stops with that message when it cannot write secrets (provisioner/hivra-chat/server.js).

import { fill } from "./shared";
import type { AgentPageContent } from "./types";

export const AEON_CONTENT: AgentPageContent = {
  slug: "aeon",
  h1: "Give Aeon a schedule. Let your GitHub do the work.",
  lead: [
    "Some tasks shouldn't need you to remember to start them. A daily briefing, a regular repository check or a research update should happen when it's supposed to, whether you're online or not.",
    "That's what Aeon is built for. Hivra hosts its dashboard; **your own GitHub Actions** execute the scheduled work.",
  ],
  heroLinks: [
    { label: "Deploy Aeon", target: "deploy" },
    { label: "See pricing", target: "pricing" },
  ],
  sections: [
    {
      heading: "A different kind of hosted agent",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Aeon isn't a large process sitting on your cloud computer all day waiting to do something. The dashboard lives on a small managed Hivra computer, while the jobs themselves run in a fork of Aeon inside your GitHub account.",
            "You connect GitHub after deployment, configure your tasks, and let Actions pick them up on schedule. That separation has two advantages. First, the dashboard is there when you need to check in. Second, the actual workloads don't compete with the CPU and RAM allocated to your other Hivra agents.",
            "It also means there's an important distinction in billing: **Hivra hosts the dashboard; GitHub governs the compute minutes and limits for the tasks.** Your GitHub account may incur separate Actions usage charges.",
          ],
        },
      ],
    },
    {
      heading: "What can you use it for?",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "Research digests:",
              text: "Keep track of a topic and receive a regular update instead of running the same request manually every morning.",
            },
            {
              term: "Repository housekeeping:",
              text: "Schedule reviews or checks against your own codebases. The permissions and results are controlled through your repository configuration.",
            },
            {
              term: "Recurring scans:",
              text: "Have Aeon run repeat security or market-monitoring workflows, provided the tools, credentials and data sources you connect allow them.",
            },
          ],
        },
        {
          kind: "prose",
          paragraphs: [
            "Aeon handles the scheduled execution. You remain responsible for deciding what a task can access and what it is allowed to change.",
          ],
        },
      ],
    },
    {
      heading: "What Hivra sets up",
      blocks: [
        {
          kind: "list",
          items: [
            "A managed computer for Aeon's dashboard, protected by an authenticated gateway.",
            "A connection flow for your GitHub account and Aeon fork.",
            "A persistent place to return to, inspect and change tasks.",
            "A small dashboard computer that counts as one of your agents but uses none of your plan's shared CPU and RAM.",
          ],
        },
        {
          kind: "prose",
          paragraphs: [
            "You still use your own GitHub account and task credentials. Hivra cannot exempt those jobs from GitHub's Actions limits or pricing.",
          ],
        },
      ],
    },
    {
      heading: "Get Aeon running",
      blocks: [
        {
          kind: "steps",
          steps: [
            {
              title: "Launch the dashboard",
              paragraphs: [
                fill(
                  "Create your Hivra account, select Aeon, choose the hosting plan and name the deployment. {paidNote} Hivra provisions the small dashboard computer and protects it behind a login.",
                ),
              ],
            },
            {
              title: "Connect GitHub",
              paragraphs: [
                "On the computer, enter a GitHub token with the permissions needed for your Aeon fork. The current integration requires read-and-write access to **Secrets, Actions, Contents and Workflows**. Grant access to the narrowest appropriate repository scope rather than your entire account where possible.",
                "Hivra's connection flow creates or synchronises your fork, enables Actions and stores the task secrets as GitHub repository secrets. If the token's permissions are insufficient, the connection stops and tells you what needs changing.",
              ],
            },
            {
              title: "Create a task",
              paragraphs: [
                "Open Aeon's dashboard and decide what should run, when it should run and which credentials it needs. Start with a low-risk job so you can inspect the output before expanding its permissions.",
              ],
            },
            {
              title: "Leave it to its schedule",
              paragraphs: [
                "Close your laptop. The dashboard remains hosted on Hivra and the scheduled job executes in GitHub Actions when triggered. You can return to the dashboard to adjust it later.",
              ],
            },
          ],
        },
      ],
    },
    {
      heading: "Why not host it yourself?",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "You can. Aeon's dashboard can be run on a server you manage. Doing that gives you control over the host, but you also maintain the server, secure the web interface and manage uptime and updates.",
            "Hivra handles the dashboard hosting and access layer. It does **not** take over ownership of your GitHub fork or convert the scheduled jobs into Hivra-hosted compute. The execution model remains the same either way.",
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Does Aeon run tasks on my Hivra VM?",
      a: "No. The dashboard lives on Hivra, but Aeon's scheduled workloads run through your own GitHub Actions. That's the main difference between Aeon and the other agents here.",
    },
    {
      q: "Do I need a GitHub token?",
      a: "Yes. Connect a token after launch. It needs the appropriate repository permissions to manage the fork, Actions, workflows and secrets. Treat the token as a powerful credential. If you no longer use it, revoke it and review any stored task secrets.",
    },
    {
      q: "Will tasks continue when I log off?",
      a: "Yes, as long as your GitHub Actions setup is active and the jobs are configured correctly. They don't depend on your browser remaining open.",
    },
    {
      q: "What does it cost?",
      a: fill(
        "{paidNote} The dashboard uses very little compute, but the associated GitHub Actions minutes and any third-party services are governed by their own providers' billing. {aiNote}",
      ),
    },
    {
      q: "Can I use my existing Aeon fork?",
      a: "The current connection flow is designed to create a fork or synchronise one you already have. Check the fork and permissions during setup before authorising changes.",
    },
    {
      q: "Can Hivra see my credentials?",
      a: "Credentials may be stored on your Hivra-managed computer or as secrets in your GitHub repository. Although the dashboard is protected by an authenticated gateway, Hivra administrators retain infrastructure access to managed hosts. Use the minimum permissions needed.",
    },
  ],
  closing: {
    heading: "Set the routine once. Get on with your day.",
    links: [
      { label: "Deploy Aeon", target: "deploy" },
      { label: "See plans", target: "pricing" },
      { label: "Explore other agents", target: "agents" },
    ],
  },
  affiliation: "Hivra independently hosts Aeon and is not affiliated with or endorsed by the Aeon project.",
  related: {
    heading: "More to explore",
    slugs: ["claude-code", "codex", "hermes", "openclaw", "agent-zero"],
  },
};
