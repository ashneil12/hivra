import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "openclaw-broken-after-update",
  title: "OpenClaw broken after an update? Every fix, in the order to try them",
  metaTitle: "OpenClaw Broken After Update: Every Fix That Works",
  metaDescription:
    "OpenClaw broke after an update? The fixes in order: doctor --fix for schema changes, the tools.profile permission reset, broken skills, and rollback.",
  publishedDate: "2026-07-23",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "The update did not eat your data. It probably moved your config.",
  intro:
    "OpenClaw ships new releases several times a month, and breaking changes are a known part of that cadence. If your agent stopped responding, lost its permissions, or will not start after an update, this guide walks the known failure modes in the order they most often occur, with the exact commands to fix each one.",
  sections: [
    {
      heading: "Triage: three commands before you change anything",
      paragraphs: [
        "Do not start editing config files yet. OpenClaw ships diagnostics that identify most post-update breakage on their own, and you want a clear picture before you make changes on top of a half-migrated install:\n\n```\nopenclaw --version\nopenclaw doctor\nopenclaw config validate\n```\n\n`openclaw --version` confirms the update actually applied. A surprising number of \"broken after update\" reports are updates that silently failed, leaving a half-old, half-new install. `openclaw doctor` checks the runtime environment (Node.js version, package manager, config health). `openclaw config validate` tells you whether your `~/.openclaw/openclaw.json` still parses and matches the current schema.",
        "Then look at the logs from the moment the gateway last tried to start:\n\n```\nopenclaw logs --follow                                   # native install\njournalctl --user-unit openclaw-gateway.service -f      # native, via systemd\ndocker compose logs -f openclaw-gateway                  # Docker install\n```\n\nThe first error line after the restart usually names the failure directly. Everything below is the fix for each of the errors you are likely to see there.",
      ],
    },
    {
      heading: "Fix 1: config schema changed (the most common one)",
      paragraphs: [
        "OpenClaw updates frequently change the configuration schema. Keys get renamed, moved, or nested differently, and your existing `openclaw.json` no longer matches what the new version expects. The symptom is a gateway that refuses to start, or starts and ignores settings that worked yesterday.\n\nThe built-in migration handles most of it:\n\n```\nopenclaw doctor --fix\nopenclaw config validate\nopenclaw gateway restart\n```\n\n`doctor --fix` rewrites your config to the current schema where it can. Run `config validate` afterward to confirm nothing is left over, then restart the gateway and send the bot a test message.",
        "If `config validate` still reports errors after `doctor --fix`, the remaining keys need manual attention. Check the release notes for the version you just installed, fix the named keys in `~/.openclaw/openclaw.json`, and validate again. The config file is plain JSON, so one trailing comma or missing quote will keep OpenClaw from starting with a cryptic error. Validate after every manual edit.",
      ],
    },
    {
      heading: "Fix 2: the agent replies but cannot do anything",
      paragraphs: [
        "This one looks strange: the bot answers in Telegram, chats normally, but claims it cannot read files, write files, or run commands. Tasks it handled last week now come back with permission errors.\n\nThe cause is a known update behavior: `tools.profile` defaulting back to `messaging`, which strips read, write, and exec permissions from the agent. Your agent did not lose its abilities. Its permission profile got reset.\n\nOpen `~/.openclaw/openclaw.json`, check what `tools.profile` is set to now, and set it back to the profile you were running before the update:\n\n```\nopenclaw config set tools.profile <your-previous-profile>\nopenclaw config validate\nopenclaw gateway restart\n```\n\nIf you never changed it and do not know what it was, check the release notes for your previous version or your pre-upgrade backup of `openclaw.json`. After every future upgrade, verifying `tools.profile` should be part of your checklist, because this reset has bitten the community more than once.",
      ],
    },
    {
      heading: "Fix 3: the gateway will not start at all",
      paragraphs: [
        "If the process dies immediately on start, work through these in order:\n\n- **Config syntax.** Run `openclaw config validate`. A JSON syntax error in `openclaw.json` prevents startup with an unhelpful message. Fix the syntax before anything else.\n- **Node.js version.** OpenClaw's install docs currently require Node 24.16+ or 26.1+, and an update can raise the floor. `openclaw doctor` flags this. If your system Node is older, upgrade it, then retry.\n- **Package manager.** pnpm is only needed if you built OpenClaw from source. On a source install, if `doctor` reports missing or mismatched dependencies after an update, reinstall them with pnpm rather than npm.\n- **Service state.** On native installs, a stale service definition can survive the update. `openclaw gateway install` refreshes it, then `systemctl --user restart openclaw-gateway`.",
        "For Docker installs, a container that restarts in a loop usually means the new image cannot read the mounted config. Check `docker compose logs` for the parse error, fix the config in your mounted `./data` directory, and bring it up again with `docker compose up -d`.",
      ],
    },
    {
      heading: "Fix 4: your custom skills broke",
      paragraphs: [
        "OpenClaw's skill API surface changes between releases. Functions get renamed or removed, and custom skills written against the old surface fail after the update. The log line typically names the missing function.\n\nThere is no automated fix for this one. You update the skill code to the new API, or you pin OpenClaw to the version the skill was written for until you have time to port it. Community skills from ClawHub often ship updates within days of a breaking release, so check for a newer version of the skill before rewriting anything yourself.",
        "A separate Docker-specific trap looks like broken skills but is really lost skills: if your skills lived inside the container image instead of the mounted volume, the update wiped them. Skills and config must live in the mounted volume (`./data`), not in the image layer. Verify the mount:\n\n```\ndocker inspect openclaw-gateway | grep -A 5 Mounts\n```\n\nIf the mount is wrong, restore the skills from your backup into the volume, fix the `docker-compose.yml` volume mapping, and recreate the container.",
      ],
    },
    {
      heading: "Rolling back a bad release",
      paragraphs: [
        "Sometimes the right move is to get back to the version that worked and try again next week. On Docker this is clean. Pin the previous image tag in `docker-compose.yml`:\n\n```yaml\nservices:\n  openclaw-gateway:\n    image: ghcr.io/openclaw/openclaw:2026.3.12   # your last-good version\n```\n\nThen recreate:\n\n```\ndocker compose pull\ndocker compose up -d --force-recreate\n```\n\nIf the update also migrated your config or data, restore the backup you made before upgrading over the current `~/.openclaw/` (or the mounted `./data` directory), because a schema-migrated config may not run on the older version.",
        "If you did not make a backup, that is the lesson for next time. The standard pre-upgrade ritual is 2 minutes:\n\n```\nopenclaw gateway stop\ntar czf openclaw-backup-$(date +%Y%m%d-%H%M).tgz ~/.openclaw/\nopenclaw update\nopenclaw doctor --fix\nopenclaw gateway restart\n```\n\nOne warning on staying pinned: rollback is a delay, not a strategy. CVE-2026-25253, the one-click remote code execution flaw patched in 2026.1.29, is the standing example of why running weeks behind on OpenClaw releases carries real risk. Pin to recover, then plan the re-upgrade.",
      ],
    },
    {
      heading: "Preventing the next one",
      paragraphs: [
        "OpenClaw's release cadence is not going to slow down for you, so the practical defense is a repeatable upgrade routine. The full version is in our [self-hosting OpenClaw guide](/blog/how-to-self-host-openclaw), but the short list:\n\n- Back up `~/.openclaw/` before every upgrade, without exception.\n- Read the release notes before updating, not after the breakage.\n- Run `openclaw doctor --fix` and `openclaw config validate` immediately after every update.\n- Check `tools.profile` and send the bot one real task before you walk away.\n- On Docker, pin exact version tags and upgrade deliberately instead of riding `latest`.\n\nBudget roughly 20 minutes per upgrade done properly, times 2-4 upgrades per month. That number is the honest cost of self-hosting OpenClaw at production quality.",
      ],
    },
    {
      heading: "If you are tired of fixing this every month",
      paragraphs: [
        `Some people enjoy the maintenance. If you just want the agent to work, there are two ways to shrink the monthly breakage loop.\n\nThe first is letting someone else run the machine OpenClaw lives on. [Hivra hosts OpenClaw](/agents/openclaw) on a private managed VM: the open-source agent unmodified, its Control UI bound to localhost and reached through Hivra's authenticated gateway, with the server and the install handled for you. You configure your model providers and your Telegram, WhatsApp, or Signal channels inside that UI. It needs a paid plan, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. Details on [the pricing page](/pricing). Hivra is independent and is not affiliated with the OpenClaw project.\n\nThe second is switching to an agent with a calmer release cadence. Hermes Agent is architecturally comparable (persistent agent, messaging gateway, skills) with fewer breaking changes, and it ships a migration tool (\`hermes claw migrate\`) that imports your OpenClaw config, memories, skills, and environment variables. The full comparison is in [Hermes vs OpenClaw](/blog/hermes-vs-openclaw).\n\nEither way, the fixes above will get today's breakage sorted first.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Why does OpenClaw keep breaking after updates?",
      a: "OpenClaw ships new releases several times a month and frequently changes its config schema and skill APIs between them. The three most common post-update breakages are config schema mismatches, the tools.profile permission reset, and custom skills written against renamed APIs.",
    },
    {
      q: "What does openclaw doctor --fix actually do?",
      a: "It checks your environment and rewrites your configuration to the current schema where it can, which fixes the most common post-update failure. Run openclaw config validate afterward to confirm the config is clean, then restart the gateway.",
    },
    {
      q: "My OpenClaw bot responds but says it cannot run commands. What happened?",
      a: "An update reset tools.profile to messaging, which strips read, write, and exec permissions. Set it back to the profile you were running with openclaw config set tools.profile, run openclaw config validate, and restart the gateway.",
    },
    {
      q: "How do I roll back OpenClaw to a previous version?",
      a: "On Docker, pin the last-good image tag in docker-compose.yml and run docker compose up -d --force-recreate. Restore your pre-upgrade backup of ~/.openclaw/ if the update migrated your config, since a migrated config may not run on the older version. Treat rollback as temporary: staying pinned means missing security patches like the CVE-2026-25253 fix.",
    },
    {
      q: "Will my OpenClaw skills survive an update?",
      a: "Official and community skills usually keep working or get updated within days, but custom skills break when the skill API changes. On Docker, skills also vanish if they were baked into the image instead of the mounted volume. Keep skills in the mounted data directory and back it up before every upgrade.",
    },
    {
      q: "Is there a way to run OpenClaw without running the server myself?",
      a: `Yes. Hivra runs the open-source OpenClaw agent on a private managed VM with the server side handled for you, on paid plans from ${ENTRY_PLAN_PRICE} a month. The alternative route is migrating to Hermes Agent with hermes claw migrate, which has a more stable release cadence.`,
    },
  ],
  relatedArticles: [
    { slug: "how-to-self-host-openclaw", title: "How to self-host OpenClaw: complete setup guide (2026)" },
    { slug: "hermes-vs-openclaw", title: "Hermes Agent vs OpenClaw: a direct comparison" },
    {
      slug: "agent-zero-vs-openclaw-hosting",
      title: "Agent Zero vs OpenClaw hosting: requirements, costs, and which to run",
    },
    {
      slug: "ai-agent-dies-terminal-closes-fixes",
      title: "Why your AI agent dies when you close the terminal (and every fix that works)",
    },
  ],
};
