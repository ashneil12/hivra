import type { FeaturePageContent } from "./types";
import { HOSTED_COMPUTE_NEEDS_PLAN } from "@/lib/blog/plan-facts";
import { HERMES_OPENCLAW_MIGRATION_GUIDE, closingActions } from "./shared";

// /features/openclaw-alternative. The copy is 05-openclaw-alternative.md (20 October 2026); deviations are in the lane ledger.

export const OPENCLAW_ALTERNATIVE: FeaturePageContent = {
  slug: "openclaw-alternative",
  seoTitle: "Managed OpenClaw Hosting and Hermes Alternative | Hivra",
  description:
    "Host OpenClaw on Hivra or explore Hermes. Keep familiar agent workflows on a persistent cloud computer without managing your own VPS.",
  eyebrow: "OpenClaw on Hivra",
  h1: "Keep the agent, lose the server chores",
  breadcrumb: "OpenClaw alternative",
  lead: {
    heading: "You don't have to stop using OpenClaw to stop maintaining its server.",
    blocks: [
      {
        kind: "p",
        text: "OpenClaw has given a lot of people a practical way to run their own personal AI agent. It connects models to messaging channels and tools, and its open-source community has built a broad range of skills around it.",
      },
      {
        kind: "p",
        text: "The difficult part often isn't the agent. It's keeping the computer underneath it healthy, reachable and up to date.",
      },
      {
        kind: "p",
        text: "On Hivra, you have two paths. **Keep using OpenClaw**, hosted on a paid Hivra computer, or **try Hermes**, also on a paid Hivra computer, if you prefer the way it handles memory, skills and recurring work. Either way, Hivra provides the computer rather than asking you to keep your laptop running.",
      },
      { kind: "note", text: "Hivra is not affiliated with the OpenClaw project." },
    ],
  },
  sections: [
    {
      heading: "Why people choose to self-host OpenClaw",
      blocks: [
        {
          kind: "p",
          text: "Control is a perfectly good reason. If you're comfortable with Linux, Docker, your own network and the consequences of giving an agent access to your accounts, self-hosting can be a sensible choice. You decide where it runs, how it is backed up and when software changes happen.",
        },
        {
          kind: "p",
          text: "But that control also comes with maintenance. A messaging gateway needs to stay reachable. A scheduled job cannot run if its host has been switched off. A failed dependency update needs someone to fix it. Running a second or third independent agent means another layer of configuration and resource management.",
        },
        {
          kind: "p",
          text: "Hivra is for people who still want a capable agent but would rather spend their time on the workflows than the machine hosting them.",
        },
      ],
    },
    {
      heading: "Path one: keep OpenClaw",
      blocks: [
        {
          kind: "p",
          text: "Launch OpenClaw on Hivra and configure it as you would on another host. You can continue using its native capabilities and supported integrations, subject to the framework and deployment options. Hivra handles the hosted computer, process lifecycle and dashboard access.",
        },
        {
          kind: "p",
          text: "Moving an existing setup is **manual**. Hivra does not currently offer a one-click OpenClaw import. Review your configuration, transfer supported files and credentials carefully, then reconnect and test your channels. Browser cookies and sessions from your original machine will not simply appear on the new computer.",
        },
      ],
    },
    {
      heading: "Path two: move to Hermes",
      blocks: [
        {
          kind: "p",
          text: "Hermes is another agent framework, not a rebranded OpenClaw. It offers its own approach to persistent memory, skills, model access and workflows. Hivra hosts Hermes as a first-class option.",
        },
        {
          kind: "p",
          text: `Hermes documents a migration utility, [\`hermes claw migrate\`](${HERMES_OPENCLAW_MIGRATION_GUIDE}), that can inspect an OpenClaw setup and import supported data, including persona information, memory, skills and certain settings. Run it with \`--dry-run\` first, so you can see what will change before moving anything.`,
        },
        {
          kind: "p",
          text: "There are important exclusions. Cron jobs, plugins, webhooks and some channel bindings need setting up again; WhatsApp may need re-pairing. Credentials should be handled deliberately, not copied across without review. The exact supported fields depend on the Hermes version you're using.",
        },
        {
          kind: "p",
          text: "This isn't a promise that a complex OpenClaw installation will behave identically on Hermes. It's a way to preserve part of your existing work while choosing a different framework.",
        },
      ],
    },
    {
      heading: "What actually changes when you move to Hivra?",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "The computer.",
              text: "Your agent runs on a hosted machine rather than relying on a process on your personal laptop.",
            },
            {
              term: "Operations.",
              text: "Hivra handles provisioning and managed restarts, with monitoring and dashboard tools for supported deployments.",
            },
            {
              term: "Where data lives.",
              text: "Agent memory, configuration and authorised credentials are stored in the hosted environment instead of only on your own device. Decide whether that suits your privacy requirements before connecting sensitive accounts.",
            },
            {
              term: "How you pay.",
              text: "Hivra charges for hosting. Your model provider's inference costs, and any separately paid integrations, remain your responsibility.",
            },
            {
              term: "What does not magically change.",
              text: "Agent mistakes, risky skills, prompt injection, broken websites and excessive permissions are still risks. A managed server is not an excuse to stop reviewing what an agent can do.",
            },
          ],
        },
      ],
    },
    {
      heading: "OpenClaw or Hermes?",
      blocks: [
        {
          kind: "table",
          caption: "OpenClaw on Hivra compared with Hermes on Hivra",
          rowHeading: "What matters to you",
          columns: ["OpenClaw on Hivra", "Hermes on Hivra"],
          rows: [
            { label: "Keep an existing OpenClaw setup", cells: ["Yes, with manual migration", "Partial import using Hermes tooling"] },
            { label: "Framework and extensions", cells: ["OpenClaw's own ecosystem", "Hermes' own skills and tool system"] },
            { label: "Long-running hosted computer", cells: ["A paid Hivra Cloud computer", "A paid Hivra Cloud computer"] },
            { label: "Memory", cells: ["OpenClaw memory and configuration", "Hermes memory and skills"] },
            { label: "Scheduled tasks", cells: ["OpenClaw scheduler", "Hermes scheduler"] },
            { label: "Automatic one-click migration", cells: ["No", "No"] },
            { label: "Existing browser logins move automatically", cells: ["No", "No"] },
          ],
        },
        {
          kind: "p",
          text: "The right choice depends on what you already use. If your OpenClaw workflows work well, there is no reason to migrate frameworks just for the sake of it. If you are starting fresh, try both and choose the workflow you prefer.",
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Is Hivra an alternative to OpenClaw itself?",
      a: "Hivra is a hosting platform, not a replacement agent framework. You can run OpenClaw on it or deploy Hermes and other supported agents.",
    },
    {
      q: "Can I move all my OpenClaw skills and plugins?",
      a: "Running OpenClaw allows you to retain compatible OpenClaw tooling. Moving to Hermes supports a subset of migration data; plugins and some other integrations need manual work.",
    },
    {
      q: "Will my existing API key work?",
      a: "Often, provided the chosen framework supports that provider and the key is still valid. Check your provider's access and billing rules.",
    },
    {
      q: "What about my Telegram or WhatsApp connection?",
      a: "Reconnection may be necessary. Hivra does not promise a zero-step migration of messaging sessions.",
    },
    {
      q: "Can I use OpenClaw for free on Hivra?",
      a: `Not on a computer that Hivra Cloud runs for you. ${HOSTED_COMPUTE_NEEDS_PLAN} The OpenClaw software is free. The computer that runs it is what you pay for.`,
    },
    {
      q: "Is managed hosting more private than local hosting?",
      a: "It moves your data and execution to a provider-managed computer. Hivra aims to provide isolation and control, but local and cloud hosting have different trust models. Choose deliberately.",
    },
  ],
  actions: closingActions({ label: "Explore supported agents", href: "/agents" }, { label: "See plans", href: "/pricing" }),
  related: [
    { label: "No Docker hosting", href: "/features/no-docker-hosting" },
    { label: "Persistent memory", href: "/features/persistent-memory" },
    { label: "Multiple agents", href: "/features/multi-agent" },
  ],
};
