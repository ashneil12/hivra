import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "hermes",
  section: "agents",
  title: "Hermes on Hivra",
  metaTitle: "Run Hermes Agent on Hivra",
  metaDescription: "What Hermes Agent is, where it runs on Hivra, how it reaches a model, how you open it and how you update it.",
  summary: "Hermes is a general agent from Nous Research that keeps memory and runs scheduled jobs. On Hivra it gets a computer of its own.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "Hermes is an open-source agent from Nous Research. On Hivra you get the official Hermes Agent: Hivra sets up the computer, runs Hermes's own installer and adds no modifications to it. See the [Hermes page](/agents/hermes) for what people use it for.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "Hermes runs on Hivra Cloud only, not on a server you connect. Every Hivra Cloud computer needs a paid plan, which you can see on [pricing](/pricing). It needs at least 1 vCPU and 2 GB of RAM.",
      ],
    },
    {
      heading: "How it gets its model",
      paragraphs: [
        "You choose when you launch. Hivra credits reach models through Venice, and the default model is deepseek-v4-1-flash. You can also use your own Venice key, or pick a provider in Hermes's own settings after it opens. [Choose how your agent gets its model](/docs/models-and-credits) compares the options.",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open Hermes from your Home page. You get Hermes's own web UI, behind your Hivra sign-in. The agent's page also has a Dashboard tab, plus Terminal and Files tabs for the computer it lives on, and a Manage tab. [Open your agent](/docs/open-an-agent) explains each view.",
        "Hermes keeps its memory and scheduled jobs on its computer, so they stay there when you close the tab.",
      ],
    },
    {
      heading: "Update it",
      paragraphs: [
        "Run `hermes update` in the Terminal tab, or press the Update Hermes button on the Manage tab. See [Update an agent](/docs/update-an-agent) for the general steps.",
      ],
    },
    {
      heading: "Who makes it",
      paragraphs: [
        "Hivra is an independent hosting service and is not affiliated with or endorsed by Nous Research. Hermes is theirs, and the computer, sign-in and management views around it are Hivra's.",
      ],
    },
  ],
  articles: ["what-is-hermes-agent", "hermes-agent-skills-guide", "hermes-agent-cron-scheduled-tasks"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
