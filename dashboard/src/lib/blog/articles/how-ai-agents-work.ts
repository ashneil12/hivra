import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "how-ai-agents-work",
  title: "How AI agents actually work: the reasoning loop, tool use, and planning",
  metaTitle: "How AI agents work: the reasoning loop and tool use",
  metaDescription:
    "How an AI agent goes from a task to a result: the reasoning loop, tool calling, memory retrieval, multi-step planning, and why agents fail.",
  publishedDate: "2026-04-03",
  lastModified: "2026-09-30",
  readingTimeMin: 11,
  author: "Hivra team",
  tagline: "A loop, some tools and memory.",
  intro:
    "Give an AI agent a task and it starts a loop. It keeps going until the work is done. Here's what happens at each step, from the first model call to the finished result.",
  shortAnswer:
    "An AI agent is a language model wrapped in a loop. Each turn, the model produces a step: a thought or a tool call. The framework runs the tool and feeds the result back as an observation. Then the model produces the next step. Planning keeps it pointed at the original goal, and memory retrieval brings in relevant facts.",
  sections: [
    {
      heading: "How is an agent different from a chatbot?",
      paragraphs: [
        "A chatbot answers once and stops. It takes your message and the chat so far, writes a reply, and that's it. It can't call other services, can't do anything in the world, and can't keep working after that one reply.",
        "An agent puts the same model in a loop. Instead of writing a final answer straight away, the model writes one step. Either a thought about what to do next, or an action, which means calling a tool. The tool's result comes back as an observation. The model writes the next step. Round and round until the task is done. IBM's agent docs put it this way: 'AI agents use tool calling on the backend to obtain up-to-date information, optimize workflows and create subtasks autonomously.'",
        "That loop (think, act, observe, repeat) is called ReAct, short for Reasoning and Acting. It came from a 2022 paper by Princeton and Google Research, and LangGraph, CrewAI, AutoGen and Hermes Agent all use some version of it. It's the step that turns a model that answers questions into one that gets work done.",
      ],
    },
    {
      heading: "What is tool calling, really?",
      paragraphs: [
        "The model writes a request. The framework does the work. When the model decides to act, it outputs a small JSON payload naming a tool and its arguments. The agent framework catches that, runs the real function, and hands the result back. The model itself never runs any code.",
        "Common tools: web search, a browser (open pages, click, fill forms), a terminal (run shell commands, read the output), reading and writing files, calls to outside APIs, memory lookup, and code running in a sandbox.",
        "Claude Sonnet 4.6 and GPT-5.4 are both trained to produce valid tool calls reliably. GPT-3.5 needed heavy prompt work just to output consistent JSON. That one change in the models explains a lot of why agents were so much more dependable in 2025 and 2026 than in 2023.",
      ],
    },
    {
      heading: "How does an agent plan a multi-step task?",
      paragraphs: [
        "Simple jobs need no plan. Look up a fact, summarise a page, run a script: the agent just calls tools in order and hands back the result.",
        "Bigger jobs get a plan first. The agent writes out the list of subtasks before it starts any of them. Why bother? Because once work begins, the context fills up with actions and results, and a model with no written plan to look back at starts to forget what it was asked to do.",
        "Some setups split the work across several agents. An orchestrator breaks a research job into pieces and hands them to, say, a researcher, a coder and a writer, each running its own loop at the same time. Then it pulls their work together. Hermes Agent does this with subagents: the main agent can run up to 3 at once and combine what they return. LangGraph, CrewAI and AutoGen do something similar, trading flexibility against how much setup they need.",
      ],
    },
    {
      heading: "How does an agent remember things?",
      paragraphs: [
        "In two places. The first is the context window: the chat so far, the task, and every action and result from this session. It's small and it doesn't last. Claude Sonnet 4.6's 1M token window sounds endless, but an agent that uses lots of tools can burn hundreds of thousands of tokens in one long session, and every extra token costs money.",
        "The second is outside storage: vector stores, knowledge bases, old conversations. Before each step the agent searches that store and pulls the most relevant facts, skill documents or past results into context. That's how it can use something it learned months ago without carrying it around the whole time.",
        "Most production agents now combine the two. Recent messages and a summary of the current state sit on the hot path. Older knowledge sits on the cold path, fetched from Zep, Mem0, Pinecone or similar. Digital Applied's January 2026 guide makes the point that even 200K to 400K token windows are too slow and too costly to hold a full history, so outside memory stays necessary however big windows get.",
      ],
    },
    {
      heading: "Why do AI agents fail?",
      paragraphs: [
        "Three reasons come up again and again. Tool errors pile up: one call fails, the agent mishandles it, and it spirals into retries or bad reasoning. Long tasks fill the context until the model loses track of the original goal. And sometimes the model invents a tool call with bad arguments, or makes up a result instead of calling the tool at all. That last one is the most dangerous when the stakes are high.",
        "The fixes are unglamorous. Check every tool call against a schema before it runs. Cap the number of steps so a stuck loop ends. Put a human in front of anything you can't undo. And tell the agent in its instructions exactly what to do when a call fails.",
        "Hermes v0.5.0 added a safety net for file work: the `/rollback` command reverts file changes if the agent gets an edit wrong.",
        "This is why 'the agent does everything' is still too early for a lot of real work. Start with tasks where the agent can check its own output, where mistakes can be undone, and where any single error is cheap. Then widen the scope as it proves itself.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is the ReAct pattern in AI agents?",
      a: "ReAct (Reasoning and Acting) is the standard agent loop. The model thinks about the next step, takes an action by calling a tool, and reads the result as an observation. Then it thinks again. That repeats until the task is done or a stop condition kicks in.",
    },
    {
      q: "How is an AI agent different from an AI chatbot?",
      a: "A chatbot writes one reply and stops. An agent runs a loop: it calls tools, reads the results, works out the next step, and keeps going, sometimes for dozens of steps, until the job is finished. An agent can act in other systems. A chatbot can't.",
    },
    {
      q: "What tools does a typical AI agent have access to?",
      a: "Web search, a browser (clicking, filling forms, moving between pages), a terminal, the file system, outside APIs, a sandbox for running code, image analysis, and memory lookup. Which ones you get depends on the framework and how it's set up.",
    },
    {
      q: "Do AI agents actually understand what they're doing?",
      a: "The model predicts likely next steps from patterns it learned in training. There's no inner experience. It can still break a task into steps, handle errors and change course when a tool says something went wrong. Call that understanding or not, the result is the same: a well-built agent finishes complex tasks reliably when the task is within its reach.",
    },
    {
      q: "How do agents handle tasks that take hours to complete?",
      a: "They save their progress as they go: the plan, the steps done so far and the relevant memory, written to a database. If the process stops, it picks up from the last save instead of starting over.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-vs-chatbot", title: "AI agents vs chatbots: the actual difference" },
    { slug: "persistent-memory-explained", title: "How persistent memory works in AI agents" },
    { slug: "multi-agent-systems-explained", title: "Multi-agent systems: how they're built in 2026" },
  ],
  relatedFeatures: [
    { slug: "persistent-memory", title: "Persistent Memory" },
    { slug: "browser-automation", title: "Browser Automation" },
    { slug: "scheduled-tasks", title: "Scheduled Tasks" },
  ],
};
