import type { DocPage } from "../types";
import { HOSTED_COMPUTE_NEEDS_PLAN } from "@/lib/blog/plan-facts";

export const doc: DocPage = {
  slug: "openbot",
  section: "agents",
  title: "OpenBot on Hivra (preview)",
  metaTitle: "OpenBot on Hivra (preview)",
  metaDescription: "OpenBot from CopilotKit is in preview on Hivra and not in the Launch list yet. What it needs, how it would run, how updates and rollback work.",
  summary: "OpenBot is CopilotKit's agent workspace. It is in preview on Hivra, off by default, and not launchable until a deployment turns it on.",
  lastReviewed: "2026-11-17",
  status: "preview",
  blocks: [
    {
      heading: "Preview status, in plain terms",
      paragraphs: [
        "OpenBot on Hivra is a **preview**, and it is **off by default**. It is not in the Launch list, so you cannot pick it on the Launch screen today. It only appears there on a deployment where Hivra has switched it on.",
        "This page describes what OpenBot on Hivra is built to do, so you know what to expect and what to prepare. Read it as a description of a feature that is behind a switch, not as steps you can follow right now. If you need an agent you can launch today, the supported agents in the Launch list are the ones to use. The [agents page](/agents) shows them.",
        "| Question | Answer today |\n| --- | --- |\n| Is it in the Launch list? | No. It is hidden until the deployment enables it. |\n| Where is it supported? | On a Hivra Cloud computer. A server you connected yourself is not a supported place for OpenBot. |\n| Does it need a paid plan? | Yes, because it runs on a Hivra Cloud computer. |\n| Does it need anything from CopilotKit? | Yes, an Intelligence key. |\n| Is it Hivra's own agent? | No. It is CopilotKit's software, run as CopilotKit ships it. |",
        "Hivra checks the preview against the provisioner, the part of Hivra that sets up each computer. It needs provisioner release 2026.11.12.4 or later, which is part of why it stays switched off until a deployment is ready for it.",
      ],
    },
    {
      heading: "What OpenBot is, and who it suits",
      paragraphs: [
        "OpenBot is CopilotKit's open-source set of AI coworkers. Instead of one assistant in one chat window, you work in OpenBot's own workspace with coworkers that each have a browser and files of their own. CopilotKit is the team behind the CopilotKit toolkit for building agent-powered applications. OpenBot is released under the MIT licence.",
        "There is another app that goes by the name OpenBot, from Nightly Labs. It is not the one on this page, and Hivra does not offer it, because its licence does not allow a paid host.",
        "Hivra gives each agent a computer of its own, so a coworker's downloads, logins and half-finished work stay off your laptop. That is the reason to host OpenBot rather than run it beside your own files. It suits developers and AI power users who like delegating several jobs at once and want a workspace for it. It is a young project, and the preview label reflects that.",
        "Hivra is an independent hosting service and is not affiliated with or endorsed by CopilotKit. OpenBot is their software. For their features, limits and licence, use CopilotKit's own pages.",
      ],
    },
    {
      heading: "What it needs before you open it",
      paragraphs: [
        "- **A Hivra Cloud computer on a paid plan.** " + HOSTED_COMPUTE_NEEDS_PLAN,
        "- **At least 1 vCPU and 3 GB of RAM.** That is the floor Hivra enforces for OpenBot. See the sizing section below.",
        "- **A CopilotKit Intelligence key.** OpenBot will not start without one. It keeps its conversations and memory in CopilotKit Intelligence, so it needs a key from your CopilotKit project. At the time of writing CopilotKit has a free plan, so getting a key does not mean paying CopilotKit first. Plans and limits are theirs to set and can change, so check CopilotKit's pricing page.",
        "- **A way to pay for model use.** By default models run through Venice on your Hivra credits, which you top up in Hivra. You can switch provider inside OpenBot afterwards. See [models and credits](/docs/models-and-credits).",
        "Three separate things can cost money, and it helps to keep them apart: the Hivra Cloud computer (a paid plan), model usage (Hivra credits, or your own provider's bill if you switch), and your CopilotKit plan. Coworkers that browse and work in loops use more model time than one chat, so start with a small job.",
      ],
    },
    {
      heading: "How it would run on Hivra",
      paragraphs: [
        "Hivra runs CopilotKit's official OpenBot image, from `ghcr.io/copilotkit/openbot`, unmodified. When the computer is set up it pulls the latest release, records that exact image by digest, and runs it on the computer's own loopback in OpenBot's single-user mode, with its own embedded database. Nothing about OpenBot is rebuilt or patched by Hivra.",
        "OpenBot's workspace is then served at the root of the computer's address, behind your Hivra sign-in. The workspace is reached only through Hivra's authenticated gateway.",
        "| Part | How it works |\n| --- | --- |\n| Software | CopilotKit's official OpenBot image, the latest release at install time |\n| Where it listens | The computer's loopback, on port 3101, never directly on the internet |\n| How you reach it | Hivra's authenticated gateway, with the workspace at the computer's root and `/openbot/` as the entry path |\n| Browser | OpenBot brings its own. Hivra's separate browser stack is not used, so there is no Browser tab and no browser toggle at launch |\n| Version | Hivra does not choose a tested version for you. The computer runs the exact image it pulled at install or at the last update, recorded by digest. Update installs the newest release |\n| Where the key lives | On the computer only, in a file only its owner can read |",
        "Hivra Cloud is the supported place for OpenBot. Run it on a connected server at your own risk, because that is not something Hivra supports.",
      ],
    },
    {
      heading: "If it is enabled: launching it",
      paragraphs: [
        "These are the steps on a deployment where the switch is on. If you do not see an OpenBot tile on the Launch screen, it is off for you and none of this applies yet.",
        "1. Open **Launch** from the dashboard.\n2. On the **Choose** step, pick the **OpenBot** tile: \"CopilotKit's open-source AI coworkers, in OpenBot's own workspace.\"\n3. On the review step, name the agent and check **Where it runs**. Hivra Cloud is the supported place for OpenBot.\n4. Pick a **Size** (below).\n5. Pick how it gets its model. For OpenBot there are two choices. **Set up inside OpenBot after it opens** is described as \"Choose a model provider in OpenBot's own settings\". The other is **Hivra credits**. With credits, the screen notes that models come from Venice through Hivra, so you do not need a Venice account, and that you can change the provider later in OpenBot's own settings.\n6. Press **Launch**.",
        "OpenBot does not offer the sign-in-with-your-own-account or paste-your-own-API-key choices that Codex does. Those are not listed for it.",
        "For the general launch flow, which is the same screen for every agent, see [launch your first agent](/docs/getting-started).",
      ],
    },
    {
      heading: "The first open: the key page",
      paragraphs: [
        "OpenBot cannot start without its key, so the first time you open the agent you get a one-step page instead of the workspace. This is what you will see and do:",
        "1. Open the agent from your dashboard. The agent page shows a **Dashboard** tab that holds OpenBot's own workspace. The tabs are grouped, and the settings area is labelled **Manage** on the agent page and may appear as Settings in the sidebar.\n2. The page titled **One step before OpenBot starts** explains that OpenBot needs a key from your CopilotKit project.\n3. In a new tab, sign in at intelligence.copilotkit.ai, open your project's **API Keys** and copy the key that starts with `cpk-`.\n4. Paste it into the password field labelled **CopilotKit Intelligence key** and press **Start OpenBot**.\n5. Hivra saves the key on the computer and starts OpenBot. A **Starting OpenBot** page appears and refreshes itself. The first start sets up OpenBot's database, and the page refreshes itself until OpenBot answers. When OpenBot answers, the page sends you into the workspace.",
        "What Hivra does with the key: it is saved on the computer only, in a file readable only by its owner, and handed to the OpenBot container through an environment file rather than on a command line. The page rejects anything that is not a plain key, for example text with line breaks, so a pasted value cannot add extra settings.",
        "To replace the key later, open the `/openbot/setup` path on the computer's address through the same Hivra sign-in. That page always shows the form, even when a key is already saved. Saving a new key restarts OpenBot.",
      ],
    },
    {
      heading: "Sizing",
      paragraphs: [
        "OpenBot runs at a fixed size. It is launched at a fixed size, without the flexible, burstable sizing some agents get. The smallest size Hivra allows is 1 vCPU and 3 GB of RAM, because that is OpenBot's floor.",
        "| Preset | vCPU | RAM | Note |\n| --- | --- | --- | --- |\n| Small | 1 | 3 GB | OpenBot's minimum |\n| Medium | 2 | 4 GB | The size Hivra recommends |\n| Large | 4 | 8 GB | For heavier work |",
        "The custom size options are 1, 2, 4 or 8 vCPU and 3, 4, 8 or 16 GB of RAM. Medium is the size Hivra recommends, so start there and look at usage in the Overview section of Manage before changing it. As a suggestion, since OpenBot runs its own database and browser, Small leaves little headroom.",
      ],
    },
    {
      heading: "Updating, with rollback",
      paragraphs: [
        "OpenBot is the official release from CopilotKit. Hivra does not change it and does not choose a tested version, so there is no \"tested version\" to compare against. Update installs the newest release.",
        "1. Open the agent and go to its **Manage** tab, then the **Updates** section.\n2. Find the OpenBot card. It shows **OpenBot installed**, and **Last checked** with a **Check again** link while the agent is running. The agent must be running: when it is stopped the card says to start the agent to check or update. If the card says the agent's connection service is older, update the connection service first, because **Update OpenBot** stays disabled until then.\n3. Press **Update OpenBot**. The same card reports progress.",
        "While it works, the card text changes as the update moves along:",
        "- It starts with \"Starting the update…\". The new image is pulled while the current OpenBot keeps running. If the pulled image is the one already running, nothing is changed and the card shows the current version.\n- While it waits, the card says \"Waiting until nobody is using OpenBot\". The update waits until nobody has used OpenBot through Hivra for 5 minutes, so close it in any other tab. Hivra waits up to 6 hours. If it is still in use after that, nothing is changed and you can press **Try again**.\n- While OpenBot restarts, the card says it is being updated and is back in a few minutes. The same card line covers downloading and installing.\n- Last, the card says \"Checking the new version…\" while Hivra confirms the new release answers.",
        "**The rollback.** Before swapping, the update copies OpenBot's database aside. If the new release does not answer after it starts, Hivra puts the previous image and that database back, so the workspace you had keeps working. What the new release wrote is kept aside on the computer, not deleted. If the new release starts fine, the safety copy is dropped.",
        "Two things the rollback is not. It covers the update step only, as a protection against a bad release. It is not a backup service: Hivra does not promise backups of your files, so keep copies of anything you cannot recreate. And if the previous version cannot be restored either, the card reports that the update did not finish and a recovery button appears. OpenBot may not open until that is fixed.",
        "If OpenBot is still waiting for its Intelligence key, an update only records the new image. It does not restart anything.",
        "The **Update automatically** toggle appears only on computers where Hivra has enabled automatic updates. When a release rolls back, the card shows \"Automatic updates are paused for\" followed by that release. See [update an agent](/docs/update-an-agent) for the general picture.",
      ],
    },
    {
      heading: "When something goes wrong",
      paragraphs: [
        "| Symptom | What it means | What to do |\n| --- | --- | --- |\n| No OpenBot tile on Launch | The deployment has not switched the preview on | Nothing to fix on your side. Use a supported agent in the Launch list for now. |\n| The key page appears every time | No key is saved yet, or the save failed | Paste a key that starts with `cpk-` and press **Start OpenBot**. |\n| The page rejects your key with an error | The value was not a plain key, for example it had a line break | Copy the key again from API Keys, one line, and paste it again. |\n| **Starting OpenBot** keeps refreshing | OpenBot is setting up its database or has not answered yet | Wait. If it never opens, replace the key at `/openbot/setup`, or restart the computer from **Manage**. |\n| You get a sign-in refusal at the computer's address | The request had no valid Hivra sign-in | Open the agent from your Hivra dashboard rather than pasting the address. |\n| Update says it could not download OpenBot | The image pull failed. Nothing was changed. | Press **Try again**. |\n| Update says there is not enough free disk space | The computer's disk is too full, for example to copy the database aside. OpenBot keeps running on the old image. | Free space in **Files** or **Terminal**. This card has no **Try again** button, so press **Update OpenBot** again once the card shows it. |\n| Update says OpenBot was still in use after 6 hours | The idle wait expired. Nothing was changed. | Close other OpenBot tabs, then **Try again**. |\n| The update finished but you are still on the same OpenBot version, and the card shows no error | The new release may not have started and the old one was put back, or the image was already current | Check the version on the card. Your workspace is as before. Press **Update OpenBot** again later, since a newer release may fix it. |",
        "If OpenBot misbehaves inside the workspace itself, for example a coworker fails a task, that is OpenBot's own behaviour. Hivra provides the computer and the sign-in, not OpenBot's internals.",
      ],
    },
    {
      heading: "What Hivra does and does not do",
      paragraphs: [
        "**Hivra does:** run CopilotKit's official image on a computer of its own, serve OpenBot's workspace behind your Hivra sign-in, keep your Intelligence key on that computer, provide models through Venice on Hivra credits by default, and offer an Update button with a rollback for a release that does not start.",
        "**Hivra does not:** modify OpenBot, choose a tested version for it, provide your CopilotKit key or plan, promise backups, or make OpenBot available outside Hivra Cloud. It does not make an agent safe: a separate computer is a boundary, not a guarantee. Credentials you put on the computer are stored there, and Hivra administrators retain infrastructure access on Hivra-managed computers. Use low-stakes work and accounts you can afford to have mistaken actions in. See [security and access](/docs/security-and-access).",
        "Hivra is not affiliated with or endorsed by CopilotKit.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can I launch OpenBot on Hivra today?",
      a: "Not from the Launch list. OpenBot is a preview that is off by default, and it appears on the Launch screen only on a deployment where Hivra has turned it on. If you do not see an OpenBot tile, it is not available to you yet.",
    },
    {
      q: "What do I need to run it?",
      a: "A Hivra Cloud computer on a paid plan with at least 1 vCPU and 3 GB of RAM, and a CopilotKit Intelligence key. At the time of writing CopilotKit has a free plan, so the key does not require paying CopilotKit up front. Check CopilotKit's pricing page for current limits.",
    },
    {
      q: "Where do I get the Intelligence key?",
      a: "Sign in at intelligence.copilotkit.ai, open your project's API Keys and copy the key that starts with cpk-. On the first open, Hivra shows a page where you paste it once.",
    },
    {
      q: "Which models does OpenBot use?",
      a: "By default, models run through Venice on your Hivra credits, so you do not need a Venice account. You can change the provider in OpenBot's own settings. At launch you can also choose to set the model up inside OpenBot after it opens.",
    },
    {
      q: "Can I run OpenBot on my own server?",
      a: "No. OpenBot is offered on Hivra Cloud only. A free Hivra account works with a server you connect yourself, but OpenBot is not one of the agents that can run there.",
    },
    {
      q: "How do I update it, and what if the update breaks it?",
      a: "Open the agent, go to Manage, then Updates, and press Update OpenBot. Hivra pulls the newest release. If the new release does not start, it puts the previous image and database back. That protects the update step only and is not a backup of your files.",
    },
    {
      q: "Is OpenBot the same as the other app called OpenBot?",
      a: "No. This is CopilotKit's OpenBot. A different app from Nightly Labs shares the name, and Hivra does not offer it.",
    },
    {
      q: "Is Hivra affiliated with CopilotKit?",
      a: "No. Hivra is an independent hosting service and is not affiliated with or endorsed by CopilotKit. OpenBot is their software.",
    },
  ],
  articles: ["openbot-ai-coworkers"],
  next: ["models-and-credits", "open-an-agent", "update-an-agent"],
};
