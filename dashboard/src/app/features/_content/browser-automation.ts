import type { FeaturePageContent } from "./types";
import { AI_USAGE_NOT_INCLUDED, OWN_ACCOUNT_TERMS, closingActions } from "./shared";

// /features/browser-automation. The copy is 02-browser-automation.md (20 October 2026); deviations are in the lane ledger.

export const BROWSER_AUTOMATION: FeaturePageContent = {
  slug: "browser-automation",
  seoTitle: "AI Agent Browser Automation | Hivra",
  description:
    "Give a Hermes agent a persistent cloud browser for research, forms and website workflows, without keeping your laptop switched on.",
  eyebrow: "Browser Automation",
  h1: "An actual browser for your AI agent",
  breadcrumb: "Browser automation",
  lead: {
    heading: "Let your agent use the websites you already use.",
    blocks: [
      {
        kind: "p",
        text: "APIs are useful, but plenty of work still happens in a browser. Exporting a report, checking a supplier portal, comparing pricing or copying details from a website can mean opening half a dozen tabs and doing the same steps repeatedly.",
      },
      {
        kind: "p",
        text: "A Hermes agent hosted on Hivra can do much of that work through a browser on its own cloud computer. It can navigate pages, enter information, extract text and take screenshots to check what happened. On a paid Hivra Cloud computer, the browser stays available even after you close your laptop.",
      },
      {
        kind: "p",
        text: "That doesn't mean every site will cooperate, or that the agent should be trusted with unrestricted access. You decide what to connect and which actions require your approval.",
      },
    ],
  },
  sections: [
    {
      heading: "What you can build with it",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "Research without the tab juggling.",
              text: "Give your agent a list of companies or sources, and ask it to collect changes, verify details and write a brief with links. It can move between pages in one run, rather than relying on a single search snippet.",
            },
            {
              term: "Routine updates and reports.",
              text: "When a service has a dashboard but no useful API, an agent can sometimes log in and export reports, inspect statuses or update approved records through the interface.",
            },
            {
              term: "Repetitive form work.",
              text: "Populate known fields from an approved source, then stop for confirmation before submitting anything sensitive or irreversible. That last review is important: a correct-looking form can still contain the wrong value.",
            },
            {
              term: "Regular website checks.",
              text: "Combine the browser with scheduling to monitor a product page, a public information source or a list of supplier updates. Save the previous result so the agent can report what actually changed.",
            },
          ],
        },
        {
          kind: "note",
          text: "Only automate services you are authorised to use. Website terms, rate limits and data-protection obligations still apply.",
        },
      ],
    },
    {
      heading: "Where the browser actually runs",
      blocks: [
        {
          kind: "p",
          text: "For supported Hermes hosting on paid plans, the default environment is a persistent Chromium browser running on the agent's cloud computer. Hermes can control it using the Chrome DevTools Protocol (CDP). Hivra offers a live browser view on supported deployments, and browser actions and screenshots can be reviewed in the agent's session history where they are kept.",
        },
        {
          kind: "p",
          text: "Hermes also supports alternative browser backends. Users who already have accounts with services such as **Browserbase** or **Browser Use** can configure their own keys. A local Chrome/CDP connection is another framework option for people deliberately connecting a browser they control.",
        },
        {
          kind: "p",
          text: "The default browser uses a data-centre IP address. It is not a residential connection, and a hosted browser does not inherit your home browser's cookies or sessions automatically.",
        },
      ],
    },
    {
      heading: "Logins, sessions and security",
      blocks: [
        {
          kind: "p",
          text: "Once you've authenticated to a permitted site, the persistent browser may retain its cookies and session state between tasks. That's convenient, but a logged-in browser can also act with your account's permissions. Use dedicated low-privilege accounts where possible, avoid giving agents access they do not need, and require human confirmation for payments, deletions and public posts.",
        },
        {
          kind: "p",
          text: "Screenshots help an agent check where it has landed, but they are not proof that a task succeeded. For important workflows, have it verify the final state rather than simply clicking Submit and moving on.",
        },
        {
          kind: "p",
          text: "Hermes' browser tooling also includes safeguards against requests to internal and private network addresses when using cloud-browser integrations. That is a useful boundary, not a guarantee that websites or prompts are safe. Pages can contain malicious instructions, so review what the agent is allowed to read and do.",
        },
      ],
    },
    {
      heading: "What about sites that block bots?",
      blocks: [
        {
          kind: "p",
          text: "Some websites detect and restrict automated browsers, especially those using cloud infrastructure. CAPTCHAs, access challenges, changed page layouts and login requirements can interrupt a run. Third-party browser services may improve compatibility on certain sites, but neither Hivra nor Hermes can promise access everywhere.",
        },
        {
          kind: "p",
          text: "If a site provides a supported API, it is often a more reliable option than browser automation. If it does not permit automated access, do not try to use Hivra to evade that restriction.",
        },
      ],
    },
    {
      heading: "Pair it with scheduled tasks",
      blocks: [
        {
          kind: "scenario",
          text: "Imagine a competitor-monitoring task that runs before work each morning. The agent opens the same approved pages, extracts the information you care about, compares it with its previous notes and sends a summary only when something worth reading changed.",
        },
        {
          kind: "p",
          text: "For simple checks, a lightweight request or API call may be cheaper than opening a browser and analysing screenshots. Let the task use the lightest reliable method first and reserve visual inspection for the steps that need it.",
        },
      ],
    },
    {
      heading: "Costs and limitations",
      blocks: [
        {
          kind: "p",
          text: "Hivra hosts the browser and agent computer. Your model provider may charge for the prompts and image inputs used during the task. Screenshot-heavy workflows can use substantially more tokens than text-only extraction. Third-party browser providers may have their own fees.",
        },
        {
          kind: "p",
          text: "Browser automation cannot see behind accounts you haven't authorised, access native-app-only services without a web interface, or guarantee success against changing site designs.",
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Can I watch the agent browse?",
      a: "Hivra's Hermes integration includes a live view of its persistent Chromium environment, and session history can help you review actions. Check availability in your deployed version.",
    },
    {
      q: "Can it stay logged in between runs?",
      a: "In many cases, yes, where the website permits it and the browser retains session state. Some services expire sessions or require fresh authentication.",
    },
    {
      q: "Can it run at night?",
      a: "Yes, when the hosted agent and scheduled task are configured and the service remains available. Your laptop does not need to stay on.",
    },
    {
      q: "Does Hivra supply model inference?",
      a: `${AI_USAGE_NOT_INCLUDED} ${OWN_ACCOUNT_TERMS}`,
    },
    {
      q: "Will it work on any website?",
      a: "No. Access controls, anti-bot protections and site changes can block or disrupt automation.",
    },
  ],
  actions: closingActions({ label: "Deploy an agent", href: "/agents" }, { label: "See pricing", href: "/pricing" }),
  related: [
    { label: "Persistent memory", href: "/features/persistent-memory" },
    { label: "Scheduled tasks", href: "/features/scheduled-tasks" },
    { label: "No Docker hosting", href: "/features/no-docker-hosting" },
  ],
};
