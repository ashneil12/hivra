import type { FeaturePageContent } from "./types";
import { HOSTED_COMPUTE_NEEDS_PLAN } from "@/lib/blog/plan-facts";
import { AI_USAGE_NOT_INCLUDED, REPOSITORY_URL, closingActions } from "./shared";

// /features/no-docker-hosting. The copy is 04-no-docker-hosting.md (20 October 2026); deviations are in the lane ledger.

export const NO_DOCKER_HOSTING: FeaturePageContent = {
  slug: "no-docker-hosting",
  seoTitle: "Host AI Agents Without Docker or VPS Setup | Hivra",
  description:
    "Deploy Hermes and other supported AI agents on managed cloud computers without maintaining Docker, SSL certificates or your own VPS.",
  h1: "AI Agent Hosting Without Docker",
  breadcrumb: "Managed hosting",
  lead: {
    heading: "You wanted to run an agent, not become its systems administrator.",
    blocks: [
      {
        kind: "p",
        text: "You can self-host an AI agent. For plenty of developers, that's a good choice. But getting it working is only half the job. After the initial setup come updates, restarts, backups, certificates, security patches and the question of what happens when it stops working while you're away.",
      },
      {
        kind: "p",
        text: "Hivra takes responsibility for much of that infrastructure so you can concentrate on the work you actually wanted the agent to do.",
      },
      {
        kind: "p",
        text: "Choose a supported agent, launch its computer and connect the model provider you want to use. You don't need to know Docker just to get through the first screen.",
      },
    ],
  },
  sections: [
    {
      heading: "What running it yourself involves",
      blocks: [
        {
          kind: "p",
          text: "A typical self-hosted setup might mean renting a Linux VPS, configuring access, installing Docker and Compose, setting environment variables, setting up a domain and reverse proxy, and obtaining HTTPS certificates. Then you need persistent storage for the things the agent should remember, plus a way to inspect logs and bring the service back after a crash or server reboot.",
        },
        {
          kind: "p",
          text: `None of these steps is impossible. In fact, we want technical users to keep that option. Hivra is [open source](${REPOSITORY_URL}), and not everybody needs managed hosting.`,
        },
        {
          kind: "p",
          text: "But if you're building a business, experimenting with several agents or simply getting started, hours spent sorting out container networking are hours you could have spent using the agent.",
        },
      ],
    },
    {
      heading: "What Hivra manages",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "Provisioning.",
              text: "Hivra prepares a cloud computer and starts the agent environment. You aren't asked to rent a separate VPS for a supported managed deployment.",
            },
            {
              term: "Access and networking.",
              text: "The platform handles its managed access paths and HTTPS, rather than asking you to configure Caddy, Nginx or certificates yourself.",
            },
            {
              term: "Process health.",
              text: "Hivra monitors hosted services and can restart failed agent processes. This helps with ordinary crashes; it is not a guarantee of uninterrupted service or instant recovery after a host-level incident.",
            },
            {
              term: "Updates.",
              text: "For supported managed Hermes deployments, Hivra can roll a new version out in stages, starting with a single agent. Updates can still introduce incompatibilities, so important projects should retain exports and test their own integrations.",
            },
            {
              term: "One dashboard.",
              text: "The same place you deploy your agent gives you a view of its status, configuration and available management tools.",
            },
          ],
        },
      ],
    },
    {
      heading: "From sign-up to your first task",
      blocks: [
        {
          kind: "steps",
          items: [
            "Create your Hivra account and choose a supported deployment or plan.",
            "Launch the agent you want. Hivra prepares the environment and shows its provisioning status.",
            "Add the relevant provider API key or approved login method for that framework, subject to the provider's terms.",
            "Tell the agent what you're trying to do, then connect only the integrations it needs.",
            "Start with a small task, review the outcome and expand its permissions gradually.",
          ],
        },
        {
          kind: "p",
          text: `${AI_USAGE_NOT_INCLUDED} Bringing an API key means your model provider may bill you independently of Hivra.`,
        },
      ],
    },
    {
      heading: "Managed doesn't mean locked down to a chatbot box",
      blocks: [
        {
          kind: "p",
          text: "For people who want to inspect and customise their setup, Hivra's dashboard exposes tools such as logs, the agent's tool directory and a container shell on supported deployments. You can investigate a failed task, install or adjust supported tools and work beyond the basic setup flow.",
        },
        {
          kind: "p",
          text: "Those controls are optional. Someone who has never typed a Docker command should still be able to use an agent; someone who knows Linux shouldn't be forced to give up every useful route to the machine underneath.",
        },
      ],
    },
    {
      heading: "Hosting choices and honest limits",
      blocks: [
        {
          kind: "p",
          text: `**Hermes** runs on Hivra Cloud only. Claude Code, Codex, OpenClaw, Agent Zero and Aeon can also run on a server you connect yourself, such as a Hetzner Cloud project or a Linux server that Hivra can reach over SSH. ${HOSTED_COMPUTE_NEEDS_PLAN} Hivra checks what each server can run, and features can differ from a Hivra Cloud computer.`,
        },
        {
          kind: "p",
          text: "There is no region selector for standard Hivra Cloud sign-up today. If a particular geographic or compliance requirement is essential, verify the hosting location and processing arrangement before deploying sensitive workloads.",
        },
        {
          kind: "p",
          text: "Hivra reduces maintenance. It does not remove your responsibility to secure the services and credentials you connect, inspect high-impact actions or keep copies of important data.",
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need to install Docker?",
      a: "Not for a normal managed Hivra deployment. The platform provisions and runs the supported agent environment.",
    },
    {
      q: "Is Hivra just a VPS reseller?",
      a: "Hivra manages agent-specific setup, interfaces, restarts and integrations around the underlying compute. You are paying for an agent-focused hosting experience, not merely raw server capacity.",
    },
    {
      q: "Can I use a terminal if I want to?",
      a: "Supported deployments provide a container shell and logs through the dashboard. The precise controls vary by agent type.",
    },
    {
      q: "Can I choose the server region?",
      a: "Not on Hivra Cloud today. For Claude Code, Codex, OpenClaw, Agent Zero and Aeon, you can connect your own server or a Hetzner Cloud project and choose where it runs.",
    },
    {
      q: "Do you guarantee backups?",
      a: "No blanket backup guarantee. Keep your own exports of memory, configuration and anything important.",
    },
    {
      q: "What happens if an update breaks an integration?",
      a: "Hivra can stage managed releases, but regressions are possible. Use the logs and support channels, and retain a copy of your configuration.",
    },
  ],
  actions: closingActions({ label: "Start deploying", href: "/agents" }, { label: "Compare hosting plans", href: "/pricing" }),
  related: [
    { label: "OpenClaw alternative", href: "/features/openclaw-alternative" },
    { label: "Multiple agents", href: "/features/multi-agent" },
    { label: "Persistent memory", href: "/features/persistent-memory" },
  ],
};
