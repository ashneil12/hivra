// English homepage narrative, drawn from the approved Hivra litepaper.
// Keep the visible FAQ and structured data on the same source.
export const AGENT_LAUNCH_HREF = "/dashboard/launch?kind=agent&start=1";
export const COMPUTER_LAUNCH_HREF = "/dashboard/launch?kind=computer&start=1";

export const HOMEPAGE_FAQ = [
  { q: "What is Hivra?", a: "Hivra gives you a separate computer for your work. Start with an agent, or choose an operating system and use the computer yourself. Keep your files, apps and sessions in that workspace, with the access you choose." },
  { q: "Do I have to use an agent?", a: "No. Launch Ubuntu, Windows or Omarchy, install your apps, browse, write code or run services. You can use it as your own computer without attaching an agent." },
  { q: "Which agents can I use?", a: "The lineup includes Claude Code, Codex, Hermes, Agent Zero and DeepSeek, alongside OpenClaw and Aeon. Open the agent catalog to choose a runtime and see its setup options." },
  { q: "Do I have to work in a terminal?", a: "It's up to you. Run a terminal agent through an interface, work directly in its terminal, or move between the two. Agents that come with their own interface keep it." },
  { q: "Can I bring my own model key or account?", a: "Yes. Connect the API key or supported account your agent uses. Your model connection is separate from where the computer runs, so choosing Hivra Cloud doesn't take that choice away." },
  { q: "Where can my computer run?", a: "Choose Hivra Cloud if you want us handling the machines, updates, monitoring and recovery. Connect your own cloud account or server to use capacity you already have. The launch flow shows the options for the computer you've chosen." },
  { q: "Can I self-host without a Hivra account?", a: "Yes. Self-host the platform on your hardware with your own sign-in. You don't need a Hivra account. Self-hosting needs no token." },
  { q: "What happens when I close my browser?", a: "Closing the browser disconnects your view. It doesn't throw the workspace away. Reconnect from another device and return to your files, tools and settings. Your server keeps its own files and settings until you choose to remove them." },
  { q: "Can I see everything an agent does?", a: "Hivra collects the activity it can observe, including commands and actions running through its own tools. Work done entirely inside an external app may not appear there. You can also open the computer and terminal to inspect the work yourself." },
  { q: "Do I need the token?", a: "No. Card works everywhere, and self-hosting needs neither a token nor an account." },
  { q: "How many agents can I run?", a: "As many as fit. We sell you a computer, not a headcount." },
  { q: "Why not just rent a server?", a: "You could. It'd be cheaper and you'd spend a weekend setting it up, then an hour a month keeping it alive. Some people enjoy that. If you're one of them, go and enjoy it." },
  { q: "What happens if my agent crashes?", a: "It comes back up on its own. Backups run nightly, so the worst day you can have is losing today." },
  { q: "Can I move between plans?", a: "Up or down, whenever, no conversation required." },
  { q: "What's coming next?", a: "Hivra Orchestrator will bring your agents into one place to talk, follow their work and hand tasks between them. More agents, macOS and custom images are also coming. Gate, Exchange, Arena and Signal are the next pieces we're building around Agent Computers." },
] as const;

export const HOMEPAGE_FEATURES = [
  { headline: "Come back to your workspace", body: "Files, tools and settings stay. Close the browser, open it from another device, and pick up where you left off." },
  { headline: "Use the computer yourself", body: "Open the desktop and work in your apps. Keep your development tools, browser sessions or a project workspace away from your personal computer." },
  { headline: "Pick your interface", body: "Use an agent's interface, its terminal, or both. Agents with their own interface keep it. You choose how you work." },
  { headline: "Take the screen back", body: "Check the files and results, open the terminal, or work directly in the desktop whenever you'd rather do it yourself." },
  { headline: "Keep several running", body: "One agent building a feature. One chasing a bug. One working through research. Open the conversation and computer behind each project." },
  { headline: "Follow the work", body: "Review the commands and actions Hivra can observe. Activity entirely inside an external app may not appear in that history; the computer and terminal are still there to inspect." },
] as const;

export const HOMEPAGE_STEPS = [
  { step: "1", headline: "Pick an agent or an operating system", body: "Choose the agent you want to work with, or start with Ubuntu, Windows or Omarchy. A computer doesn't need an agent." },
  { step: "2", headline: "Pick where it runs", body: "Use Hivra Cloud, connect your own cloud account or server, or run the platform yourself." },
  { step: "3", headline: "See the price, the resources and the access", body: "Review the compute, what it costs, where it runs and what it can reach before you launch." },
  { step: "4", headline: "Open it and start working", body: "Connect the account or key your agent uses, open your interface and get to work. Or use the computer yourself." },
] as const;

export const HOMEPAGE_USE_CASES = [
  { headline: "Give a project its own workspace", body: "Keep its code, dependencies, tools and browser sessions together. Come back to the same environment when the next job arrives." },
  { headline: "Use the app you need", body: "Need Windows for one application? Want development tools off your everyday desktop? Open another computer and make it yours." },
  { headline: "Let an agent work beside you", body: "Have it build a feature, investigate a bug or work through research. Check the results and take over in the same workspace." },
  { headline: "Pick it up from your phone", body: "Open the computer from another device to check the work, find a file or make a quick change. Your workspace stays where it is." },
] as const;

export const HOMEPAGE_UPCOMING = [
  { title: "Hivra Orchestrator", stage: "Coming", body: "One place to talk to your agents, see who's working and who's stuck, and pass work between them." },
  { title: "macOS", stage: "Coming", body: "For the jobs that need a Mac." },
  { title: "Custom images", stage: "Coming", body: "Start a computer from the setup you've already built." },
] as const;
