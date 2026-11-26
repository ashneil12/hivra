# Upstream repositories

Every outside repository Hivra installs, takes code from, or learned from is
listed in [`upstreams.json`](upstreams.json). The list is checked once a week.

```sh
node scripts/upstreams/check-upstreams.mjs           # what moved since the last check
node scripts/upstreams/check-upstreams.mjs --write   # record this week's state
node --test scripts/upstreams/check-upstreams.test.mjs
```

The check uses `git ls-remote` only: no token, no clone, no upstream code runs.
It reports new commits, new stable releases (pre-releases are ignored) and pins
that are behind. Deciding what to take is a person's (or an agent's) job; the
script only says where to look.

## Roles

| Role | Meaning | What "taking an update" means |
| --- | --- | --- |
| `agent-runtime` | Agents Hivra installs from their official upstream | Nothing to bump: a launch installs upstream's newest release and owners update their own agents (Update button or the agent's own command). Look only for breaking changes to how Hivra installs, starts or reads the agent. |
| `ported-code` | Code adapted into this repository | Re-port the changed upstream files, keep the attribution line. |
| `library` | Packages Hivra depends on directly | Bump the package version. |
| `desktop-stack` | Desktop computer pieces (Omarchy, streaming) | Re-pin after a test on a staging computer. |
| `skills` | Skill text copied into the curated list | Check that skill's own licence, then copy. |
| `inspiration` | Projects we studied for a design | Read what changed; nothing to merge. |

## Rules

- Install from the official upstream, never from a Hivra fork.
- Check the licence every time. A repository that moves to a non-commercial or
  source-available licence is dropped or held at its last open release.
- New behaviour from an upstream ships behind a switch that is off by default.

## Not used

| Project | Why |
| --- | --- |
| Nightly Labs OpenBot | PolyForm Noncommercial since 0.1.12. Hivra runs CopilotKit OpenBot (MIT) instead. |
| beam-cloud/beta9 | AGPL. Ideas only: lazy image mounts that stream blocks on first read, for fast wakes. No code taken. |
| reliant-labs/reliant | BSL. Ideas only: the owner picks the idle time before a computer sleeps. No code taken. |
| julianosig/easi.run | AGPL. Ideas only: a per-agent browser the owner can take over for a login or captcha, then hand back. No code taken. |

## Finds of 2026-11-12

Projects from a scan of competitors and open-source tools. The MIT and Apache ones
are now in `upstreams.json` as `inspiration`, so the weekly check watches them.

| Project | Taken | Why |
| --- | --- | --- |
| Self-hosted managed agents (Anthropic and Google) | A guide on the blog | Both vendors' workers run on any Linux machine that stays on. The guide says they have not yet been run on a real Hivra computer. |
| huntaway (MIT) | Passed to the sleep/wake work | Per-harness idle detection and runaway-process killing fit the sleep observer. |
| Rakazo (Apache-2.0) | Watched | A catalog candidate (always-on bots with their own computer, Docker quick start). Not offered yet. |
| Rowboat (Apache-2.0) | Watched | Competitor that hosts Hermes and OpenClaw or connects agents elsewhere. |
| muster, Muxflow (MIT) | Watched | Phone alerts when an agent needs you and pasting screenshots into remote sessions. Hivra's Needs-you inbox covers the first; the second is a chat attachment idea. |
| safeagents (Apache-2.0) | Watched | A tool-call checking proxy owners could install themselves. Not wired in. |

## Check of 2026-11-25

Covers 17 to 25 November. No licence changes: every repository checked still
carries the licence recorded in `upstreams.json`. Nine inspiration entries that
said "see repo" now name the licence their repository carries; one of them,
plastic-labs/honcho, is AGPL-3.0, so it stays ideas only, like beta9.

