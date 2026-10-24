// /agents/openclaw. Wording from Ash's batch 02 file 07-openclaw.md, with the edits listed in the lane ledger.
// Facts: every computer Hivra Cloud runs is paid (no per-agent paid size), minimum 1 vCPU and 2 GB, 2 and 4 with the optional browser
// (resizeFloor), Control UI behind the authenticated gateway, gateway service restarts on failure
// (provisioner/provision-claude-code-box.sh bux-openclaw.service), model through Venice credits or the Control UI.

import { fill } from "./shared";
import type { AgentPageContent } from "./types";

export const OPENCLAW_CONTENT: AgentPageContent = {
  slug: "openclaw",
  h1: "OpenClaw, on call even when you're not online.",
  lead: [
    "OpenClaw is the kind of agent you message rather than sit down at a terminal to use. Connect a supported channel, send it a request and come back to the conversation later. It can also run routines through its scheduler, without waiting for you to open an app.",
    fill(
      "For that to work properly, it needs a computer that stays on. Hivra runs the open-source OpenClaw gateway on a private managed VM, with its native Control UI protected behind an authenticated gateway. {staysOn}",
    ),
  ],
  heroLinks: [
    { label: "Deploy OpenClaw", target: "deploy" },
    { label: "See pricing", target: "pricing" },
  ],
  sections: [
    {
      heading: "Your agent doesn't need to live on your laptop",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "OpenClaw can act as a messaging-based personal assistant, coordinate tools and carry out scheduled routines. You configure its model provider and connect channels such as Telegram, WhatsApp or Signal through the project's own interface, where supported.",
            "On a local machine, the agent is only as available as the computer running it. Close the laptop, lose your home connection or shut down the host and the gateway goes away. Hivra moves that agent onto its own cloud computer, where a paid deployment remains available without your device being online.",
            "OpenClaw's native Control UI remains the centre of configuration. Hivra provides the hosting environment and access controls around it rather than replacing the underlying project with an unrelated chatbot.",
          ],
        },
      ],
    },
    {
      heading: "What OpenClaw is particularly good at",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "Messaging from wherever you are.",
              text: "Work with the agent through connected messaging channels instead of needing to visit a dashboard for every interaction.",
            },
            {
              term: "Routines that keep their schedule.",
              text: "Use the project's heartbeat or scheduler features to run repeat work while you're away. Check the configuration carefully before allowing an unattended routine to change external systems.",
            },
            {
              term: "A persistent workspace.",
              text: "Files and configuration stay with the cloud deployment between normal sessions.",
            },
            {
              term: "Browser work when you need it.",
              text: "Enable the optional live self-hosted browser and supervise logged-in sessions rather than putting personal browser profiles on the agent's machine.",
            },
          ],
        },
      ],
    },
    {
      heading: "What Hivra looks after",
      blocks: [
        {
          kind: "list",
          items: [
            "Provisioning the private VM and OpenClaw service.",
            "Hosting the native Control UI behind an authenticated gateway.",
            "Managing the service so that it can restart after a crash.",
            "Keeping paid computers available rather than pausing them for inactivity.",
            "Making the deployment manageable through your Hivra account.",
          ],
        },
        {
          kind: "prose",
          paragraphs: [
            "You still connect the model provider, messaging accounts and external services. Their subscription fees, API charges, limits and policies remain separate.",
          ],
        },
      ],
    },
    {
      heading: "From first deployment to first message",
      blocks: [
        {
          kind: "steps",
          steps: [
            {
              title: "Pick a plan",
              paragraphs: [
                fill(
                  "{paidNote} OpenClaw needs a minimum of {openclawMinimum} without the optional browser; enabling the browser increases its allocation to {openclawWithBrowser}.",
                ),
              ],
            },
            {
              title: "Open the Control UI",
              paragraphs: [
                "Once Hivra has provisioned the VM, open OpenClaw's native interface through the authenticated gateway. Configure the model you want it to use.",
              ],
            },
            {
              title: "Connect your channel",
              paragraphs: [
                "Follow OpenClaw's setup process for Telegram, WhatsApp, Signal or another supported channel. You'll need to authorise the relevant accounts and decide which conversations or actions the agent can access.",
              ],
            },
            {
              title: "Configure a small routine",
              paragraphs: [
                "Start with something easy to observe, such as a regular reminder or low-risk briefing. Check that the scheduler fires as expected, then expand from there.",
              ],
            },
          ],
        },
      ],
    },
    {
      heading: "About the optional browser",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "OpenClaw can attach to a live browser on its Hivra computer. This can help with sites that need a visual interface or a logged-in session. You can watch the browser and take over to sign in or approve important steps.",
            "The browser also increases resource usage. More importantly, it expands what the agent may be able to do, so avoid leaving it signed into accounts with broad permissions unless that access is genuinely needed.",
          ],
        },
      ],
    },
    {
      heading: "Could I run OpenClaw on my own VPS?",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Absolutely. OpenClaw is open source, and self-hosting may be the better fit if you want full control over the server, network and upgrade timing.",
            "Hivra is for people who want to skip the server chores. We provision the computer, keep the service available and put a protected access layer in front of its native UI. You still get the same project and configure the same connections.",
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Does OpenClaw work through Telegram or WhatsApp?",
      a: "You can connect channels such as Telegram, WhatsApp and Signal through OpenClaw's Control UI. Availability and setup requirements depend on the project's current integrations and the connected messaging services.",
    },
    {
      q: "Will scheduled jobs run while I'm offline?",
      a: "Yes, when configured correctly. The OpenClaw gateway stays available on a paid VM, and its scheduler can trigger routines without your browser being open. Jobs still depend on working credentials, provider availability and correct schedules.",
    },
    {
      q: "Is the Control UI exposed to everyone?",
      a: "No. The Hivra deployment places it behind an authenticated gateway. That is helpful, but it doesn't replace sensible model, token and messaging-account permissions.",
    },
    {
      q: "Can OpenClaw use a browser?",
      a: fill(
        "Yes, optionally. Turning on the live browser adds {browserAdd} to the computer. The entry plan's {entryCompute} is enough for that configuration.",
      ),
    },
    {
      q: "What do I need to bring?",
      a: fill(
        "A paid Hivra plan, a compatible model provider and any messaging accounts you want to connect. Provider and third-party usage charges can apply separately. {aiNote}",
      ),
    },
    {
      q: "Is this an official OpenClaw offering?",
      a: "No. Hivra is an independent hosting service. We deploy the open-source OpenClaw project without claiming affiliation or endorsement.",
    },
    {
      q: "How should I handle personal account access?",
      a: "Give the agent only what it needs. Keep sensitive changes subject to review, use dedicated accounts where practical and remember that credentials may reside on the hosted computer. Hivra administrators retain infrastructure access to managed hosts.",
    },
  ],
  closing: {
    heading: "Message your agent. It can handle the rest of its schedule.",
    links: [
      { label: "Deploy OpenClaw", target: "deploy" },
      { label: "View pricing", target: "pricing" },
      { label: "Explore all agents", target: "agents" },
    ],
  },
  affiliation: "Hivra is independent and is not affiliated with or endorsed by OpenClaw.",
  related: {
    heading: "Related",
    slugs: ["hermes", "agent-zero", "claude-code", "codex", "aeon"],
  },
};
