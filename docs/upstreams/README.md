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
| `agent-runtime` | Agents Hivra installs from their official upstream | Bump the default pin for new computers. Owners update their own agents. A pin under `dashboard/provisioner/` needs a provisioner release. |
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