| Repository | Hivra uses | What moved | Decision |
| --- | --- | --- | --- |
| hardbeat920/monocode | ported chat UI | nothing | Upstream main is still at the commit merged on 12 November; nothing to merge into MonoCode Hub. |
| anthropics/claude-code | 2.1.292 | 2.1.332 | Take with the next provisioner release (now 2.1.332). Adds MCP-server skills (beta) and a `PreSkillShellCommand` hook; the rest are freeze, compaction and sign-in fixes (`claude auth login` now exits 1 when a login could not be saved). No breaking changes. |
| openai/codex | 0.149.1 | 0.172.0 | Still needs a live test first. `codex exec resume` now restores saved sandbox permissions and working folder; optional stdio MCP servers start on first tool call. |
| openclaw/openclaw | 2026.6.10 | 2026.11.10 | Unchanged decision (live test first). Node 24.22.1+ (or 26.12.1+) is now recommended; plugin setting `allowPromptInjection` is renamed `allowPromptModification` (Doctor migrates it); `openclaw update migrate` shows progress and backs up first. Hivra sets neither setting. |
| agent0ai/agent-zero | latest image | v2.16 | New launches already get it. Adds A0Cleaner (weekly cache clean-up), missed-schedule catch-up, Time Travel snapshot expiry on by default, and an idle browser that suspends after an hour. Covered by the weekly launch sweep; watch it after the v2.15 `.env` change. |
| NousResearch/hermes-agent | latest (installer) | v0.23.4 | Nothing to do: owners get it with `hermes update`. Another roll-up (229 PRs); new `hermes gateway migrate --backends` moves old serve/dashboard backends onto the gateway. Re-test `hermes config set model.default` and the Desktop Webapp on an updated computer. |
| CopilotKit/openbot | latest image | v1.1.3 | Keep `latest`. 1.1.x runs 14 additive migrations at start and drops `OPENBOT_MULTIPLE_ORGANIZATIONS`; Hivra runs single-user mode and never sets it. |
| nuphos/nuphos | latest image | runtime 0.1.78 | Fine as is. Codex picks up edited instructions on its next turn; no configuration changes. |
| aaronjmars/aeon | 8b8d719 | more commits | Leave (Ash no longer runs Aeon; customers still can). |
| deepseek-ai/deepseek-harness | 0.1.2-alpha.2 | 0.2.2-rc.5, 0.2.3-alpha.2 | Leave. Still no stable 0.2. |
| block/buzz, block/buzz-app | desktop 0.5.20 | ongoing work | Leave; the move to buzz-app is still open. |
| hyprwm/aquamarine | 0.14.0 + Hivra patch | main moved | Keep the patch; rebase still waits on a cursor test. |
| omacom/omarchy, omarchy-iso | latest | main moved | Nothing for Hivra computers. |
| selkies-project/selkies | image digest | main moved | Leave the pinned digest. |
| LizardByte/Sunshine | latest | pre-release v2026.1123.40502 | Leave until a stable release (the check script cannot tell pre-releases from tags). |
| coreyhaines31/marketingskills | attribution only | v2.14.28 | Nothing to do; no longer shipped. |
| BankrBot/skills | copied skill text | not flagged | Hold. Still no root licence. |
| Inspiration projects | designs only | various (ACP schema 1.35.0, OpenTelemetry collector 0.166.0, Rakazo, Rowboat, gVisor, Firecracker busy) | Nothing to merge. |

Nothing was taken into the product this week: the only bumps are agent pins
under `dashboard/provisioner/`, which wait for the next provisioner release.

## Check of 2026-11-17

Covers 12 to 17 November. No licence changes: every repository checked still
carries the licence recorded in `upstreams.json`. (huntaway's history was
rewritten for its 1.0.0 release; its licence file is new in git but still MIT.)

