import type { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "what-is-zeroclaw",
  title: "What is ZeroClaw? A first task for the Rust personal agent",
  metaTitle: "What is ZeroClaw? The Rust personal agent explained",
  metaDescription:
    "ZeroClaw is an open-source personal agent written in Rust. Learn what it needs to answer a prompt and how to try a first task in Hivra chat.",
  publishedDate: "2026-11-27",
  lastModified: "2026-11-27",
  readingTimeMin: 2,
  author: "Hivra Team",
  tagline: "Start with one prompt before you connect a chat app.",
  intro:
    "ZeroClaw is an open-source personal agent written in Rust. It runs as a command-line program and needs a model provider before it can answer you. If you run it on Hivra, you can try it from Hivra chat before setting up a separate messaging app.",
  shortAnswer:
    "ZeroClaw is a personal agent you run from the command line. A model provider supplies the replies, and you can configure messaging channels separately. When ZeroClaw is listed in Hivra Launch, you can run it on its own computer and send your first prompt in Hivra chat.",
  sections: [
    {
      heading: "The agent and the model are separate",
      paragraphs: [
        "ZeroClaw is the program you install. The model is the service it asks for a reply. If you install ZeroClaw yourself, follow the [ZeroClaw project instructions](https://github.com/zeroclaw-labs/zeroclaw) to configure a provider. Installing the binary alone does not get you a working chat.",
        "If you see ZeroClaw in Hivra Launch, Hivra installs the official release on its own computer. With model access configured at launch, you can send it a message through Hivra chat. The Terminal and Files tabs are there if you need to inspect the environment or its files. If ZeroClaw is not listed, see [other agents on Hivra](/agents).",
      ],
    },
    {
      heading: "Try a prompt you can check",
      paragraphs: [
        "Paste two or three sample notes into chat and ask ZeroClaw to pull out the action items without adding any. This gives you a reply you can check against the input and confirms that the agent can reach its model. It does not need access to email, a calendar or a messaging account.",
        "A reply in Hivra chat tells you that chat and the model connection worked. If you later connect a messaging channel in ZeroClaw, send a separate test message there before relying on it. Channel setup and credentials are separate from Hivra chat.",
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need a messaging app to use ZeroClaw on Hivra?",
      a: "No. When ZeroClaw is listed in Hivra Launch and has model access configured, you can use Hivra chat without connecting a messaging app.",
    },
    {
      q: "What if ZeroClaw is not in Launch?",
      a: "Use the upstream ZeroClaw installation guide to run it yourself, or see the Hivra agents page for other options.",
    },
  ],
  relatedArticles: [
    { slug: "what-is-an-ai-agent", title: "What is an AI agent?" },
    { slug: "byo-api-key-explained", title: "What does bring your own API key mean?" },
  ],
};
