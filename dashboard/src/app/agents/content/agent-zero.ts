// /agents/agent-zero. Wording from Ash's batch 02 file 03-agent-zero.md, with the edits listed in the lane
// ledger. Facts: every computer Hivra Cloud runs is paid (no per-agent paid size), minimum 1 vCPU and 2 GB (floor), its own browser
// and computer inside the container, dashboard reached through the authenticated gateway, model access through
// its own Settings or Hivra credits (lib/launch/model-access.ts).

import { fill } from "./shared";
import type { AgentPageContent } from "./types";

export const AGENT_ZERO_CONTENT: AgentPageContent = {
  slug: "agent-zero",
  h1: "Give Agent Zero a computer of its own.",
  lead: [
    "Agent Zero is made for broad tasks, not just answering questions. Give it a goal and it can plan the next steps, use tools, browse the web and run code inside its working environment.",
    "That makes the computer it's running on particularly important. Hivra deploys the open-source Agent Zero stack on a separate managed VM, with its dashboard accessible through an authenticated gateway.",
  ],
  heroLinks: [
    { label: "Deploy Agent Zero", target: "deploy" },
    { label: "See pricing", target: "pricing" },
  ],
  sections: [
    {
      heading: "An agent that can actually use its environment",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Some assistants tell you what commands to run. Agent Zero can work through tasks using the tools available to its environment. Depending on the goal and model you connect, it might research information, create files, execute code or use its browser to interact with a website.",
            "This flexibility is useful, but it also means you should think carefully about permissions. A general-purpose agent that can run code needs boundaries. Running it on a dedicated VM keeps that work separate from your personal laptop; it does not make every action safe or guarantee that the agent will interpret instructions correctly.",
            "Hivra runs Agent Zero in its own container on the VM, including the browser and computer tools supplied by the project. You use Agent Zero's native dashboard to assign work and review what happens.",
          ],
        },
      ],
    },
    {
      heading: "What comes with the deployment?",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "The real Agent Zero project.",
              text: "Hivra hosts the open-source stack rather than presenting an unrelated chatbot under the same name.",
            },
            {
              term: "Its own dashboard and browser.",
              text: "The project's tools run on the agent computer. You can inspect and interact with them through the dashboard.",
            },
            {
              term: "A protected route to the interface.",
              text: "Hivra places the dashboard behind an authenticated gateway, with login details created during provisioning.",
            },
            {
              term: "Your choice of supported models.",
              text: "Configure your own model provider in Agent Zero's Settings, or pay with Hivra credits where they are available. Model charges depend on that choice.",
            },
            {
              term: "An always-available paid computer.",
              text: "Paid Hivra deployments aren't paused for inactivity, so the environment remains available after you close the page.",
            },
          ],
        },
      ],
    },
    {
      heading: "Getting started",
      blocks: [
        {
          kind: "steps",
          steps: [
            {
              title: "Choose Agent Zero and a plan",
              paragraphs: [
                fill(
                  "{paidNote} Agent Zero's minimum footprint is {agentZeroMinimum}, which leaves room on the entry plan for ordinary operation. Workload needs can grow with browser use and heavier tasks.",
                ),
              ],
            },
            {
              title: "Let Hivra build the computer",
              paragraphs: [
                "Hivra provisions the VM and launches Agent Zero in its container. You don't need to prepare a separate VPS, install Docker yourself or expose a dashboard to the public internet.",
              ],
            },
            {
              title: "Set up model access",
              paragraphs: [
                "Open the authenticated dashboard and select a model provider in Settings. Do this before giving the agent a job. Any key or login stored inside the computer should be limited to the permissions the agent actually needs.",
              ],
            },
            {
              title: "Give it a contained first task",
              paragraphs: [
                "Start with something you can review: analyse a folder, research a topic or produce a small piece of code. Watch the steps it takes, inspect the result and only then consider giving it access to more important services.",
              ],
            },
          ],
        },
      ],
    },
    {
      heading: "Hosting it yourself versus using Hivra",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Agent Zero is open source. If you're comfortable running Docker on your own VPS, you can host the same software yourself, control its updates and decide exactly how its network access works.",
            "Hivra removes much of that setup and maintenance work. We bring up the VM, protect access to the dashboard and manage the service lifecycle. You still configure the model, choose the tools it can access and remain responsible for the work you ask it to do.",
            "The point isn't that self-hosting is wrong. It's that running and securing another server is often not the part of the project you want to spend time on.",
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Does Agent Zero need a paid plan?",
      a: fill(
        "Yes, on Hivra Cloud, as for every agent. {paidNote} The larger size is {larger}. {aiNote}",
      ),
    },
    {
      q: "Is this Agent Zero's official hosting service?",
      a: "No. Hivra is an independent host. We deploy the open-source Agent Zero project and are not affiliated with or endorsed by its maintainers.",
    },
    {
      q: "Does it include a browser?",
      a: "Yes. Agent Zero comes with its own browser and computer tools inside its container. You can observe them through the project dashboard.",
    },
    {
      q: "What happens when I close my laptop?",
      a: "The VM remains available and a task already running in Agent Zero's persistent process can continue. Actual task completion still depends on the agent, its model, tools and any timeouts or errors.",
    },
    {
      q: "Can I use my own AI provider?",
      a: "Yes. Configure a supported provider through Agent Zero's Settings. Where offered, you can instead pay with Hivra credits. Check the provider's costs and usage limits separately from Hivra hosting.",
    },
    {
      q: "What about security?",
      a: "The VM separates Agent Zero's environment from your own computer and its dashboard is reached through an authenticated gateway. That does not remove the risks of agent mistakes, malicious web content or overprivileged credentials. Hivra administrators also have infrastructure access to managed hosts. Use tightly scoped accounts and inspect sensitive actions.",
    },
  ],
  closing: {
    heading: "Give the agent room to work, without giving it your whole machine.",
    links: [
      { label: "Deploy Agent Zero", target: "deploy" },
      { label: "See pricing", target: "pricing" },
      { label: "Compare agents", target: "agents" },
    ],
  },
  affiliation: "Hivra is independent and is not affiliated with or endorsed by the Agent Zero project.",
  related: {
    heading: "Related",
    slugs: ["openclaw", "hermes", "claude-code", "codex", "aeon"],
  },
};