| Repository | Hivra uses | What moved | Decision |
| --- | --- | --- | --- |
| hardbeat920/monocode | ported chat UI | nothing | MonoCode Hub fork is already level with upstream main. |
| anthropics/claude-code | 2.1.292 | 2.1.326 | Take with the next provisioner release (now 2.1.326). Adds Code Mode with agent teams and clearer startup warnings; the rest are fixes, many around sign-in, settings and MCP. No breaking changes. |
| openai/codex | 0.149.1 | 0.169.0 | Still needs a live test first. `codex exec` now keeps project config and MCP servers off in untrusted folders even with `--sandbox workspace-write`; pass `--trust` to save trust. Check any Hivra use of `codex exec` before a bump. |
| openclaw/openclaw | 2026.6.10 | 2026.11.4 | Unchanged decision (live test first). A newer CLI now refuses to migrate a database an older gateway still uses, and `FS_SAFE_PYTHON_MODE` must be renamed to `FS_SAFE_NATIVE_MODE` before updating. |
| NousResearch/hermes-agent | latest (installer) | v0.23.2 | Nothing to do: owners get it with `hermes update`. A roll-up of about 2,000 merged PRs; full notes come with v0.24.0. Re-test `hermes config set model.default` on a computer that has updated. |
| agent0ai/agent-zero | v2.2 | v2.15 (no new release) | Unchanged decision (live test first). |
| CopilotKit/openbot | latest image | v1.0.3 | Keep `latest`; v1.0.3 is the release to pin if we pin. A skin rename and an Anthropic key fix. |
| nuphos/nuphos | latest image | runtime 0.1.62 | Fine as is. Restores a lost agent session instead of failing the prompt; rollback is safe. |
| aaronjmars/aeon | 8b8d719 | docs and skill-scan hardening | Leave (Ash no longer runs Aeon; customers still can). |
| deepseek-ai/deepseek-harness | 0.1.2-alpha.2 | 0.2.2-rc.3 | Leave. Still no stable 0.2. |
| block/buzz, block/buzz-app | desktop 0.5.20 | buzz-app 1.0.4 with search, ownership transfer and plugin sharing | Leave; the move to buzz-app is still open. |
| hyprwm/aquamarine | 0.14.0 + Hivra patch | renderer fence and DRM format fixes on main | Keep the patch; the rebase onto 0.16.0 is still waiting on a cursor test. |
| omacom/omarchy, omarchy-iso | latest | hardware support and translations | Nothing for Hivra computers. |
| selkies-project/selkies | image digest | the desktop now starts in the user's home; CI fixes | Leave the pinned digest. |
| LizardByte/Sunshine | latest | pre-release v2026.1116.150042 (single-page web UI, pairing fix) | Leave until a stable release. The repository now redirects to SunshineStream/Sunshine; same GPL-3.0 licence. |
| BankrBot/skills | copied skill text | weekly `bankr` sync, one new trading skill | Hold. Still no root licence. |
| Inspiration projects | designs only | various (ACP schema 1.32.0, Rakazo and Rowboat busy) | Nothing to merge. |

Nothing was taken into this repository this week: the only safe changes are
agent pins under `dashboard/provisioner/`, which wait for the next provisioner
release.

## Check of 2026-11-12 (second run, evening)

This run came the same day as the first full check, so it covers about half a
day of upstream work. No licence changes anywhere: every repository checked
still carries the licence recorded in `upstreams.json`.

