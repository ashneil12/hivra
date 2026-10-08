import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "ai-agent-dies-terminal-closes-fixes",
  title: "Why your AI agent dies when you close the terminal (and every fix that works)",
  metaTitle: "Why your AI agent dies when the terminal closes",
  metaDescription:
    "Your AI agent dies when you close the terminal or drop SSH (SIGHUP), and a sleeping laptop suspends it. What fixes it: tmux, nohup, systemd, caffeinate.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-30",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "Close the terminal and your shell takes the agent down with it.",
  intro:
    `Claude Code, Codex, OpenClaw, Hermes: every terminal AI agent dies when you close the terminal and stalls when the laptop sleeps. The fixes run from a 90 second tmux setup up to systemd, and past those there's an always-on computer at ${ENTRY_PLAN_PRICE}/month.`,
  shortAnswer:
    "Your agent is a child process of your shell. Close the terminal or drop SSH and it gets a SIGHUP, and a sleeping laptop suspends it. tmux, screen, nohup or systemd detach it from your session, which handles the hangup. Sleep is a separate problem: keep the machine awake, or move the agent to an always-on machine.",
  sections: [
    {
      heading: "Why the process dies in the first place",
      paragraphs: [
        "Terminal AI agents are ordinary child processes of your shell. That one fact explains almost every dead session, and it shows up three ways.\n\nThe one people blame on the agent most is closing the terminal. When a terminal window closes, the kernel sends SIGHUP (hangup) to every process in that session, and the agent exits mid-task. That's how Unix has behaved for 50 years, so it isn't a bug in the agent.\n\nA dropped SSH connection does the same thing on a remote server. The connection tears down the remote shell, which sends the same SIGHUP to the agent. Flaky wifi, a VPN hiccup or your ISP renegotiating is enough.\n\nSleep is the third, and it works differently. Close the lid and the OS suspends every process on the machine. Nothing is killed, but nothing runs either. A 6 hour overnight task makes zero progress, and any open network connections (including the agent's API calls) usually die during the suspend anyway.",
        "Which one you've got decides the fix. SIGHUP problems (closed terminal, dropped SSH) go away once you detach the process from your session with tmux, screen, nohup or systemd. Sleep doesn't. No multiplexer can make a suspended CPU execute instructions, so for sleep you either keep the machine awake or move the agent to one that stays awake.",
        "Want to know whether your current setup would survive? Run [the agent survival check](/tools/agent-survival-check). It goes through the same failure modes and tells you which one will get you.",
      ],
    },
    {
      heading: "tmux and screen in 90 seconds",
      paragraphs: [
        "tmux is a terminal multiplexer. It runs your shell session inside a server process on the machine, so the session survives when your terminal window or SSH connection goes away. It's the standard fix for SIGHUP:\n\n```bash\n# Start a named session and launch your agent inside it\ntmux new -s agent\nclaude          # or codex, or any CLI agent\n\n# Detach without killing anything: press Ctrl+b, then d\n\n# Reattach later, from any terminal or SSH connection\ntmux attach -t agent\n\n# List running sessions\ntmux ls\n```\n\nClose the window, lose the SSH connection, reconnect from your phone. The agent never noticed. You reattach and the full scrollback is there. The [tmux cheat sheet](/tools/tmux-cheat-sheet) lists the keys and commands, and builds the start commands for each agent.",
        "screen is the older tool that does the same job:\n\n```bash\nscreen -S agent     # start a named session\n# Detach: Ctrl+a, then d\nscreen -r agent     # reattach\n```\n\nPick tmux if you're choosing today. It has panes, better scripting and active development. screen's one advantage is that it ships preinstalled on more minimal distros.\n\nBoth share one limit: **tmux on your laptop does not survive sleep.** It protects the session from disconnects. It can't stop the machine from suspending, so tmux only earns its keep on a machine that stays awake.",
      ],
    },
    {
      heading: "nohup and systemd for real persistence",
      paragraphs: [
        "If you don't need to interact with the agent, you don't need a live session at all. Most CLI agents have a headless or print mode that takes a prompt, works, and exits. `nohup` makes that run immune to SIGHUP:\n\n```bash\nnohup claude -p \"run the test suite and fix failures\" > run.log 2>&1 &\n\n# Watch progress\ntail -f run.log\n```\n\n`nohup` detaches the process from the terminal, so logging out or closing the window does nothing to it. The tradeoff is that you can't steer. You can't reattach, and you can't answer a question the agent asks. It's fire and forget, which suits tasks that really are fire and forget.",
        "For an agent that should always be running (a Discord bot, a monitoring agent, a long-lived Hermes style assistant), the correct tool on Linux is a systemd service, because systemd also restarts the process when it crashes:\n\n```bash\n# /etc/systemd/system/my-agent.service\n[Unit]\nDescription=My AI agent\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/local/bin/my-agent\nRestart=always\nRestartSec=5\nUser=agent\n\n[Install]\nWantedBy=multi-user.target\n```\n\n```bash\nsudo systemctl daemon-reload\nsudo systemctl enable --now my-agent\njournalctl -u my-agent -f    # logs\n```\n\n`Restart=always` is what tmux doesn't give you. tmux keeps a session open, and systemd keeps a process alive. If the agent segfaults at 3am, systemd starts it again 5 seconds later.",
      ],
    },
    {
      heading: "Mac-specific fixes: caffeinate, pmset, Amphetamine",
      paragraphs: [
        "On a Mac, the usual killer is sleep, and macOS gives you real tools for it:\n\n```bash\n# Keep the Mac awake for as long as this command runs\ncaffeinate -i claude\n\n# Or keep it awake while an already-running process lives (by PID)\ncaffeinate -i -w 12345\n\n# Or keep it awake for a fixed window, e.g. 8 hours\ncaffeinate -i -t 28800\n```\n\n`caffeinate -i` prevents idle sleep while the wrapped command runs. The [keep-awake command builder](/tools/keep-mac-awake) writes the right flags for your setup. It's the cleanest overnight fix on a Mac that stays plugged in and open.",
        "If that isn't enough, **pmset** changes power settings system wide. `sudo pmset -a disablesleep 1` blocks sleep entirely, including lid close. Remember to set it back with `sudo pmset -a disablesleep 0`, or your battery will remind you. **Amphetamine** (free, Mac App Store) is the GUI version: one click keeps the Mac awake for a set time, with an option to let the display sleep while processes keep running.\n\nThe catch that gets everyone: **closing the lid still sleeps most MacBooks** unless the machine is plugged in AND connected to an external display, or you've forced it with `pmset disablesleep`. caffeinate alone does not override lid close. If your overnight plan is a closed MacBook in a backpack, the plan is the problem.",
      ],
    },
    {
      heading: "The overnight-run checklist",
      paragraphs: [
        "Before you start a long run and go to bed, spend 2 minutes on this list:\n\n- **Detach the session.** Agent running inside tmux (or via nohup/systemd), not bare in a terminal window.\n- **Kill sleep for the window.** `caffeinate -i` on Mac, disable suspend in power settings on Linux and Windows, or run on a machine that stays awake.\n- **Plug it in.** Battery power plus a long agent run is a race you lose.\n- **Log to a file.** Redirect output (`> run.log 2>&1`) or rely on tmux scrollback so you can see what happened at 4am.\n- **Cap the blast radius.** Set spending limits with your model provider, and give the agent a scoped task with a clear done condition, not an open loop.\n- **Check for prompts.** Many agents pause on permission questions. Pre-approve what you're comfortable with (for example a permissive mode inside a sandbox or VM), or the agent will sit waiting for input for 7 hours.\n- **Test the survival, not the task.** Start the run, close the terminal, reattach. If it survived that, it will survive the night's disconnects.",
      ],
    },
    {
      heading: "The failure modes none of this fixes",
      paragraphs: [
        "tmux, nohup and caffeinate fix the shell problem. The machine is a separate problem, and plenty of things on it can still end your run.\n\nIf the agent process itself crashes, tmux just shows you a dead pane in the morning. Only a supervisor (systemd with `Restart=always`, or a managed platform) restarts it. OS updates on macOS and Windows can force a reboot overnight, and anything not registered as a boot service is gone. A power blip or your router's 2am firmware update kills the run on any home machine.\n\nThen there's the simple fact that your laptop has another job. Sooner or later it goes in a bag. Every fix above works around one thing: a personal machine isn't an always-on server.",
        "Keeping one machine awake for one night is easy. Keeping an agent alive for weeks, through crashes, reboots, updates and your own travel, is server operations, and the fixes above only delay that work.",
      ],
    },
    {
      heading: "When a $10 always-on computer beats all of it",
      paragraphs: [
        `Every fix in this article does the same thing: it moves the agent's lifetime off your terminal, then off your laptop. Follow that far enough and you end up with a machine whose only job is to run the agent.\n\nYou can build that yourself with a $5-10/month VPS plus tmux plus systemd plus your own patching and security. It's a perfectly good route, and we wrote it up in detail for [Claude Code](/blog/keep-claude-code-running-24-7) and [Codex](/blog/run-codex-24-7-in-the-cloud). The full menu of places an agent can live, from home hardware to serverless, is in the [AI agent hosting guide](/blog/ai-agent-hosting-guide).\n\nOr you can rent that machine. [Hivra](/) provisions a private VM per agent and runs the agent on it: [Claude Code](/agents/claude-code) (the official CLI, signed in with your own Anthropic account), [Codex](/agents/codex) (the official CLI, your own ChatGPT login), and [Hermes](/agents/hermes), and hosts the dashboard for [Aeon](/agents/aeon). You get a browser view of the computer (chat, terminal, files), so checking on it at 4am doesn't mean SSH from your phone.\n\nOne rule from this article still applies there, though. ${CLI_RUN_LIFETIME} ${SERVER_SIDE_AGENTS_KEEP_WORKING}`,
        `Plan math: the ${ENTRY_PLAN_PRICE}/month plan is ${ENTRY_PLAN_SIZE}, and the ${LARGER_PLAN_PRICE}/month plan is ${LARGER_PLAN_SIZE}. Paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. On your own Anthropic or OpenAI login, usage bills through that provider at its rates with no Hivra markup. Hivra is independent and is not affiliated with Anthropic or OpenAI. Details on [the pricing page](/pricing).\n\nIf you enjoy running servers, run the server. If you just want the agent alive tomorrow morning, and every morning after, the ${ENTRY_PLAN_PRICE} computer (${ENTRY_PLAN_SIZE}) is this whole article without the upkeep.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Why does my AI agent stop when I close the terminal?",
      a: "The agent is a child process of your shell. Closing the terminal sends SIGHUP to the whole session and the agent exits with it. Run the agent inside tmux or screen, or start it with nohup, and it survives the terminal closing.",
    },
    {
      q: "Why does my AI agent keep stopping when my laptop sleeps?",
      a: "Sleep suspends every process on the machine, so the agent makes no progress and its network connections usually die during the suspend. tmux doesn't help here. Keep the machine awake (caffeinate on Mac, power settings on Linux/Windows) or run the agent on an always-on machine like a VPS or a managed computer.",
    },
    {
      q: "Does tmux keep an AI agent running after I disconnect from SSH?",
      a: "Yes. tmux runs the session inside a server process on the remote machine, so a dropped SSH connection changes nothing. Reattach with tmux attach -t <name> and the agent is exactly where you left it. It only fails if the remote machine itself sleeps, reboots, or loses power.",
    },
    {
      q: "How do I run an AI agent overnight on a Mac?",
      a: "Start the agent inside tmux, then keep the Mac awake with caffeinate -i (or Amphetamine), leave it plugged in, and leave the lid open unless you have disabled lid sleep with pmset. Log output to a file so you can review what happened. Note that closing the lid still sleeps most MacBooks even with caffeinate running.",
    },
    {
      q: "What is the difference between nohup and tmux for AI agents?",
      a: "nohup detaches a one-shot process from the terminal so it survives logout, but you can't reattach or interact with it afterward. tmux keeps a full interactive session alive that you can detach from and reattach to. Use nohup for fire-and-forget headless runs, tmux when you might need to steer.",
    },
    {
      q: "What keeps an AI agent running after a crash or a reboot?",
      a: "None of the session tools do. tmux and nohup only protect against disconnects. For crash recovery you need a supervisor like a systemd service with Restart=always, and for reboots the service must be enabled at boot. On a managed platform like Hivra, the agent's VM and its services are set up for you, so you don't write that unit yourself.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)" },
    { slug: "keep-claude-code-running-24-7", title: "How to keep Claude Code running 24/7 (even when your laptop closes)" },
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
  ],
};
