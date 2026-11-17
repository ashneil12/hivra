import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "deepseek-harness",
  section: "agents",
  title: "DeepSeek Harness on Hivra",
  metaTitle: "Run DeepSeek Harness on Hivra (alpha)",
  metaDescription: "DeepSeek Harness is an alpha agent on Hivra: DeepSeek's coding agent on its own computer, with its model set at launch.",
  summary: "DeepSeek Harness is DeepSeek's coding agent. It is in alpha on Hivra and runs on a computer of its own.",
  lastReviewed: "2026-11-17",
  status: "alpha",
  blocks: [
    {
      heading: "What it is",
      paragraphs: [
        "DeepSeek Harness is DeepSeek's coding agent. Hivra runs it on a private computer and opens its own interface behind your Hivra sign-in. It is labelled alpha because the upstream version it runs is pinned at an alpha release. It has no public agent page yet.",
      ],
    },
    {
      heading: "Where it runs",
      paragraphs: [
        "Hivra Cloud only, on a paid plan (see [pricing](/pricing)). A server you connected cannot run it. It needs at least 2 vCPU and 3 GB of RAM.",
        "Its Launch tile is not on the first-run card, so look for it in the full list.",
      ],
    },
    {
      heading: "How it gets its model",
      paragraphs: [
        "DeepSeek's own settings refuse a key from a remote browser, so the model is set when you launch. It runs DeepSeek V4.1 Flash on Hivra credits by default, or on your own Venice API key. [Models and credits](/docs/models-and-credits) has the detail.",
      ],
    },
    {
      heading: "Open it",
      paragraphs: [
        "Open it from your Home page. You get DeepSeek's own interface through Hivra's sign-in. [Open your agent](/docs/open-an-agent) covers the shared views.",
      ],
    },
    {
      heading: "Update it",
      paragraphs: [
        "Updating is covered on [Update an agent](/docs/update-an-agent).",
      ],
    },
    {
      heading: "Who makes it",
      paragraphs: [
        "Hivra is an independent hosting service and is not affiliated with or endorsed by DeepSeek. DeepSeek Harness is their software.",
      ],
    },
  ],
  articles: ["deepseek-harness-coding-agent"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