| Repository | Hivra uses | What moved | Decision |
| --- | --- | --- | --- |
| hardbeat920/monocode | ported chat UI | nothing | MonoCode Hub fork is already level with upstream main. |
| anthropics/claude-code | 2.1.292 | 2.1.323 | Take with the next provisioner release (now 2.1.323 rather than 2.1.322). New opt-in Code Mode and plugin version ranges; the rest are fixes. |
| openai/codex | 0.149.1 | 0.168.0 | Still needs a live test first. 0.168.0 adds provider browsing in the TUI, runtime auth across backend paths and more Guardian review work. |
| NousResearch/hermes-agent | latest (installer) | 117 commits, no new release | Nothing to do. Mostly security fixes: credential refs withheld from MCP stdio children, Google OAuth redaction, Skills Hub redirect checks, gateway `/stop` authorisation, dashboard logout. Owners get them with `hermes update`. |
| openclaw/openclaw | 2026.6.10 | 34 commits, no new release | Unchanged decision (live test first). Includes a fix for updating from 2026.11.3 when Workboard is installed. |
| CopilotKit/openbot | latest image | 8 commits, no new release | Keep holding `latest`; consider pinning v1.0.2. |
| nuphos/nuphos | latest image | 2 commits | Fine as is. |
| block/buzz, block/buzz-app | desktop 0.5.20 | fixes; buzz-app added an upgrade guide for old Buzz app users | Leave; the move to buzz-app is still open. |
| selkies-project/selkies | image digest | HTTPS on a second port | Leave the pinned digest. |
| Inspiration projects | designs only | small changes | Nothing to merge. |

## Check of 2026-11-12

No licence changes anywhere.

| Repository | Hivra uses | Newest | Decision |
| --- | --- | --- | --- |
| hardbeat920/monocode | ported chat UI | 17 new commits (6-12 Nov) | Merged into the MonoCode Hub fork. All 17 touch the native app, mobile app and Rust crates; none touch the web files Hivra ported, so nothing to re-port here. |
| anthropics/claude-code | 2.1.292 | 2.1.322 | Take with the next provisioner release. No breaking changes in the changelog. |
| openai/codex | 0.149.1 | 0.167.2 | Needs a live test first: the npm package now execs the native binary, and sign-in was reworked. |
| openclaw/openclaw | 2026.6.10 | 2026.11.3 | Needs a live test first: requires Node 24+, config migrations (`openclaw doctor --fix`), new Control UI. |
| agent0ai/agent-zero | v2.2 | v2.15 | Needs a live test first: new dependencies, settings migration, self-updater changes. |
| NousResearch/hermes-agent | latest (installer) | v0.23.1 | Nothing to do. Owners already update with `hermes update`. Re-test `hermes config set model.default` when the next stable lands (config code changed on main). |
| CopilotKit/openbot | latest image | v1.0.2 | Hold `latest`; consider pinning v1.0.2. Unreleased main runs irreversible database migrations at start. |
| nuphos/nuphos | latest image | runtime 0.1.55 | Fine as is: fixes only. |
| aaronjmars/aeon | 8b8d719 | 350 commits ahead | Leave. Run the new stricter config validation before any bump. |
| deepseek-ai/deepseek-harness | 0.1.2-alpha.2 | 0.2.2-rc.2 | Leave. No stable 0.2 yet; it has breaking session and API changes, and `web_fetch` can now reach private addresses, which needs a sandbox review before any bump. |
| block/buzz | desktop 0.5.20 | desktop 0.5.28, relay 0.3.0 | Leave. Buzz 1.0 now lives in block/buzz-app; decide whether to move to it. |
| browser-use/bux | f17c1b3 | unchanged | Nothing to do. |
| Jakubantalik/thinking-orbs | 0.3.2 | 0.3.2 | Current. |
| hyprwm/aquamarine | 0.14.0 + Hivra patch | 0.16.0 | Upstream still lacks the cursor-plane hotspot fix, so keep the patch. Rebase it onto 0.16.0 for its crash fixes after a cursor test. |
| omacom/omarchy | latest | v4.5.0 | Test the CPU-render fix on a desktop computer; watch the upstream remote-desktop work. |
| selkies-project/selkies | image digest | main is a Rust rewrite | Leave the pinned digest. Re-pin only after a staging test of sign-in, env vars, audio and pointer. |
| LizardByte/Sunshine | latest | v2026.1112.40957 | Take: Linux input and CUDA fixes. |
| BankrBot/skills | copied skill text | weekly `bankr` updates, 4 new skills | Hold. The repository has no root licence; check each skill's own licence first. |
| Inspiration projects | designs only | various | Nothing to merge. |
