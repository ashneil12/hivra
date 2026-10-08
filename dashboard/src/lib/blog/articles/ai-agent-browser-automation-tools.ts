import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "ai-agent-browser-automation-tools",
  title: "AI agent browser automation in 2026: Browser Use, Stagehand, Playwright, and Puppeteer",
  metaTitle: "AI agent browser automation tools: which one to pick",
  metaDescription:
    "Browser Use, Stagehand, Playwright and Puppeteer compared on speed, cost per task and how each one breaks, with a table for picking.",
  publishedDate: "2026-04-03",
  lastModified: "2026-10-08",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "Four tools for one job. Each breaks in its own way.",
  intro:
    "Browser work is the most useful thing an agent can do, and the thing people most often set up wrong. The four main tools differ a lot on success rate and cost per task. They also fail in very different ways.",
  shortAnswer:
    "Playwright is the pick when the site rarely changes and the job runs often. Stagehand fits when most of a flow is stable and a few steps need AI. For open-ended tasks on sites that keep moving, reach for Browser Use, knowing a model decides each step. Puppeteer suits low-level Chrome DevTools work.",
  sections: [
    {
      heading: "AI browser agent or plain script: what's the trade-off?",
      paragraphs: [
        "Flexibility costs money and speed. A fully AI-driven tool like Browser Use handles any page without fragile selectors, but every run is slower and costs more. A plain Playwright script runs almost instantly and costs nothing at volume. Then the site moves a button and it breaks.",
        "So most teams mix them. AI takes the messy, unpredictable steps. Playwright takes the stable, repetitive ones. The four tools below sit at different points along that line.",
        "Hermes Agent can use all four styles. Browserbase (cloud headless browsers), Browser Use (the autonomous loop), raw Chrome CDP and local Chromium are all available as backends, and you choose per task. That matters, because a login script and an open-ended research job want very different things.",
      ],
    },
    {
      heading: "What is Browser Use, and when is it worth the cost?",
      paragraphs: [
        "Browser Use is an open-source Python library (MIT license, 50,000+ GitHub stars) that puts a full agent loop around a browser. The model looks at the page through screenshots and the DOM, picks the next action, does it, and goes again. You write the goal in plain English. No step-by-step script.",
        "The numbers: 89.1% success on WebVoyager, the standard web navigation benchmark, and 72 to 78% task completion in production depending on the model. A simple action takes 2 to 5 seconds, a form fill 10 to 30, a data pull 5 to 15. Each task costs $0.02 to $0.30, because it runs 5 to 20 model steps and every one of them reads screenshots. Under 5% of tasks break when a site changes, since the AI adapts on its own.",
        "The downside is real. It's the slowest option by a mile, the most expensive per task, and the hardest to debug, because you're reading traces instead of spotting a broken line. Use it when the target sites are inconsistent or the goal is open-ended. Run it thousands of times against a stable site and the cost and wait pile up fast. Hermes Agent uses Browser Use as its default for research tasks where nobody knows the exact path in advance.",
      ],
    },
    {
      heading: "What is Stagehand, and why mix AI with scripted steps?",
      paragraphs: [
        "Stagehand is Browserbase's layer on top of Playwright (TypeScript and JavaScript, MIT license). It adds three AI calls: act() for actions in plain English, extract() for structured data checked against a Zod schema, and observe() to find elements. Version 3.0 talks to Chrome DevTools Protocol directly and runs 44% faster than 2.0.",
        "It completes about 75% of WebVoyager tasks. A simple action takes 1 to 3 seconds, a form fill 5 to 15, a data pull 2 to 8. Each AI action costs $0.002 to $0.02, roughly a tenth of Browser Use per step. Under 5% of scripts broke over 30 days.",
        "The win is mixing both styles in one workflow. Do the login with plain selectors (reliable, no AI cost), then call act('click the export button') for the part of the page that changes every month. You keep most of the AI's resilience without paying a model for every click. Browserbase hosts it for $0.01 per minute of browser time. It's the obvious pick for TypeScript teams whose workflows are part stable, part shifting.",
      ],
    },
    {
      heading: "When is plain Playwright the right call?",
      paragraphs: [
        "When the page doesn't change much and you run it a lot. Playwright (Microsoft, Apache 2.0) is the standard for scripted browser work. It drives Chromium, Firefox and WebKit, waits for elements on its own, intercepts network calls, records traces and runs in parallel across browser contexts. You can write it in JavaScript, TypeScript, Python, Java or C#.",
        "On a known path it completes about 98% of tasks, the best of the four while the script is current. Simple actions take under 100ms, form fills under 500ms, data pulls under 200ms. The extra cost per run is zero. The catch: 15 to 25% of scripts break within 30 days when the target site updates. That upkeep is the real price of scripting, and most Playwright recommendations leave it out.",
        "Reach for it when you hit the same page structure thousands of times a day, when the target is an internal tool with stable HTML, or when you need runs you can reproduce exactly for compliance. Skip it for sites that change often, for watching competitors' sites you don't control, or for any job where the path differs from run to run.",
      ],
    },
    {
      heading: "Is Puppeteer still worth using?",
      paragraphs: [
        "For new projects, mostly no. Puppeteer (Google, MIT license) is the older, Chrome-only cousin of Playwright and talks to Chrome DevTools Protocol directly. Plenty of scrapers built on it between 2020 and 2023 still run fine and never needed moving. Start something new and Playwright is the cleaner default: better waiting, Firefox and WebKit support, a more consistent API.",
        "Puppeteer still wins on depth. It gets closer to Chromium's internals: CDP sessions, security settings, performance profiling, service worker interception. If your job really needs low-level DevTools access in Chrome, use it.",
        "Hermes Agent offers raw Chrome DevTools Protocol as a backend for exactly those Puppeteer-style jobs, with its planning layer on top. That's what counts in stealth work (getting past bot checks, controlling the browser fingerprint), where precise CDP access decides whether the session gets blocked.",
      ],
    },
    {
      heading: "Which browser automation tool should I use for my job?",
      paragraphs: [
        "| Job | Use | Why |\n|---|---|---|\n| High-volume work on stable sites (internal tools, structured pages, CI tests) | Playwright | Near-zero cost and the fastest runs. Add Stagehand if even one part of the page shifts |\n| Research and competitor monitoring on public sites that change | Browser Use via Hermes | The 89.1% WebVoyager result holds up for this kind of work. Budget $0.05 to $0.30 a run at Haiku or Sonnet rates |\n| Stable login, shifting content | Stagehand | Selectors for the parts you control, act() and extract() for the rest. v3.0's 44% speed-up makes it quick enough |\n| Raw CDP or fingerprint-sensitive work | Puppeteer, or Hermes's Chrome CDP backend | Playwright's tidy abstraction is exactly what gets in the way here |",
        "Upkeep on Playwright stays manageable when you control the site or get alerted the moment a selector breaks. When you don't, that 15 to 25% monthly breakage is the number to plan around.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is Browser Use and how does it compare to Playwright?",
      a: "Browser Use is an AI agent library: you give it a goal in plain English and the model plans and does every browser action. Playwright is a scripting framework where you write each step in code. Browser Use scores 89.1% on WebVoyager and adapts when a site changes, but costs $0.02 to $0.30 a task. Playwright hits about 98% on known paths in milliseconds for no extra cost, and needs fixing by hand when the site changes.",
    },
    {
      q: "What is Stagehand and why does it exist?",
      a: "Stagehand is Browserbase's TypeScript SDK on top of Playwright. It adds three AI calls (act, extract, observe) and keeps everything Playwright can already do. So you script the stable parts with selectors and hand only the shifting parts to the AI. You pay for AI only where you need it.",
    },
    {
      q: "What is Browserbase and how does it relate to these tools?",
      a: "Browserbase is a cloud service that runs headless Chrome for you, with persistent sessions, anti-detection and parallel runs. The same company built Stagehand, and Browserbase also works with Playwright and Puppeteer. Hermes Agent can use it as a backend when a task needs a persistent browser session in the cloud.",
    },
    {
      q: "Why does Hermes Agent support 4 different browser backends?",
      a: "Because jobs differ. Browserbase gives you cloud sessions that persist and dodge bot detection. Browser Use handles open-ended navigation. Chrome CDP gives low-level control. Local Chromium keeps work fully private or offline. You set the backend per task, so each job gets the tool that fits it.",
    },
    {
      q: "How much does AI browser automation cost per task?",
      a: "Browser Use runs $0.02 to $0.30 a task (5 to 20 model steps, with screenshots eating vision tokens). Stagehand costs $0.002 to $0.02 per AI action. Playwright and Puppeteer add nothing per run. You only pay for the server the browser runs on. A daily competitor check on Hermes with Browser Use usually costs $0.05 to $0.15 a run, or $1.50 to $4.50 a month.",
    },
  ],
  relatedArticles: [
    { slug: "how-ai-agents-work", title: "How AI agents actually work: the reasoning loop and tool use" },
    { slug: "ai-agent-api-cost-optimization", title: "What an AI agent costs per month in API tokens (2026)" },
    { slug: "ai-agent-automation-examples", title: "7 things your agent can automate overnight" },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser Automation" },
    { slug: "scheduled-tasks", title: "Scheduled Tasks" },
  ],
};
