import type { FeaturePageContent } from "./types";
import { closingActions } from "./shared";

// /features/scheduled-tasks. The copy is 07-scheduled-tasks.md (20 October 2026); deviations are in the lane ledger.

export const SCHEDULED_TASKS: FeaturePageContent = {
  slug: "scheduled-tasks",
  seoTitle: "Scheduled AI Agent Tasks and Cron Jobs | Hivra",
  description:
    "Schedule recurring Hermes agent work from the Hivra dashboard. Run research, reporting and monitoring without leaving your laptop on.",
  eyebrow: "Scheduled AI Agent Tasks",
  h1: "Make the recurring work actually recur",
  breadcrumb: "Scheduled tasks",
  lead: {
    heading: "Tell your agent once. Give it a time. Check what happened.",
    blocks: [
      {
        kind: "p",
        text: "An agent that only works while you're speaking to it is useful. An agent that can return to a recurring job while you're doing something else is a different proposition.",
      },
      {
        kind: "p",
        text: "With supported Hermes deployments on Hivra, you can schedule repeated tasks from the dashboard. Give the agent clear instructions, choose when they should run and review the results afterwards. Because the agent runs on a cloud computer, your laptop doesn't have to stay awake for the scheduler to work.",
      },
      {
        kind: "p",
        text: "It's particularly useful for work with a clear finish line: gather these updates, check these sources, produce this report and notify me only if something has changed.",
      },
    ],
  },
  sections: [
    {
      heading: "From a plain-English instruction to a schedule",
      blocks: [
        {
          kind: "p",
          text: "Open the agent's **Tasks** tab. Name the task, describe what it should do and specify what an acceptable result looks like. Choose an hourly, daily, weekly or monthly schedule, including the relevant time and weekdays where supported.",
        },
        {
          kind: "p",
          text: "The Tasks tab also supports editing an existing custom cron expression, pausing and resuming schedules, and using **Run now** to test a task without waiting for its next scheduled time.",
        },
        {
          kind: "p",
          text: "When a task begins, the agent uses its configured tools and available memory to carry out the instructions. You can inspect its recorded output and the last run status. If it fails, the dashboard shows the last error and you can retry, correct the instruction or wait for its next scheduled run.",
        },
        {
          kind: "p",
          text: "A schedule is not a success guarantee. External APIs can fail, websites can change and the model can misunderstand an instruction. Build in checks for important work.",
        },
      ],
    },
    {
      heading: "Jobs that work especially well",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "Daily reading and research.",
              text: "Collect updates from a known list of sources, link to the originals and produce a brief before your working day starts.",
            },
            {
              term: "Changes worth noticing.",
              text: "Check approved public pages for changes, compare them with an earlier baseline and only send a notification when something meaningful has moved.",
            },
            {
              term: "Weekly engineering housekeeping.",
              text: "Summarise merged pull requests, flag recurring errors or prepare a report about known issues. Keep production changes behind human review.",
            },
            {
              term: "Data maintenance.",
              text: "Find incomplete records in a permitted system, propose corrections and apply only the changes your workflow authorises.",
            },
          ],
        },
        {
          kind: "p",
          text: "The strongest scheduled tasks have explicit source lists, output formats and stopping conditions. 'Keep an eye on everything' is much harder to verify than 'Check these five pages each weekday and tell me what changed'.",
        },
      ],
    },
    {
      heading: "Four example workflows",
      blocks: [
        {
          kind: "workflows",
          items: [
            {
              title: "A morning competitor brief",
              text: "At 7am, check a short list of pricing pages and product changelogs. Summarise changes against yesterday's notes, include links and send a message to the chosen channel. If nothing important changed, say so rather than inventing news.",
            },
            {
              title: "A Monday development report",
              text: "Review the previous week's merged work and issue labels. Produce a Markdown report for the team, with references to actual pull requests and outstanding follow-ups. Don't make unsupervised production changes.",
            },
            {
              title: "An hourly error check",
              text: "Ask a permitted monitoring service for newly observed error classes. Compare them to a maintained known-issues list, and alert only when a meaningful new pattern appears. Escalate uncertain findings instead of silently modifying services.",
            },
            {
              title: "Monthly CRM housekeeping",
              text: "Identify records missing approved fields, research publicly available details and prepare proposed updates. For personal data, use appropriate permissions and retain a review step before bulk edits.",
            },
          ],
        },
        {
          kind: "note",
          text: "These are examples, not preconfigured workflows that are guaranteed to work without connecting the relevant services.",
        },
      ],
    },
    {
      heading: "Combine schedules with browser access and memory",
      blocks: [
        {
          kind: "p",
          text: "Scheduling becomes particularly useful when the agent can use more than a single API call. It can visit permitted websites through the hosted browser, extract information and compare it with its prior observations.",
        },
        {
          kind: "p",
          text: "Persistent memory gives the task continuity. A regular brief can refer to historical changes instead of treating every run as day one. But memory can be incomplete, and changes should be checked against the current source rather than accepted because the agent remembers them.",
        },
        {
          kind: "p",
          text: "Hermes also has a more advanced hooks system for developers. Gateway and tool-related hooks can support logging, metrics or custom checks, depending on configuration. Those are framework facilities, not a promise that Hivra currently provides a no-code orchestration platform.",
        },
      ],
    },
    {
      heading: "Delivery, failures and costs",
      blocks: [
        {
          kind: "p",
          text: "Results can be viewed through the task history. Depending on your configured agent integrations, they may also be sent through channels such as Telegram, Discord or email. These destinations require appropriate credentials and permissions.",
        },
        {
          kind: "p",
          text: "There isn't a blanket promise that every scheduled task will finish on time. Large simultaneous jobs compete for CPU and RAM within your hosting plan. Heavy browser tasks may also consume substantial model inference tokens, charged separately by your provider. On smaller plans, stagger demanding runs rather than starting everything on the hour.",
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need to know cron syntax?",
      a: "Not for basic recurrence. The dashboard offers common scheduling choices. Existing custom cron schedules can also be edited where supported.",
    },
    {
      q: "Can I run a task immediately to test it?",
      a: "Yes. Use **Run now** from the Tasks interface on supported Hermes deployments.",
    },
    {
      q: "What happens if something fails?",
      a: "The run is logged and its last error is shown. Investigate the problem, adjust the task and retry or let it run again on schedule.",
    },
    {
      q: "Can a task use a browser or external APIs?",
      a: "Yes, if the agent has the required tools and authorised credentials. Website restrictions and provider limits still apply.",
    },
    {
      q: "Can I send the results to Telegram or email?",
      a: "With the relevant integration configured, supported destinations include Telegram, Discord or email. Verify the channel for your agent version.",
    },
    {
      q: "Is there a task limit?",
      a: "Hivra does not publish a fixed task-count cap for paid plans, but practical concurrency depends on your compute allocation and the model or service limits you use.",
    },
    {
      q: "Will two agents coordinate their schedules?",
      a: "Not automatically. You can arrange deliberate handoffs, but native multi-agent orchestration remains planned.",
    },
  ],
  actions: closingActions({ label: "Start with an agent", href: "/agents" }, { label: "See pricing", href: "/pricing" }),
  related: [
    { label: "Persistent memory", href: "/features/persistent-memory" },
    { label: "Browser automation", href: "/features/browser-automation" },
    { label: "Multiple agents", href: "/features/multi-agent" },
  ],
};
