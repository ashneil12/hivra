import type { DocPage } from "../types";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "@/lib/blog/plan-facts";

export const doc: DocPage = {
  slug: "codex",
  section: "agents",
  title: "Codex on Hivra",
  metaTitle: "Run Codex on Hivra",
  metaDescription: "Launch Codex on a computer of its own: sign in with ChatGPT, use a Venice key or Hivra credits, find its tabs, keep runs going, update it and fix problems.",
  summary: "Codex is OpenAI's coding agent. On Hivra it runs on a computer of its own, with a chat, its own command line, a terminal and your files.",
  lastReviewed: "2026-11-17",
  status: "available",
  blocks: [
    {
      heading: "What Codex on Hivra is",
      paragraphs: [
        "Codex is OpenAI's coding agent. Hivra runs the Codex command line tool on a computer of its own, so your repositories, installed tools and login stay in one place between visits. You reach it from the browser, from any device, and you do not need your laptop to stay open for the computer itself to stay available.",
        "This page is for developers and AI power users who want to launch Codex, choose how it reaches a model, find their way around its tabs and keep it healthy. The [Codex page](/agents/codex) has the shorter pitch. Hivra is an independent hosting service and is not affiliated with or endorsed by OpenAI. Codex is OpenAI's product, and your use of it stays subject to OpenAI's terms.",
        "Codex is listed as available. It runs on Hivra Cloud, or on a Proxmox VE server you connected.",
      ],
    },
    {
      heading: "Before you start",
      paragraphs: [
        "You need three things.",
        `- **A Hivra account.** A Hivra Cloud computer needs a paid plan, which starts at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. You can use your own server if your account is eligible to connect it. See [Plans and billing](/docs/plans-and-billing) and [Run agents on your own server](/docs/connect-your-own-server).`,
        "- **A way to reach a model.** Pick one of three: sign in with your ChatGPT account, use a Venice API key, or pay with Hivra credits. The next block explains each.",
        "- **Room on your plan.** Codex can start as small as 0.5 CPU and 1 GB of memory with its browser off. With the browser on it needs at least 1.5 CPU and 3 GB.",
        "If you plan to use your own server, Codex runs on a Proxmox VE server you connected. The one-command Ubuntu route is for Linux Sandbox only.",
      ],
    },
    {
      heading: "Launch Codex step by step",
      paragraphs: [
        "1. Open **Launch** from your Home page. Under **What do you want to launch?** choose **Codex**.",
        "2. On the Review step, check the **Agent name**. Hivra suggests a name such as Codex 1 and bumps the number if that name is taken. You can change it.",
        "3. Check **Where it runs**. It shows Hivra Cloud, or a server you connected if you have one. Press **Change** to open the panel, then **Done** to close it. Without an eligible plan or an eligible connected server, Launch shows a plan check with a **Check again** button and will not start.",
        "4. Check **Size**. Press **Change** to pick a different CPU and memory size.",
        "5. Decide on the **Browser** toggle. It lets Codex open and use a web browser on its computer. It starts on when the place it runs can hold it.",
        "6. Under **Model access**, answer \"How would you like to connect your agent to AI?\" by choosing one of the three options.",
        "7. Read the **Cost** row, then press **Launch Codex**. Nothing starts until you do.",
        "![The Review step for a Codex agent with the Browser toggle and the three Model access choices](/images/docs/dash-launch-review.webp \"Review step with sample data: look at Where it runs, Size, the Browser toggle, the three Model access choices and the Cost row. The 12.50 dollar balance is a sample.\")",
        "After launch, the new agent appears on your Home page. If you chose to sign in with your own account, Hivra shows a sign-in screen the first time you open it. See the next block.",
      ],
    },
    {
      heading: "How Codex gets its model",
      paragraphs: [
        "Every agent is offered the same three choices in the same order. For Codex, all three work.",
        "| Choice | What it means for Codex | Who bills model use |\n| --- | --- | --- |\n| **Sign in with my existing account** | You sign in to ChatGPT inside Codex after it opens. Where available, with an eligible account, subject to the provider's terms. | OpenAI, under your own plan and limits |\n| **Use my own API key** | The key you paste at launch is a Venice API key. | Venice bills your model usage |\n| **Hivra credits** | Hivra reaches models for you through Venice. You need no Venice account. | Your Hivra credits, at provider rates |",
        "On credits or your Venice key, Codex starts on DeepSeek V4.1 Flash unless you pick another model from the **Model** list. Venice flags models marked Private as keeping no record of your prompts.",
        "The Review row for a sign-in launch reads \"Sign in to ChatGPT inside Codex after it opens.\" The launch itself does not ask for your ChatGPT password.",
        "### Using a Venice key",
        "Choose **Use my own API key**, then paste the key into the **Venice API key** field. The key you paste is sent to the agent's computer, and is saved in your Vault only if you tick **Save it in my Vault for next time**. Hivra checks it shortly after you paste it and shows \"Checking your key...\", then \"Key works.\" or \"Venice doesn't accept this key. Check it and try again.\" If Venice cannot be reached, it says \"Couldn't reach Venice to check this key. You can still launch.\" You can tick **Save it in my Vault for next time** so a later launch offers **Use my saved key**.",
        "A Venice key must be one line of 8 to 256 characters. Otherwise the form says \"Check the key: it should be one line of 8 to 256 characters.\"",
        "### Using an OpenAI API key",
        "Launch does not take an OpenAI key. If you prefer an OpenAI key to a ChatGPT sign-in, that is something you set up inside Codex itself, where Codex allows it. Hivra's own notice for Codex says you can sign in with ChatGPT or provide your own OpenAI API key inside Codex. Hivra does not verify that path for you, so check OpenAI's current rules for your account.",
        "### Using Hivra credits",
        "Choose **Hivra credits**. If your balance is empty the option reads \"Add credit to start chatting.\" and offers an **Add credit** button. If you have both card credits and token credits, a **Pay from** list lets you choose which pays. See [Models and credits](/docs/models-and-credits) for the full comparison.",
      ],
    },
    {
      heading: "Sign in with ChatGPT",
      paragraphs: [
        "When you launched with **Sign in with my existing account**, the first time you open the agent Hivra shows \"Codex is almost ready.\" It runs the official Codex on your own ChatGPT account, and the session is stored on that computer.",
        "1. Press **Sign in with ChatGPT**.",
        "2. Hivra shows a one-time code. (In the Codex session tab or the console you may instead see a **Sign in with ChatGPT** dialog with a **Copy code & open sign-in** button; the steps are the same.) Press **Copy code** if you like.",
        "3. Open the ChatGPT sign-in page that Hivra links, sign in and enter the code there.",
        "4. Wait. Hivra checks the computer and detects the sign-in on its own, and the screen reads \"Waiting for you to authorize...\" until it does.",
        "Hivra only opens sign-in addresses on OpenAI or ChatGPT hosts. For anything else it shows \"This sign-in address isn't an OpenAI or ChatGPT page, so Hivra won't open it. Don't enter your password there.\"",
        "If you wait a long time, the screen says \"Hivra hasn't seen the sign-in yet.\" Press **Check again**.",
        "Administrators of the computer's host may have infrastructure access, so think about what you sign in to. On a server you connected, that host is you.",
      ],
    },
    {
      heading: "The tabs Codex has",
      paragraphs: [
        "Open the agent from your Home page. The agent page groups its views as the agent, its browser, its computer and its settings.",
        "| View | Where | What it is for |\n| --- | --- | --- |\n| **Chat** | Agent | Send Codex work and read what it did, including its tool use. |\n| **Codex session** | Agent | Codex's own command line, so you can use it as you would locally. |\n| **Browser** | Browser | The browser Codex uses, when the Browser toggle is on. |\n| **Files** | Computer | Browse the home folder, with a Files and Changes switch for the repository's changes. |\n| **Terminal** | Computer | A plain shell on the computer. |\n| **Desktop** | Computer | Explains how to give the agent a desktop. An agent never owns one by default. |\n| **Skills** | Manage | The skills Codex has installed, with delete icons and an **Add skills** button. |\n| **Manage** | Manage | Settings, labelled **Settings** in the side bar. |\n| **Telegram** | Settings group | Appears on the page. Hivra documents and verifies the Telegram flow only for Claude Code, so do not rely on it for Codex. |",
        "In **Settings**, the side nav has Overview, Model & tools, Resources, Recovery, Updates and Advanced.",
        "![The Settings page of a sample agent, showing Overview, Sign in again and the Stop and Restart power controls](/images/docs/dash-agent-manage.webp \"Settings Overview with sample data, shown for a Claude Code agent. Sign in again and the Power controls also appear for Codex. Some cards differ by agent.\")",
        "Some features belong to Claude Code only. Hivra only documents Telegram for Claude Code: a Telegram view connects your own bot to a Claude Code computer, and it also shows on a Codex agent page but is not verified for Codex. The **Ask me first** switch under Permissions, which makes the agent wait for your answer before each command, is also Claude Code only. Pasting an API key at launch works for Codex but not for Claude Code, which offers credits and its own sign-in.",
      ],
    },
    {
      heading: "Models and permissions after launch",
      paragraphs: [
        "Open **Settings**, then **Model & tools**.",
        "- **Model card (sign-in launches).** For Codex on your own sign-in, the options are Default, GPT-5.5, Codex Max, Codex and Codex (5). Type another ID in **Custom model id** and press **Set**. It applies from the next message and running turns are not interrupted. A model your account cannot access fails on the next message with a clear error in chat, so switch back if that happens.",
        "- **Inference card (credits or a Venice key).** Choose **My Venice key** or the **Managed gateway**, pick a **Model**, and apply it. Use **Use native sign-in** to go back to your own account.",
        "- **Permissions.** **Full access** is the default and lets Codex use the shell, files and web on its own computer. **Limited** keeps it sandboxed to its workspace with no system-wide changes. **Read-only** lets it look but not touch. It applies from the next message.",
        "- **Tools.** **Browse tools** attaches a capability, and an advanced section connects a raw MCP server by hand.",
        "Permissions limit what Codex does on its own computer. They are not a guarantee that an agent is safe, so keep secrets you do not want it to reach off that computer. See [Security and access](/docs/security-and-access).",
      ],
    },
    {
      heading: "What keeps running",
      paragraphs: [
        CLI_RUN_LIFETIME,
        "In practice, that gives you a simple routine for long jobs:",
        "```bash\ntmux new -s codex\ncodex\n# detach with Ctrl-b then d, close the laptop\ntmux attach -t codex\n```",
        "Run these in the **Terminal** tab, not in the Codex session tab. Hivra does not promise that a run started from Chat or from the Codex session tab continues after you close the browser tab, and computers differ by runtime version, so use tmux for anything you cannot afford to lose.",
        "Stopping the computer from Settings, under **Power**, shuts it down, and **Restart** reboots it in place. Hivra warns you first if replies are still being written. Plan and billing are separate from Power. See [Plans and billing](/docs/plans-and-billing).",
      ],
    },
    {
      heading: "Update Codex",
      paragraphs: [
        "Open **Settings**, then **Updates**. For Codex the card shows the installed version beside the version Hivra has tested, and an **Update Codex** button when you are behind. Hivra moves Codex to its tested version, not to whatever is newest upstream. The card also has an **Update automatically** switch while Hivra runs that for the computer.",
        "- If a reply is being written, Hivra waits for it to finish, for up to 6 hours. Messages you send during the install wait and then send by themselves, with \"Your computer is updating Codex to a new version. Your message will send in a moment.\"",
        "- Sessions already open in the Codex session tab keep the previous version until you close them.",
        "- If an update does not install, Hivra puts the previous version back and says so. If it cannot, it points you to Recovery or Force restart under Advanced.",
        "- If you installed a newer Codex yourself, the card says it is newer than the tested version, that Hivra chat may not work as expected with it, and that automatic updates leave it alone. **Switch** returns you to the tested one.",
        "See [Update an agent](/docs/update-an-agent). Your files and login live on the computer, so an update changes Codex, not your work. Hivra does not guarantee backups, so keep copies of anything you cannot lose.",
      ],
    },
    {
      heading: "When something goes wrong",
      paragraphs: [
        "| What you see | What to do |\n| --- | --- |\n| Settings shows \"Not signed in yet: open Chat to sign in\" | Open Chat and finish the ChatGPT sign-in above. |\n| Codex stops answering or says you need to sign in | Open **Settings**, **Overview**, press **Sign in again**, and sign in to the same ChatGPT account. Your files and chats stay as they are. Press \"I've entered the code\" after you authorize, then send a message to check. |\n| The screen says \"Hivra hasn't seen the sign-in yet.\" | Finish the code step on the ChatGPT page, then press **Check again**. |\n| A message fails after you set a custom model | Your account may not have access to it. Choose Default in the Model card. |\n| \"Add credit to start chatting.\" | Press **Add credit**, or choose a sign-in or Venice key launch. |\n| \"Venice doesn't accept this key. Check it and try again.\" | Create a new key in your Venice settings and paste it again. |\n| \"Needs a connection service update (see Updates)\" | Open Updates and update the connection service. The computer keeps running. You can still sign in with the Codex session tab in the meantime. |\n| \"Start this agent to check or update Codex.\" | The computer is stopped. Press Start under Power first. |\n| On a server you connected: \"This server hasn't said it can take a model key safely yet. Update it in Capacity, or choose another option.\" | Update the server in Capacity, or choose a sign-in launch. |\n| Hivra cannot reach the computer | Restart it from Power. See [Troubleshooting](/docs/troubleshooting). |",
        "If the agent is unreachable and a restart does not help, **Force restart** under Advanced is the next step. If an update left Chat broken, Recovery lists restore points where the computer keeps them.",
      ],
    },
    {
      heading: "A first long run, end to end",
      paragraphs: [
        "1. Open the agent, then the **Terminal** tab.",
        "2. Run `tmux new -s codex`, then `codex`, and give it the task.",
        "3. Detach with Ctrl-b then d. Close the tab or the laptop.",
        "4. Later, open **Terminal** again and run `tmux attach -t codex`.",
        "For what Hivra does and does not promise, see [Security and access](/docs/security-and-access), [Plans and billing](/docs/plans-and-billing) and [Models and credits](/docs/models-and-credits).",
      ],
    },
  ],
  faqs: [
    {
      q: "Can I use my ChatGPT subscription with Codex on Hivra?",
      a: "Where available, with an eligible account, subject to OpenAI's terms. You choose Sign in with my existing account at launch and sign in inside Codex after it opens. OpenAI bills that usage under your own plan, not Hivra credits.",
    },
    {
      q: "Can I paste an OpenAI API key at launch?",
      a: "No. The own API key option at launch takes a Venice key for Codex. An OpenAI key is something you would set up inside Codex itself, where Codex allows it.",
    },
    {
      q: "What does Codex start on when I use credits or a Venice key?",
      a: "DeepSeek V4.1 Flash, unless you pick another model from the Model list at launch. You can change it later under Settings, in Model & tools, in the Inference card.",
    },
    {
      q: "Does Codex keep working when I close my laptop?",
      a: "A run you start inside tmux in the Terminal tab keeps going on a paid Hivra computer. Hivra does not promise the same for a run started from Chat or the Codex session tab.",
    },
    {
      q: "Which features are Claude Code only?",
      a: "Hivra only documents Telegram for Claude Code, and Ask me first is Claude Code only. Codex does have the Browser, Files, Terminal and Skills views.",
    },
    {
      q: "How do I update Codex?",
      a: "Open Settings, then Updates, and press Update Codex. Hivra moves it to the version it has tested, and sessions already open keep the previous version until you close them.",
    },
    {
      q: "Can Codex run on my own server?",
      a: "Yes, on a Proxmox VE server you connected. Your account must be eligible to connect the server. If you use credits there, the server needs to report that it can take a model key safely.",
    },
  ],
  articles: ["run-codex-24-7-in-the-cloud", "codex-pricing-by-chatgpt-plan"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent", "troubleshooting"],
};
