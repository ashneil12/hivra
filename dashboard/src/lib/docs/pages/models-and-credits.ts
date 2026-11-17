import type { DocPage } from "../types";

export const doc: DocPage = {
  slug: "models-and-credits",
  section: "models",
  title: "Choose how your agent gets its model",
  metaTitle: "Choose how your agent gets its AI model",
  metaDescription: "Use Hivra credits, your own Venice key, or sign in with your Claude or ChatGPT account. See which supported agent takes which option.",
  summary: "An agent needs a model to think with. Pick Hivra credits, your own key, or an account you already have, depending on the agent.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "The options",
      paragraphs: [
        "Launch asks how you would like to connect your agent to AI. Each agent shows only the choices it supports.",
        "- **Hivra credits.** Use supported models through Hivra without setting up a separate provider key. Credits reach models through Venice, and usage is paid from your credits at provider rates. This is the default where an agent supports it.\n- **Your own Venice key.** Paste a Venice API key and Venice bills your usage. The key is sent to the agent's computer, and you can save it in your Vault.\n- **Your own account.** Claude Code can sign in with a Claude account, and Codex with ChatGPT, inside the agent after it opens. This is subject to the provider's terms.\n- **The agent's own settings.** Some agents let you choose a provider in their own interface after they open.",
      ],
    },
    {
      heading: "Which agent takes which option",
      paragraphs: [
        "| Agent | Hivra credits | Your own Venice key | Your own account | The agent's own settings |\n| --- | --- | --- | --- | --- |\n| Claude Code | Yes, Venice's Claude models | No | Sign in with Claude | No |\n| Codex | Yes | Yes | Sign in with ChatGPT | No |\n| Hermes | Yes | Yes | No | Choose a provider in Hermes |\n| OpenClaw | Yes | No | No | Choose a provider in its Control UI |\n| Agent Zero | Yes | No | No | Choose a provider in its Settings |\n| Aeon | Yes, set up when you connect GitHub | No | No | Uses the key on your GitHub fork |\n| DeepSeek Harness | Yes, the default | Yes | No | No |",
        "Where a table cell says No, Launch explains why and what to do instead. For example, Claude Code does not take a pasted key at launch, so use credits or sign in.",
      ],
    },
    {
      heading: "Good to know",
      paragraphs: [
        "DeepSeek Harness is given its model at launch because its own settings refuse a key from a remote browser. It runs DeepSeek V4.1 Flash on credits by default.",
        "Hermes on a Hivra computer starts on a default model through Venice. You can change the model, or choose another provider in Hermes's own settings.",
        "Hivra credits are not offered on a self-hosted installation of Hivra. Codex can also be given your OpenAI API key inside Codex after it opens.",
        "If your credit balance is empty, Launch offers a way to add credit before you start chatting. The computer's plan is separate from model usage, see [what you pay for](/docs/plans-and-billing).",
      ],
    },
  ],
  articles: ["byo-api-key-explained", "ai-agent-api-cost-optimization", "claude-max-vs-pro-for-claude-code"],
  next: ["plans-and-billing", "claude-code", "codex", "hermes"],
};
