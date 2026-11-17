import type { DocPage } from "../types";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  FREE_ACCOUNT_SENTENCE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";

export const doc: DocPage = {
  slug: "plans-and-billing",
  section: "start",
  title: "What you pay for",
  metaTitle: "Hivra plans and billing: what you pay for",
  metaDescription: "A Hivra account costs nothing. Computers that Hivra Cloud runs need a paid plan, and model usage is paid separately. Here is how each part works.",
  summary: "The account is free. You pay for the computer when Hivra Cloud runs it, and for model usage when you use Hivra credits.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "The account costs nothing",
      paragraphs: [
        "A Hivra account costs nothing to make. You can sign in, look around Launch and connect a server of your own without paying Hivra anything. " + FREE_ACCOUNT_SENTENCE,
        "Hivra runs no free computer. If you want Hivra to run the computer, that needs a paid plan.",
      ],
    },
    {
      heading: "Hivra Cloud computers",
      paragraphs: [
        `Every computer that Hivra Cloud runs for you needs a paid plan, whichever agent or computer you pick. Paid plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. A larger size is ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}.`,
        "The plan covers the computer: its processor, memory and storage, and its place on Hivra Cloud. On a paid plan the computer stays on and is not paused for inactivity, so your agent's files and logins are still there when you come back.",
        "Plan details and the current sizes are on the [pricing page](/pricing).",
      ],
    },
    {
      heading: "If you change your mind",
      paragraphs: [
        `Paid plans come with a ${MONEY_BACK_GUARANTEE}. It covers card payments only.`,
      ],
    },
    {
      heading: "Model usage is separate",
      paragraphs: [
        "A plan pays for the computer, not for the AI model your agent thinks with. How you pay for the model depends on how you connect it:",
        "- **Hivra credits.** Model usage is paid from your credits at provider rates. Credits reach models through Venice. If your balance is empty, Launch offers a way to add credit.\n- **Your own key.** The provider bills your usage directly. Hivra credits are not used.\n- **Your own account.** For Claude Code you can sign in with your Claude account, and for Codex with ChatGPT. That usage follows the terms of the account you signed in with.",
        "[Choose how your agent gets its model](/docs/models-and-credits) lists which agent supports which option.",
      ],
    },
    {
      heading: "Running on your own server",
      paragraphs: [
        "A connected server is your hardware and your bill, and the paid plan is for computers Hivra Cloud runs. Which agents and computers a connected server can run depends on how you connected it. [Run agents on your own server](/docs/connect-your-own-server) explains both ways.",
        "Hivra does not guarantee backups of what is on a computer. Keep your own copies of anything you cannot lose.",
      ],
    },
  ],
  articles: ["cost-of-running-ai-agent", "byo-api-key-explained"],
  next: ["models-and-credits", "connect-your-own-server", "getting-started"],
};
