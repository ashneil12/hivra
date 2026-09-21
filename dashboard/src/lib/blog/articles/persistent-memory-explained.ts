import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "persistent-memory-explained",
  title: "How persistent memory works in AI agents",
  metaDescription:
    "Most AI tools forget you the moment you close the tab. Here's how persistent memory actually works in agents, what it stores, and what it means for automation you can trust.",
  publishedDate: "2026-03-19",
  lastModified: "2026-03-19",
  readingTimeMin: 8,
  author: "Hivra team",
  tagline: "Not a longer context window. Something else.",
  intro:
    "Persistent memory in AI agents is not the same as a long context window. Here is what it actually stores, how it is structured, and why it matters for any task that spans more than one session.",
  sections: [
    {
      heading: "What context windows do and do not do",
      paragraphs: [
        "Every language model has a context window — the amount of text it can see at once during a conversation. Frontier models in 2026 have windows of 200,000 to 1,000,000 tokens. Claude Sonnet 4.6 and Opus 4.6 both support 1 million tokens. These are genuinely large. A million tokens holds roughly 700,000 words simultaneously.",
        "But context windows are not persistent. They last for one session. Start a new conversation and the model knows nothing from the previous ones. Two hundred sessions with a chatbot, then a fresh conversation — you are back to zero, regardless of window size. This is not a limitation that larger windows fix. Even with infinite context, a model would still start each session fresh unless a separate memory store loads into context at session start. That is what persistent memory systems do.",
      ],
    },
    {
      heading: "How persistent memory systems work",
      paragraphs: [
        "A persistent memory system stores information between sessions and retrieves relevant pieces when a new one starts. At its simplest: a database of text snippets with metadata, and a retrieval function that queries it based on what the current session needs.",
        "Vector databases handle this well because they allow semantic retrieval — finding memories that are conceptually relevant even if the wording differs. If the agent stored 'the user prefers Python over JavaScript' and the current task involves writing code, that memory surfaces even if the new prompt never mentions Python. More structured approaches use tiered memory: hot memory for things needed in almost every session (your name, your primary projects, standing preferences), warm memory for less frequent but important context, and cold memory for archived history retrievable on demand but not loaded automatically.",
      ],
    },
    {
      heading: "What Hermes stores in memory",
      paragraphs: [
        "Hermes Agent uses three distinct memory types implemented as files the agent reads and writes directly. The user model lives in `USER.md` — a structured document containing your technical background, communication preferences, standing project context, and operational patterns. The agent updates this as it learns more about you. General learned facts live in `MEMORY.md`, a curated store read at session start and written to when the agent discovers something worth retaining.",
        "Skill Documents are procedural memory — searchable markdown files in the agentskills.io open format encoding how to approach specific task types. Tools used, decision tree, failure modes encountered, how they were handled. On future similar tasks, the agent retrieves and loads the relevant Skill Document rather than reasoning from scratch. This is the compounding mechanism: an agent that has done 50 research tasks is materially faster and more reliable than one on its first.",
        "Event memory is a timestamped log of tasks, decisions, and outcomes. This is what lets the agent tell you what it did last Tuesday and why it made a particular call. Optional Honcho integration adds cross-session AI-native user modeling as a separate API layer — building a persistent user understanding that carries across different tools, not just Hermes sessions.",
      ],
    },
    {
      heading: "Why this requires a persistent server",
      paragraphs: [
        "Memory stored on your laptop disappears when you close the application, reformat the drive, or switch machines. For memory to be genuinely persistent — accessible from any device, surviving hardware failures, available when the agent runs scheduled tasks while you are offline — it needs to live on a server.",
        "This is the infrastructure dependency that makes cloud hosting important for anyone relying on their agent's memory long-term. A self-hosted VPS works, but it requires manually configuring backups, volume mounts, and disaster recovery. The practical consequence: the longer an agent runs, the more valuable its accumulated memory becomes. An agent six months in with thousands of Skill Documents is meaningfully different from a fresh install. That accumulated state is worth protecting.",
      ],
    },
    {
      heading: "What persistent memory does not do",
      paragraphs: [
        "Memory systems do not make agents reliable. An agent with rich memory can still take incorrect actions, misunderstand ambiguous instructions, or apply a past strategy where it does not fit. Memory helps with context. It does not substitute for good task design and human oversight on consequential actions.",
        "Memory also does not stay accurate on its own. If the agent learns something incorrect — a wrong assumption about how a system works, a miscategorized approach in a Skill Document — that incorrect information persists and gets retrieved on future tasks. Periodic review and correction matters for agents doing high-stakes work.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is memory shared across different agents or profiles?",
      a: "No. Memory is strictly isolated per-profile. When you launch a profile (e.g., `hermes -p coder`), its memory lives in its own dedicated directory tree (`~/.hermes/profiles/coder/memories/MEMORY.md` and `USER.md`). If you experience shared memory, it is because you are running without the `-p` flag, which defaults to the global `~/.hermes/` directory.",
    },
    {
      q: "How much does storing agent memory cost?",
      a: "The storage footprint for typical agent memory is small — a few hundred megabytes for months of active use. It is not a significant cost driver compared to API token usage.",
    },
    {
      q: "Can I export or review my agent's memory?",
      a: "Yes. From the agent's page in the dashboard, one click downloads your data — the agent's chats plus its memory files — as a single structured JSON file. The memory files (USER.md / MEMORY.md) are also browsable and editable in the Files tab.",
    },
    {
      q: "What happens to memory if I cancel my Hivra subscription?",
      a: "Export before you cancel. While your subscription is active you can download your full data — chats and memory — as a single portable JSON file from the agent's page, any time you like. (A grace window to download after cancellation is on the roadmap; for now, take your export while you're still subscribed.)",
    },
  ],
  relatedArticles: [
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent? A plain-English explanation" },
    { slug: "ai-agent-vs-chatbot", title: "AI agents vs chatbots: the actual difference" },
    { slug: "how-ai-agents-work", title: "How AI agents actually work: the reasoning loop and tool use" },
  ],
  relatedFeatures: [
    { slug: "persistent-memory", title: "Persistent Memory" },
    { slug: "scheduled-tasks", title: "Scheduled Tasks" },
  ],
};
