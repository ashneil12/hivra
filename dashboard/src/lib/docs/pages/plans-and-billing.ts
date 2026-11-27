import type { DocPage } from "../types";
import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  CONNECTED_SERVER_ELIGIBILITY,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";

export const doc: DocPage = {
  slug: "plans-and-billing",
  section: "start",
  title: "What you pay for",
  metaTitle: "Hivra plans and billing: what you pay for",
  metaDescription: "How Hivra charges for hosted computers, how plans work and what you pay separately for model usage.",
  summary: "You pay for the computer when Hivra Cloud runs it, and for model usage when you use Hivra credits.",
  lastReviewed: "2026-11-17",
  blocks: [
    {
      heading: "Three separate things you can pay for",
      paragraphs: [
        "Hivra bills three different things, and they are easy to mix up. Knowing which is which makes the Plan & billing page much easier to read.",
        "| What | What it pays for | Where you manage it |\n| --- | --- | --- |\n| Your account | Signing in and using Launch. | Settings |\n| A plan | The computer itself when Hivra Cloud runs it: processor, memory and storage. | Plan & billing, Plans view |\n| Model usage | The AI model your agent thinks with, when you use Hivra credits. | Plan & billing, Credits view |",
        "A plan does not pay for model usage, and credits do not pay for a computer. If you bring your own model key, the provider bills you directly and Hivra credits are not involved at all.",
        `A paid plan is the standard way to use Hivra Cloud. See [pricing](/pricing) for managed hosting options. ${CONNECTED_SERVER_ELIGIBILITY}`,
      ],
    },
    {
      heading: "Before you start",
      paragraphs: [
        "You need a Hivra account to see any of this. Open **Billing** in the dashboard sidebar (or **Plan and billing** in Settings). The page it opens is titled \"Plan & billing\" and the line under it reads \"Your plan, how you pay, and what you've used.\" A self-hosted installation of Hivra hides Billing.",
        "- A card, if you want Hivra Cloud to run a computer or you want to top up model credits. Plan and credit payments go through a hosted checkout, so you never type card details into Hivra itself.\n- A compatible server and an account eligible to connect it, if you want to [run agents on your own server](/docs/connect-your-own-server).\n- A decision about the model: Hivra credits, your own key, or an account you already have. [Choose how your agent gets its model](/docs/models-and-credits) lists what each agent supports.",
        "By default the page opens on **Overview** if you have a plan (or a plan on hold) and on **Plans** if you do not. Links from Launch or from a paywall open **Plans**.",
      ],
    },
    {
      heading: "The Plan & billing page at a glance",
      paragraphs: [
        "The page has up to five tabs. The row of tabs is labelled \"Billing sections\".",
        "| Tab | What you do there |\n| --- | --- |\n| **Overview** | See your current plan, how much of it your computers use, and your credit balances. Change plan, manage your payment method, refresh usage or cancel. |\n| **Plans** | Compare the sizes and subscribe, upgrade or switch. |\n| **Payment methods** | See how your plan is paid. A card plan says Stripe keeps your card on file and has an **Open billing portal** button to update the card, download invoices or cancel. App Store plans show **Manage in the App Store**. If there is no card on file, the panel says so. Optional token payment sections appear only where enabled. |\n| **Credits** | Top up and watch your account credits and model credits. |\n| **History** | Recent account movement: ledger, payments, compute, LLM and managed Venice usage. |",
        "Which credit tabs appear depends on the deployment. The **Credits** tab shows when billing v2 or crypto billing is on, and **History** and the Model credits panel need billing v2. The card top-up buttons need a separate top-ups setting, so a deployment can show Credits with no top-up buttons, which means it does not offer card top-ups. If you do not see a tab, that deployment does not offer it.",
        "![The Overview view of Plan & billing with a current plan, usage bars for vCPU and memory, and credit cards](/images/docs/dash-billing-overview.webp \"Overview view with sample data: the current plan, how much vCPU and memory your computers use, the Change plan and Manage payment method buttons, the credit tiles below, and an optional backup add-on panel. Backups are not guaranteed, so keep your own copies.\")",
      ],
    },
    {
      heading: "Choose and start a plan",
      paragraphs: [
        `Paid plans include compute. There are two sizes on sale: ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, and ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}. Where sleep is enabled, an eligible paid KVM agent can [sleep when idle](/docs/open-an-agent). Paid access does not require turning it on.`,
        "1. Open **Billing** and go to the **Plans** view. With no plan yet, the heading reads \"Choose a plan\".\n2. Read the cards. Each one shows vCPU, memory, how many agents and computers it covers, and its idle behaviour. The card for your current plan is marked \"Current plan\".\n3. If a **Billing** control with **Monthly** and **Yearly** is shown, pick one. A saving chip such as \"Save up to N% yearly\" appears beside it when yearly is cheaper than twelve monthly payments. The control only appears when your choice will go through checkout.\n4. Press **Subscribe** on the card with 2 vCPU and 4 GB (the $9.99 a month one) or the card with 4 vCPU and 8 GB ($19.99 a month). The button reads \"Subscribe\" followed by the price.\n5. Complete the hosted checkout. When you return, the page shows \"Activating your subscription...\" while Hivra confirms the payment. You then land back where you started, or on Launch if you came to Plan & billing directly. Open Billing again to see Overview.",
        "If you arrived from Launch, a **Back to your launch** link at the top returns you to where you were, with your choices kept. After checkout the redirect back happens automatically.",
        "A server you connect uses your own capacity, not Hivra Cloud compute. Your account must be eligible to connect the server.",
        "![An example of the Plans view with plan sizes and idle behaviour](/images/docs/dash-billing-plans.webp \"This example includes the Free card. It may not be available to a new account. Check Billing for your current options.\")",
        "Under the cards, a strip titled \"Bigger machines are planned\" is tagged \"Planned, not available to buy yet\". Treat those as a roadmap, not an option.",
      ],
    },
    {
      heading: "Read your usage on Overview",
      paragraphs: [
        "The top panel of **Overview** is headed \"Current plan\" and shows how the plan is billed (for example \"Billed by card\" with the date the current billing period ends) and an **Active** tag.",
        "- **Slots, vCPU and Memory** are what your plan allows in total. **Idle policy** reads \"Always on\" for a paid plan.\n- **Agents & computers** shows how many of your allowed places are in use.\n- The **vCPU** and **Memory** bars show how much of the plan's processor and memory your computers have been given, for example \"2 of 4 vCPU allocated\". This is what you have allocated, not live load.\n- The round **refresh** button next to the plan buttons (\"Refresh usage\") reads the numbers again.",
        "For how busy one particular computer is right now, open that agent, go to **Settings**, and look at the Usage card on the Overview section. It reads the computer's own CPU, memory and disk, and it says plainly when its host cannot be reached.",
        "Below the plan panel, up to two tiles show your balances. **Credits** is the account credit count, and **Model credits** is a dollar amount \"available for managed models\". Press either tile to jump to the **Credits** view. The tiles depend on deployment settings: Credits needs billing v2, and Model credits also needs the managed Venice summary to load, so either can be missing.",
      ],
    },
    {
      heading: "Change, switch or cancel a plan",
      paragraphs: [
        "**Move to a larger size.** On **Overview** press **Change plan**, or go straight to **Plans**, and press **Upgrade to** the larger size. A dialog asks you to confirm. Depending on how your subscription is set up it is titled either \"Confirm Upgrade\" or \"Open Secure Checkout\":",
        "- **Confirm Upgrade** changes the subscription in place. The new limits apply right away, and the price difference for the rest of the billing period is added to your next invoice. Plan changes made this way move your subscription to monthly billing. A yearly plan is invoiced today instead, with credit for its unused time.\n- **Open Secure Checkout** is used when the change has to go through the payment provider's checkout. Your current access stays active while checkout is pending, and the new plan access starts once checkout completes.",
        "**Move to a smaller size.** Going down is not self-serve everywhere. Where it is not turned on, the card says \"Moving to a smaller plan isn't self-serve yet\". Where it is, the button reads **Switch to** the smaller size and the dialog offers **Keep** your current plan or confirm. The dialog is titled \"Switch to\" the smaller size and lists what you give up. If you have more agents and computers than the smaller size holds, it warns you, and you should remove some before you launch another. It also has a proration credit note: Stripe credits unused time to your account for later invoices, not back to your card. Nothing is stopped or removed for you.",
        "**Cancel.** On **Overview** press **Cancel subscription** (card plans only). A dialog asks \"What's making you cancel?\" with choices such as \"It's too expensive\" and \"I'm not using it\". Pick a reason or skip it. Some reasons show one suggestion that opens an email to support, and choosing \"Something else\" adds an optional text box. Press \"Never mind, keep my plan\" or close the dialog to keep your plan. **Cancel anyway** opens the billing portal, where the cancellation is completed. Your chosen reason is recorded when you press **Cancel anyway** or use a suggestion. App Store plans are cancelled in the App Store.",
        "When a plan ends, Hivra stops running your Hivra Cloud computers. Their files are kept, and Hivra emails you before anything is deleted. To carry on later, choose a plan again and press **Start** on the computer.",
        "**Payment method.** The **Manage payment method** button opens the billing portal, where you update your card or pick up an invoice. Card buttons appear only for card plans. If your plan is billed through the App Store, plan changes and cancellation happen there and the page shows **Manage in the App Store** instead.",
        "You may see a backup add-on on Overview. Backups are not guaranteed, so keep your own copies.",
      ],
    },
    {
      heading: "If you change your mind",
      paragraphs: [
        `Paid plans come with a ${MONEY_BACK_GUARANTEE}. A footnote at the bottom of the Plans view repeats it.`,
        "The limit matters: it covers card payments only. It applies to the plan, not to model credits you have already spent. To ask for a refund, open **Help** in the sidebar and press **Email support**. Say which payment you mean and include what you were trying to do. Do not include passwords or API keys. There is no self-serve refund button.",
      ],
    },
    {
      heading: "Model usage and Hivra credits",
      paragraphs: [
        "Launch asks \"How would you like to connect your agent to AI?\" and shows only the choices that agent supports. Only one of them involves Hivra credits.",
        "| Choice at Launch | Who bills the model |\n| --- | --- |\n| **Hivra credits** | You pay from your credit balance at provider rates. Credits reach models through Venice. |\n| **Use my own API key** | The provider bills you directly. Hivra credits are not used. For some agents the own-key choice takes a Venice API key only, and Venice bills the usage. |\n| **Sign in with my existing account** | The account you sign in with, under its own terms. |",
        "Hivra credits are the default wherever an agent supports them. If your balance is empty, the credits choice reads \"Add credit to start chatting\" and an **Add credit** button appears beside it. If your balance cannot be read, the choice says \"Couldn't check your balance\", which is not the same as zero. A self-hosted installation of Hivra does not offer credits at all.",
        "On the Review step the **Cost** line shows how the launch is paid. On Hivra Cloud it reads \"No extra charge. Uses your Hivra Cloud plan allowance.\", where the plan name replaces Hivra Cloud if it differs, followed by a note about how model usage is paid. While the plan is on hold, the line says the allowance applies once the plan is active again. On a server you connected it reads \"No charge from Hivra. It uses your server's own capacity.\"",
        "### Two kinds of credit",
        "The **Credits** view shows two balances, and they are different.\n\n- **Credits.** An account credit count with top-up buttons: $5 adds 500, $10 adds 1,000, $25 adds 2,500 and $50 adds 5,000. The page notes that these pay for usage and do not set your plan. This page gives no rate between credits and dollars.\n- **Model credits.** A prepaid balance for models you run through Hivra's managed Venice access. It is split into \"Card credits\" with an \"available\" and a \"reserved\" amount. The two balances are separate and the Credits count does not convert to Model credits.",
        "### Top up model credits by card",
        "1. Open **Billing**, then **Credits**, and find the **Model credits** panel.\n2. Press **Top up by card**. A dialog opens.\n3. Set the **Top-up amount** with the box or the slider. The minimum is $10 and the slider runs to $500. The dialog shows how much model credit your payment adds, under a callout headed \"Card terms\".\n4. Press **Start card checkout** and finish in the hosted checkout.\n5. Come back to the Credits view. The balance updates once the payment is confirmed.",
        "Below the balances, the heading **API access**, under the label \"Keys your agents use for model credits\", lists the keys Hivra created for your agents. A new key is shown once, with a **Copy key** button, so store it before leaving the page. Revoked keys are hidden behind a \"Show N revoked keys\" button, where N is the count.",
        "If you would rather use your own Venice key, the **Switch off managed Venice** panel lets you paste it for an agent and press **Switch to my key**. The agent then restarts on your key on its next request. Using another provider such as OpenAI or Anthropic is done inside the agent's own settings where it allows that.",
        "Some tabs and panels also mention optional token payments. They appear only where that is enabled and are not needed to use Hivra, so this page does not cover them.",
      ],
    },
    {
      heading: "Review what you spent",
      paragraphs: [
        "The **History** view lists recent account movement in five groups: **Ledger**, **Payments**, **Compute**, **LLM** and **Managed Venice** (model credit usage, which links to the full list). Each shows its own empty message until there is something to list, such as \"No payments yet.\" or \"No managed Venice usage yet.\". History appears only with billing v2. **View all activity** opens the full list.",
        "A practical routine for a power user: check **Credits** before a long run, glance at **Model credits** on Overview after one, and use **History** when a number surprises you.",
      ],
    },
    {
      heading: "When something goes wrong",
      paragraphs: [
        "| What you see | What it means and what to do |\n| --- | --- |\n| \"Payment due\" on the plan panel | A card payment failed. Computers keep running for up to 48 hours. Pay the open invoice or update your card with **Manage payment method** before then. |\n| \"Hivra Cloud plan on hold\" on Overview | The 48 hours passed without payment. The plan is on hold and your Hivra Cloud computers are stopped, with files kept. Pay the open invoice or update your card with **Open billing portal**, then press **Start** on each computer. |\n| \"Plan change didn't go through\" | The change was refused and the reason is in the message. Fix it, such as removing agents or computers the new size cannot hold, or settle an open invoice, and try again. Press **Dismiss** to clear it. |\n| \"Checkout not confirmed\" | Hivra could not confirm the payment after you returned. Use the report link in the alert and include the message. Refresh the page first, since confirmation can lag. |\n| \"Activating your subscription...\" stays on screen | Confirmation is still running. Wait, then refresh. If it never finishes, report it. |\n| The credits choice says \"Add credit to start chatting\" | Your balance is empty. Press **Add credit**, or pick your own key or sign-in where the agent allows it. |\n| \"Switch failed. Confirm your Venice API key and try again.\" | Venice rejected the key you pasted. Copy it again from your Venice settings. |\n| A card says \"Moving to a smaller plan isn't self-serve yet\" | Going down is not available for your account right now. Cancel and choose again, or open Help and press Email support. |\n| No **Credits** or **History** view | That deployment does not have those tabs turned on. |",
        "If a computer still looks stopped after you settled a plan, open it and press **Start**. Stopping on a lapsed plan is not the same as deleting it.",
      ],
    },
    {
      heading: "What Hivra does and does not do",
      paragraphs: [
        "- A paid plan covers the computer. It does not cover model usage.\n- Hivra does not run a free computer. You can use your own server if your account is eligible to connect it.\n- Hivra does not guarantee backups of what is on a computer. Keep your own copies of anything you cannot lose.\n- Bigger machines are shown as planned, and you cannot buy them yet.\n- Your own server is your hardware and your bill. The paid plan is for computers Hivra Cloud runs.",
        "For the raw price comparison against self-hosting, see the [pricing page](/pricing).",
      ],
    },
  ],
  faqs: [
    {
      q: "What can I choose if Free is closed to new accounts?",
      a: "When Free is closed, existing Free accounts keep their access. New accounts need a plan or an eligible trial to launch a computer or connect a server. Check the pricing page for the options currently offered.",
    },
    {
      q: "How does the Pro trial work if I am offered one?",
      a: "The trial lasts seven days and requires a card. It includes one agent, a total of 1 vCPU and 2 GB of RAM, idle sleep, and $1 in starter model credits. If you keep the subscription, the card is charged when the trial ends. In Billing you can choose Upgrade to full Pro now to end the trial and pay immediately.",
    },
    {
      q: "What does a Hivra plan cover?",
      a: "A hosting plan covers the computers Hivra Cloud runs for you. A server you connect uses your capacity, and your account must be eligible to connect it.",
    },
    {
      q: "Does the plan include the AI model?",
      a: "No. A plan pays for the computer. Model usage is paid from Hivra credits, by your own key with the provider, or by an account you already have, depending on the agent.",
    },
    {
      q: "Can I get my money back?",
      a: "Paid plans come with a 7-day money-back guarantee on card payments. It covers card payments only. To ask, open Help in the sidebar, press Email support and say which payment you mean. Do not include passwords or API keys.",
    },
    {
      q: "What happens to my computer if I cancel?",
      a: "Hivra stops running your Hivra Cloud computers when the plan ends. Their files are kept and Hivra emails you before anything is deleted. Choose a plan again and press Start to carry on. Hivra does not guarantee backups, so keep your own copies of anything important.",
    },
    {
      q: "Can I move to a smaller size?",
      a: "Not always. Where self-serve downgrades are not turned on, the card says moving to a smaller plan is not self-serve yet.",
    },
    {
      q: "What is the difference between Credits and Model credits?",
      a: "Credits are an account credit count with top-up buttons. Model credits are a prepaid dollar balance for models you run through Hivra's managed Venice access, topped up by card with a minimum of 10 dollars.",
    },
    {
      q: "Why can I not see a Credits view?",
      a: "The Credits and History tabs depend on deployment settings and can be missing. If they are missing, use your own key or an account you already have for the model.",
    },
  ],
  articles: ["cost-of-running-ai-agent", "byo-api-key-explained"],
  next: ["models-and-credits", "connect-your-own-server", "getting-started"],
};
