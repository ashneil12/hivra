import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "../runtime-facts";

export const article: BlogArticle = {
  slug: "ai-agent-dies-terminal-closes-fixes",
  title: "Why your AI agent dies when you close the terminal (and every fix that works)",
  metaTitle: "Why your AI agent dies when the terminal closes",
  metaDescription:
    "Your AI agent stops when the terminal closes, SSH drops, or the laptop sleeps. Why it happens, and every fix: tmux, nohup, systemd, caffeinate.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-24",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "The agent did not crash. Your shell took it down.",
  intro:
    `Claude Code, Codex, OpenClaw, Hermes: every terminal AI agent dies the same way when the terminal closes or the laptop sleeps. This is the full troubleshooting guide, from the 90 second tmux fix to systemd to the honest case for a ${ENTRY_PLAN_PRICE} always-on box.`,
  sections: [
    {
      heading: "Why the process dies in the first place",
      paragraphs: [
        "Terminal AI agents are ordinary child processes of your shell. That single fact explains almost every dead session. Three killers, in order of how often they get blamed on the agent:\n\n- **You closed the terminal.** When a terminal window closes, the kernel sends SIGHUP (hangup) to every process in that session. The agent receives it and exits mid-task. This is 50 year old Unix behavior, not a bug in the agent.\n- **Your SSH connection dropped.** If the agent runs on a remote box over SSH, a dropped connection tears down the remote shell, which sends the same SIGHUP to the agent. Flaky wifi, a VPN hiccup, or your ISP renegotiating is enough.\n- **Your laptop went to sleep.** Close the lid and the OS suspends every process on the machine. Nothing is killed, but nothing runs either. A 6 hour overnight task makes zero progress, and any open network connections (including the agent's API calls) usually die during the suspend anyway.",
        "Which killer you have determines which fix you need. SIGHUP problems (closed terminal, dropped SSH) are solved by detaching the process from your session: tmux, screen, nohup, or systemd. Sleep problems are not. No multiplexer can make a suspended CPU execute instructions. For sleep, you either keep the machine awake or move the agent to a machine that stays awake.",
        "Quick diagnosis: if you want to check whether your current setup would survive, run [the agent survival check](/tools/agent-survival-check). It walks the same failure modes this article covers and tells you which one will get you.",
      ],
    },
    {
      heading: "tmux and screen in 90 seconds",
      paragraphs: [
        "tmux is a terminal multiplexer. It runs your shell session inside a server process on the machine, so the session survives even when your terminal window or SSH connection goes away. This is the standard fix for SIGHUP:\n\n```bash\n# Start a named session and launch your agent inside it\ntmux new -s agent\nclaude          # or codex, or any CLI agent\n\n# Detach without killing anything: press Ctrl+b, then d\n\n# Reattach later, from any terminal or SSH connection\ntmux attach -t agent\n\n# List running sessions\ntmux ls\n```\n\nClose the window, lose the SSH connection, reconnect from your phone. The agent never noticed. You reattach and the full scrollback is there.",
        "screen is the older tool that does the same job:\n\n```bash\nscreen -S agent     # start a named session\n# Detach: Ctrl+a, then d\nscreen -r agent     # reattach\n```\n\nPick tmux if you are choosing today. It has panes, better scripting, and active development. screen's one advantage is that it ships preinstalled on more minimal distros.\n\nThe limit of both tools, stated plainly: **tmux on your laptop does not survive sleep.** It protects the session from disconnects, not the machine from suspending. tmux only earns its keep on a machine that stays awake.",
      ],
    },
    {
      heading: "nohup and systemd for real persistence",
      paragraphs: [
        "If you do not need to interact with the agent, you do not need a live session at all. Most CLI agents have a headless or print mode that takes a prompt, works, and exits. `nohup` makes that run immune to SIGHUP:\n\n```bash\nnohup claude -p \"run the test suite and fix failures\" > run.log 2>&1 &\n\n# Watch progress\ntail -f run.log\n```\n\n`nohup` detaches the process from the terminal, so logging out or closing the window does nothing to it. The tradeoff is that you cannot steer. There is no reattaching, no answering a question the agent asks. It is fire and forget, which is fine for exactly the tasks that are fire and forget.",
        "For an agent that should always be running (a Discord bot, a monitoring agent, a long-lived Hermes style assistant), the correct tool on Linux is a systemd service, because systemd also restarts the process when it crashes:\n\n```bash\n# /etc/systemd/system/my-agent.service\n[Unit]\nDescription=My AI agent\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/local/bin/my-agent\nRestart=always\nRestartSec=5\nUser=agent\n\n[Install]\nWantedBy=multi-user.target\n```\n\n```bash\nsudo systemctl daemon-reload\nsudo systemctl enable --now my-agent\njournalctl -u my-agent -f    # logs\n```\n\n`Restart=always` is the line that separates this from tmux. tmux keeps a session open; systemd keeps a process alive. If the agent segfaults at 3am, systemd starts it again 5 seconds later.",
      ],
    },
    {
      heading: "Mac-specific fixes: caffeinate, pmset, Amphetamine",
      paragraphs: [
        "On a Mac, the usual killer is sleep, and macOS gives you real tools for it:\n\n```bash\n# Keep the Mac awake for as long as this command runs\ncaffeinate -i claude\n\n# Or keep it awake while an already-running process lives (by PID)\ncaffeinate -i -w 12345\n\n# Or keep it awake for a fixed window, e.g. 8 hours\ncaffeinate -i -t 28800\n```\n\n`caffeinate -i` prevents idle sleep while the wrapped command runs. It is the cleanest overnight fix on a Mac that stays plugged in and open.",
        "Two more levels if you need them:\n\n- **pmset** changes power settings system wide. `sudo pmset -a disablesleep 1` blocks sleep entirely, including lid close. Remember to set it back with `sudo pmset -a disablesleep 0`, or your battery will remind you.\n- **Amphetamine** (free, Mac App Store) is the GUI version: one click to keep the Mac awake for a set duration, with an option to allow the display to sleep while processes keep running.\n\nThe catch that gets everyone: **closing the lid still sleeps most MacBooks** unless the machine is plugged in AND connected to an external display, or you have forced it with `pmset disablesleep`. caffeinate alone does not override lid close. If your overnight plan is a closed MacBook in a backpack, the plan is the problem.",
      ],
    },
    {
      heading: "The overnight-run checklist",
      paragraphs: [
        "Before you start a long run and go to bed, take 2 minutes on this list:\n\n- **Detach the session.** Agent running inside tmux (or via nohup/systemd), not bare in a terminal window.\n- **Kill sleep for the window.** `caffeinate -i` on Mac, disable suspend in power settings on Linux and Windows, or run on a machine that stays awake.\n- **Plug it in.** Battery power plus a long agent run is a race you lose.\n- **Log to a file.** Redirect output (`> run.log 2>&1`) or rely on tmux scrollback so you can see what happened at 4am.\n- **Cap the blast radius.** Set spending limits with your model provider, and give the agent a scoped task with a clear done condition, not an open loop.\n- **Check for prompts.** Many agents pause on permission questions. Pre-approve what you are comfortable with (for example a permissive mode inside a sandbox or VM) or the agent will sit waiting for input for 7 hours.\n- **Test the survival, not the task.** Start the run, close the terminal, reattach. If it survived that, it will survive the night's disconnects.",
      ],
    },
    {
      heading: "The failure modes none of this fixes",
      paragraphs: [
        "tmux, nohup, caffeinate and friends solve the shell problem. They do not solve the machine problem. Things that still end your run:\n\n- **Crashes.** If the agent process itself dies, tmux just shows you a dead pane in the morning. Only a supervisor (systemd with `Restart=always`, or a managed platform) restarts it.\n- **Reboots.** OS updates on macOS and Windows can force a restart overnight. Everything not registered as a boot service is gone.\n- **Power and network.** A power blip or your router's 2am firmware update kills the run on any home machine.\n- **The machine has another job.** Your laptop eventually has to go in a bag. Every fix above is a workaround for the fact that a personal machine is not an always-on server.",
        "This is the honest boundary. Keeping one machine awake for one night is a solved problem. Keeping an agent alive for weeks (through crashes, reboots, updates, and your own travel) is server operations, and every fix above only postpones that fact.",
      ],
    },
    {
      heading: "When a $10 always-on box beats all of it",
      paragraphs: [
        `The pattern behind every fix in this article is the same: move the agent's lifetime off your terminal, then off your laptop. The end state of that pattern is a machine whose only job is to run the agent.\n\nYou can build that yourself with a $5-10/month VPS plus tmux plus systemd plus your own patching and security. That route is legitimate and we wrote it up in detail for [Claude Code](/blog/keep-claude-code-running-24-7) and [Codex](/blog/run-codex-24-7-in-the-cloud). The full menu of places an agent can live, from home hardware to serverless, is in the [AI agent hosting guide](/blog/ai-agent-hosting-guide).\n\nOr you can rent the end state directly. [Hivra](/) provisions a private VM per agent and runs the agent on it: [Claude Code](/agents/claude-code) (the official CLI, signed in with your own Anthropic account), [Codex](/agents/codex) (the official CLI, your own ChatGPT login), [Hermes](/agents/hermes), and [Aeon](/agents/aeon). You get a browser view of the box (chat, terminal, files), so checking on the 4am state does not require SSH from your phone.\n\nThe same rule from this article applies there, though. ${CLI_RUN_LIFETIME} ${SERVER_SIDE_AGENTS_KEEP_WORKING}`,
        `Honest plan math: the ${ENTRY_PLAN_PRICE}/month plan is ${ENTRY_PLAN_SIZE}, and the ${LARGER_PLAN_PRICE}/month plan is ${LARGER_PLAN_SIZE}. Paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. There is zero markup on AI usage because model billing stays on your own Anthropic or OpenAI account. Details on [the pricing page](/pricing).\n\nIf you enjoy running servers, run the server. If you just want the agent alive tomorrow morning, and every morning after, the ${ENTRY_PLAN_PRICE} box is the version of this article you do not have to maintain yourself.`,
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
      a: "Sleep suspends every process on the machine, so the agent makes no progress and its network connections usually die during the suspend. tmux does not help here. Keep the machine awake (caffeinate on Mac, power settings on Linux/Windows) or run the agent on an always-on machine like a VPS or a managed box.",
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
      a: "nohup detaches a one-shot process from the terminal so it survives logout, but you cannot reattach or interact with it afterward. tmux keeps a full interactive session alive that you can detach from and reattach to. Use nohup for fire-and-forget headless runs, tmux when you might need to steer.",
    },
    {
      q: "What keeps an AI agent running after a crash or a reboot?",
      a: "None of the session tools do. tmux and nohup only protect against disconnects. For crash recovery you need a supervisor like a systemd service with Restart=always; for reboots the service must be enabled at boot. On a managed platform like Hivra, the agent's VM and its services are set up for you, so you do not write that unit yourself.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)" },
    { slug: "keep-claude-code-running-24-7", title: "How to keep Claude Code running 24/7 (even when your laptop closes)" },
    { slug: "run-codex-24-7-in-the-cloud", title: "How to run Codex 24/7 in the cloud" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
    { slug: "best-vps-for-hermes-agent", title: "Best VPS for Hermes Agent in 2026" },
  ],
};
