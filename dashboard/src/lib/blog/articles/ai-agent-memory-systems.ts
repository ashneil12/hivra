import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "ai-agent-memory-systems",
  title: "AI agent memory systems in 2026: Zep, Mem0, Letta, and dual-layer architectures",
  metaTitle: "AI agent memory systems: Zep, Mem0 and Letta compared",
  metaDescription:
    "How AI agent memory works in production. Zep, Mem0, Letta and LangGraph checkpointers compared, plus the hot path and cold path pattern.",
  publishedDate: "2026-04-03",
  lastModified: "2026-09-30",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "What real agents use for memory once the context window runs out.",
  intro:
    "A 200K token context window sounds huge. Then you run an agent every day for a few weeks and find out it isn't storage at all. Memory has to live somewhere else, and a handful of systems now do that job.",
  shortAnswer:
    "AI agent memory systems keep facts outside the context window and pull in only the relevant ones before each step. Zep uses a temporal knowledge graph. Mem0 is built around user preferences. Letta lets the agent page its own memory in and out. Most production setups pair recent messages (the hot path) with an external store (the cold path).",
  sections: [
    {
      heading: "Why can't the context window just be the memory?",
      paragraphs: [
        "Because it's expensive and slow. Even with Claude Sonnet 4.6's 1M token context or GPT-5.4's 1M window, stuffing in the full history doesn't work for an agent you run every day. Digital Applied's January 2026 technical guide says it bluntly: 'Even 200K-400K token windows (Claude, GPT-5.4) or 2M (Gemini 3) are impractical for full history due to cost and latency. External episodic memory databases remain mandatory for production agents.'",
        "Do the sums. At $3 per million input tokens for Sonnet 4.6, a full 1M token context costs $3 a call. Fifty tasks a day is $150 a day, spent on re-reading old conversation.",
        "So agents retrieve instead. Before each step they search stored memory and put only the handful of most relevant facts into context. That swaps one problem for another: what do you store, when, and in what shape? Store everything word for word and you get a noisy pile nobody can search. Pull out facts, preferences and how-to patterns as you go, and memory gets more useful the longer the agent runs.",
      ],
    },
    {
      heading: "What is the hot path and cold path memory pattern?",
      paragraphs: [
        "It's two layers of memory with a cleanup step after each turn. The Digital Applied guide describes it as the pattern most production agents now use.",
        "The hot path is what just happened. The last few interactions, summarised so they fit in context, plus the current state of the task. The cold path is everything older, sitting in an external store (Zep, Mem0, Pinecone, or Postgres with pgvector) and fetched by similarity search. Speed matters most here. The guide's benchmarks target under 100ms per lookup, which takes a well-tuned vector index running close to the agent.",
        "Then a memory step runs after the turn ends. It pulls out facts, updates what the agent knows about the user, and writes or edits Skill Documents based on how the task went. Running it afterwards keeps the agent quick while it works. Most setups hand it to a background worker so it never blocks the main loop.",
      ],
    },
    {
      heading: "Zep, Mem0 or Letta: which memory system should you use?",
      paragraphs: [
        "Pick by what your agent has to remember. Facts that change over time point to Zep. A person's preferences point to Mem0. An agent that should manage its own memory points to Letta.",
        "Zep stores memory as a temporal knowledge graph. It tracks how things relate and how those relationships change, so it can reason like this: 'the project budget was updated last Tuesday, overriding the figure from the previous meeting.' The Digital Applied benchmark rates it the strongest for accuracy and complex reasoning.",
        "Mem0 is about the user. What they like, how they work, what they asked for last time, how they reacted to the agent's last move. It's the most widely plugged-in memory layer in personal assistants and customer-facing agents. Honcho, which Hermes Agent can use as an option, works in a similar way, building a model of the user that carries across tools and sessions.",
        "Letta grew out of MemGPT, the UC Berkeley research project that first showed persistent agent memory working. It borrows from how an operating system handles memory: some in context, some in storage, and the agent itself decides what to page in and out. Letta was also the first open-source framework to show agents getting measurably better at tasks after weeks of running. That's a real track record.",
      ],
    },
    {
      heading: "Is a LangGraph checkpointer the same as agent memory?",
      paragraphs: [
        "No. A checkpointer is about not losing your place. Memory is about knowing things. If an agent crashes halfway through a task, a LangGraph checkpointer (PostgresSaver is the usual production pick) lets it resume from the last saved step. It also lets you wind the agent's state back to see why it made a run of bad decisions.",
        "But checkpoints belong to one thread: one agent, one task. They don't carry knowledge from one task to the next or from one user conversation to another. For that you still need a memory layer such as Zep, Mem0, Letta or a plain vector store. The usual stack runs both: PostgresSaver so a crash doesn't cost you the run, and a user-level memory system so the agent remembers.",
        "Hermes Agent does the same job with its own pieces. MEMORY.md and USER.md hold what it knows. Skill Documents in the agentskills.io format hold how it does things. The event log is the history. Add the optional Honcho integration and you get a user model that carries across sessions, handy when one agent serves several people.",
      ],
    },
    {
      heading: "Does memory actually make an agent better?",
      paragraphs: [
        "Yes, and you notice it fast. One user report referenced in the Hermes documentation: within two hours of first running Hermes, the agent had written three Skill Documents from the tasks it was given, then finished a similar research task faster using them, by the user's own estimate. The user didn't tune a single prompt. The agent wrote down what worked and used it.",
        "Sam Sahin, writing on Medium in March 2026 about wiring Mem0 into LangGraph, nails the problem: 'You built a beautiful agent. It answers questions, calls tools, reasons through multi-step problems. Users love it during the session. Then they come back the next day, and the agent asks them their name again.' Memory fixes that. And the agent that greets you by name and picks up your last project isn't doing anything exotic. Same loop. Better notes.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is the difference between Zep and Mem0?",
      a: "Zep stores memory as a temporal knowledge graph, so it's strongest when an agent has to track facts and relationships that change over time. Mem0 is built around one user's preferences and habits, so it suits personal assistants. Both run in production. Pick Zep for accuracy about a changing world, Mem0 for personalisation.",
    },
    {
      q: "What is MemGPT / Letta?",
      a: "MemGPT was a UC Berkeley research project that showed persistent agent memory by paging memory in and out the way an operating system does. It's now open-source software called Letta. It works with any model, and the agent itself decides what stays in context and what goes to storage.",
    },
    {
      q: "Do I need a vector database to add memory to my agent?",
      a: "Not at first. A plain markdown or JSON file (like Hermes's MEMORY.md) is fine for a small amount of structured knowledge. Once an agent has months of history and thousands of entries, you'll want a vector database such as Pinecone, Qdrant or pgvector so it can still find the right memory quickly.",
    },
    {
      q: "What is a LangGraph checkpointer and do I need one?",
      a: "It saves the agent's state at each step, so a crashed run picks up where it stopped instead of starting again. PostgresSaver is the usual choice. If your agents run long tasks you can't cheaply restart from zero, you need one. Without it, a crash halfway through loses everything.",
    },
    {
      q: "How does Hermes Agent handle memory?",
      a: "With three layers. MEMORY.md holds general knowledge the agent reads at the start of a session. USER.md holds what it knows about you: preferences, working style, current projects. Skill Documents in the agentskills.io format hold how it handles specific kinds of task. The optional Honcho integration adds a user model that carries across sessions.",
    },
  ],
  relatedArticles: [
    { slug: "how-ai-agents-work", title: "How AI agents actually work: the reasoning loop and tool use" },
    { slug: "persistent-memory-explained", title: "How persistent memory works in AI agents" },
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent?" },
  ],
  relatedFeatures: [
    { slug: "persistent-memory", title: "Persistent Memory" },
    { slug: "scheduled-tasks", title: "Scheduled Tasks" },
  ],
};
