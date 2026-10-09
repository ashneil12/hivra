# No-fork Hermes: feasibility, delta, experiment, plan

Status: plan plus a working canary build path. Nothing here has touched a customer box or production
(PROD HOLD is on). Evidence level is marked on every claim: PROVEN (run, output seen), SOURCE (read in
code), UNVERIFIED (not run).

Date: 2026-10-09. Upstream baseline: NousResearch/hermes-agent v0.21.6, image
`nousresearch/hermes-agent@sha256:9774f4f39a9bb8c2f68ce728ed5e99ddbad282163be56764afacf88ed952b784`
(Docker Hub `stable` and `rc.4-v0.21.6`, index digest; commit 818c13be). Fork measured: canary fork
`ashneil12/vanilla-hermes-agent-canary` main 6ca11bdf5d, on upstream tag v2026.9.24 (0.21.5).

## 1. Verdict

**Feasible. Hivra boxes run stock upstream Hermes plus a thin overlay that Hivra owns in this
repository. No fork, and no upstream PR is required.**

What that means in plain terms: there is no Hermes repository to keep in sync any more. What stays is
a small patch queue and an overlay directory in `agent-overlay/`, rebuilt on top of a digest-pinned
upstream image. That is not "zero patches". The honest list of what still has to be carried:

1. **A web patch series** (`agent-overlay/web/patches/`, 2 files). Upstream has no browser build of
   the Desktop renderer, so the rich chat in Hivra's iframe needs our browser bridge. It edits 7
   upstream renderer files (+62 / -10 lines) and adds about 3,900 lines of new files. It is applied at
   image build time to the upstream source at the release tag. It applied cleanly to v0.21.6 with one
   test-file hunk re-ported.
2. **Six runtime seams** (`agent-overlay/files/hivra_overlay/seams.py`). They wrap upstream functions
   in place at plugin load instead of editing upstream files. Five (metering) are off by default and
   dormant; one (held lock) is needed.
3. **A control-plane contract** (changes in the dashboard, listed in section 7): explicit Venice media
   providers in config, a scrub of stale `HERMES_HOME` lines, the new image repository.

Upstream PRs: **0 required, 1 recommended** (section 5, E). Nothing is opened without Ash's approval.

Biggest costs, stated up front: the stock image is about 1.4 GB larger than the fork image (4.55 GB
vs 3.11 GB, local size), which matters on 30 GB box disks; registering releases needs a package
repository on ghcr.io that this profile cannot create (no write credential); and the drift guards
(`check-overlay.sh`, the tests) have to run on every upstream bump.

## 2. What was run

| Check | Result | Level |
|---|---|---|
| Overlay builds on the stock image, amd64 (on the fixture VM) and arm64 (Mac) | built; adds ~140 MB (uv, gh, bundles, files) | PROVEN |
| Overlay is add-only (no file overwrites an upstream file) | 0 collisions of 56 files; guard turns red on a planted collision | PROVEN |
| Seams apply to stock v0.21.6 | 6 of 6 applied. Also 6 of 6 on the next upstream, `rc.3-v0.21.7` | PROVEN |
| Overlay tests inside the image against the upstream test tree | **275 passed** (governor, providers, media tools, plugins, approval relay, seams) | PROVEN |
| Web bundles built from stock source plus patches | `/webchat` (46 MB) and `/dash` (3.3 MB) build; 133 of 133 renderer tests pass (15 files) | PROVEN |
| Real box (canary fixture `firstrun-audit-e0a26c4d`, pve12 VM 1233) on stock + overlay | both containers healthy; gateway reports "Hermes Agent v0.21.6 (2026.9.24) upstream 818c13be", install dir = the agent-source volume | PROVEN |
| Box doctor (`webfree-box-doctor.sh --auth`) on the stock+overlay box | every route, bearer, and `WS /desktop/api/ws -> 101` PASS. Only FAIL was the roll pause I set on purpose | PROVEN |
| Agent tool loop through the gateway API (`/v1/chat/completions`, test model) | cwd `/workspace`; write then read back; `gh`, `uv`, `git` present; `hermes --version` works; 5 of 5 turns admitted and finished by the metering seams | PROVEN with a stub model |
| `hermes update` on stock | direct run: refused, exit 2, prints `docker pull nousresearch/hermes-agent` steps. Through the agent tool: blocked as dangerous on an unattended platform | PROVEN |
| Prompt guidance reaches the model | the system prompt contained "Updating this computer" on every turn | PROVEN |
| Registry-governed refresh (`/var/lib/hermes-release-governed-<id>`) extracts `/webchat` and `/dash` from the running overlay image | bundle on the box changed to the stock-built hash `index-D5wPhQeD.js` | PROVEN |
| Fixture restored afterwards | back on the fork image `2c44e99e`, compose and config restored, doctor FAIL=0 | PROVEN |

Not proven (labelled, not hidden):

- **A real model reply.** The fixture has no model credit, so the chat used a stub OpenAI-compatible
  server (`agent-overlay/scripts/stub-llm-and-governor.py`) that calls the real `terminal` tool. The
  agent loop, tools, cwd and seams are real; the model is not.
- **The rendered chat in a browser.** The static bundle, routes, bearer and the WebSocket handshake
  pass; nobody opened the page in a signed-in browser.
- **A registry roll and UPDATE NOW.** Needs the signed-in ops console and a package repository
  (section 8). I simulated the idle roller's own steps by hand (tag, reseed the agent-source volume,
  recreate), including its venv relocation, which worked on the stock image.
- **Metering against a real sidecar.** None exists (section 5).
- **Fleet facts.** Disk headroom and stale `.env` lines on the 49 production boxes were not read.

## 3. The delta, classified

483 files differ between the canary fork and v2026.9.24 (449 added, 34 modified; +83,002 / -38).
Every file is classified in `docs/release/NO-FORK-DELTA.tsv` (path, status, lines, class,
disposition). Totals:

| Class | Meaning | Files | Added lines |
|---|---|---:|---:|
| A | Not needed, drop | 91 | 14,906 |
| B | Add-only content, moves into the overlay image or a skill pack | 335 | 61,190 |
| C | Replaced by config or env the control plane writes | 11 | 589 |
| D | Needs the overlay (runtime seam, web patch, add-only plugin) | 46 | 6,317 |
| E | Needs an upstream code change | 0 | 0 |

The ~300 files / ~17k added lines quoted earlier is the **production** fork (207 commits ahead of
upstream, 24,131 behind, 17,192 added and 541 deleted over its first 300 files, still on 0.21.0 and not
thinned). The thinned canary fork already dropped most of that (PR 186: 139 modified upstream files
down to 24), so classification here uses the canary fork. Production moves with the same overlay.

| Group | Files | Class | What happens |
|---|---:|---|---|
| `optional-skills/bankr` | 291 | B | Not shipped. The dashboard's curated skills already carry the BankrBot skills inline (`dashboard/src/data/curated-skills.ts`). A Hivra skill pack if wanted. |
| `website/`, `contributors/`, `.hermesos/` | 69 | A | Generated docs, fork CI identity files, fork notes. Archived with the fork. |
| `.github/workflows`, `scripts/ci`, fork CI tests | 22 | A | Sync and build workflows, runner-label rewrites. Replaced by `agent-overlay/scripts/build-overlay.sh`. |
| Venice, Surplus, Bankr providers; image/video/tts/stt/web plugins; 7 tools; egress and gbrain plugins; aeon and signal skills; their tests | 44 | B | Add-only files, copied into the overlay image unchanged. |
| `hivra-core` plugin, provider helpers, bankr prompt | 5 | D | Add-only plugin and `hivra_overlay` package. |
| Metering (`runtime_governor.py` + 5 one-line decorators + tests) | 7 | D | Seams applied at runtime, off unless the governor env is set. |
| Held-lock guard (`fork_status_guard.py` + 1 rebinding) | 3 | D | Runtime seam. Needed. |
| Browser bridge and UI patches (`apps/desktop`, `web`) | 26 | D | `web/patches/0001`, built into `/webchat` and `/dash`. |
| `Dockerfile`, `.dockerignore` | 2 | D | Replaced by the overlay Dockerfile. |
| Home guard (`hermes_fork_home.py` + 2 hooks) | 4 | C | Compose sets `HERMES_HOME`; control plane scrubs stale lines. |
| Bankr config-to-env bridge | 3 | C | The control plane already writes `BANKR_*` into `.env`. |
| Venice auto-pair (3 one-line seams + helper) | 4 | C | Explicit `image_gen` / `video_gen` / `stt` provider in `config.yaml`. |
| `/api/hivra/config` route (`web_server.py` hook) | 3 | D | Not ported yet; see "Known gaps" in section 6. |
| `hivra_approval_relay` plugin (not in the 483) | 3 | B | **Was never merged into either fork's main.** It only exists on branch `feat/hivra-approval-relay-canary`. Ported into the overlay. See section 6. |

## 4. Why nothing needs an upstream change

Checked against v0.21.6 source and, where it mattered, run:

- **`hermes update` in a container.** Correction to earlier notes: on Hivra boxes `is_managed()` is
  false (`HERMES_MANAGED` is never set by the builder). The refusal comes from the image admission
  gate (`evaluate_update_admission`, install stamp `docker`, exit 2). It is the same on the fork and on
  stock. SOURCE + PROVEN.
- **`terminal.cwd=/workspace`.** The control plane already writes it into `config.yaml`
  (`webui-terminal-cwd.ts`). Stock honours it: `pwd` through the agent tool returned `/workspace`. PROVEN.
- **Stock behaviour is enough for the model menu.** Upstream now rejects keyless provider switches
  itself (the fork's own PR 186 notes say so). What is left is a cosmetic filter (`model-picker.tsx`,
  +7 lines) inside the web patch.

## 5. The (D) and (E) items

| Item | Today | On stock | Class |
|---|---|---|---|
| Agents self-updating | `hermes update` refused in the container (same as fork) | Same. The agent is told, in its system prompt, that updates come from the dashboard "Update available" button (overlay prompt section, only when `HERMES_INSTANCE_ID` is set). Update paths stay: idle roller, daily cron, UPDATE NOW. | D |
| Metering heartbeats | 705-line `runtime_governor.py` + 5 decorators in upstream files | Same module, decorators applied at runtime **only if** `HERMES_RUNTIME_GOVERNOR_ENABLED/REQUIRED` is set. **Finding:** nothing in this repository sets those variables or serves the sidecar `/admit`, `/start`, `/heartbeat`, `/finish`, `/fail` API (searched `dashboard/` and the retired private repos). It is dormant code. Actual metering today happens at the managed Venice proxy. | D, dormant |
| Held lock | `gateway/status.py` rebinding line | Stock v0.21.6 fails 2 of the 4 fork cases without the guard (a status poll from the dashboard container can delete a live gateway's pid and lock files). Overlay seam applies the guard. Alternative if Ash prefers: give the dashboard container `pid: "service:gateway"` so it sees the gateway process. | D, and **E candidate** |
| Branding | Hivra theme, Admin Panel row, phone polish | Bundled-plugin files under `apps/desktop/src/plugins/hivra` in the web patch; no core edit. | D |
| Release registry | CI route allows only `vanilla-hermes-agent-canary` (`CI_ALLOWED_IMAGE_REPOS`) | The registry only resolves **ghcr.io** tags (`registry.ts`), so stock Docker Hub images cannot be registered directly. The overlay image is pushed to ghcr.io as an immutable tag and registered. Same flow, new repository. | D |
| Image build and pin | Fork `docker-publish.yml`, BuildKit stale-layer story | `FROM nousresearch/hermes-agent@sha256:<digest>` plus overlay. Labels: revision, upstream tag, upstream commit, overlay version. Version proof: stock reports `0.0.0` in `pyproject.toml`; the truth is `install-stamp.json` (`displayVersion`, `commit`) and `hermes --version`. The old "installed version == pyproject" step does not apply. | D |

**E candidates (need Ash's yes before anything is opened upstream):**

1. Do not unlink `gateway.pid` / `gateway.lock` while the runtime lock is held by another PID
   namespace. Generic, small, with the fork's test as the regression test. Without it we keep one seam.
2. Optional: let a managed image override the text of the Docker `hermes update` refusal
   (an env var). Removes the need for the prompt guidance. Low priority.

## 6. What broke in the experiment

Each item was found by running the stock image on the fixture, and each is now handled in the overlay:

1. **No `uv` in the stock image.** The generated gateway supervisor runs `uv run --no-sync ...`.
   Overlay copies in `uv 0.11.6`.
2. **No `gh`.** The fork added it; agents doing GitHub work need it. Overlay installs it.
3. **`hermes` not on the agent's PATH** (`hermes: command not found` in the agent terminal). The box
   PATH does not include `/opt/hermes/bin`. Overlay symlinks `/usr/local/bin/hermes`.
4. **Bigger image.** Local size 4.55 GB stock vs 3.11 GB fork; `/opt/hermes` is 2.2 GB vs 1.3 GB, and
   the roller copies it into the per-box agent-source volume. The fixture hit 88% disk with three
   images and build cache; the box's disk-cleanup timer then removed the last-known-good tag
   (rollback needed a registry pull). Not solved: see risk R2.
5. **Venice media is not auto-paired.** Without `image_gen.provider: venice` stock does not expose
   `image_generate` on a Venice-only box (shown in a fresh process, with and without the key). The
   control plane must write the provider lines (section 7, P2).
6. **A packaging mistake of mine, now guarded.** A macOS tar added AppleDouble `._*.py` files; stock
   tool discovery reads every `tools/*.py` as UTF-8 and the whole agent turn failed with
   `'utf-8' codec can't decode byte 0xa3`. `check-overlay.sh` now rejects junk and non-UTF-8 files
   (red proof in section 9).
7. **`hivra_approval_relay` is missing from the fleet.** Every box config enables
   `observability/hivra_approval_relay` and the dashboard has the route that receives it, but the
   plugin was never merged into either fork's main (only a branch). Approval push notifications cannot
   work on the current fleet. The overlay ships it (hooks `pre_approval_request` /
   `post_approval_response` exist in stock) with its tests. This is a fix, not a regression.
8. **The refresh timer pulls `:stable` and replaces the bundle.** In non-governed mode
   `hermes-refresh-<id>` runs `docker compose pull`, which overwrote my local retag mid-experiment and
   re-extracted the fork's bundle. In governed mode (a registry release is in force) it extracts from
   the running image and never pulls. Migration boxes must be governed before the first roll.

Known gaps in the overlay (not hidden):

- `GET /api/hivra/config` (the dashboard URL for the Venice onboarding card) is not served. The card
  falls back to the API-key path. Fix: serve it from a dashboard plugin and repoint one URL in the web
  patch. Small, not done.
- The two seams that wrap `gateway.run` and `api_server` rely on private function names. They are
  checked on every build; a rename fails the build instead of shipping unmetered code. Today they are
  off anyway.

## 7. Migration from today's fleet (plan only, rollout is gated by Ash and PROD HOLD)

Today: 49 running boxes on four hosts, all on the fork's 0.21.0 `:stable`, following `:stable` through
the idle roller and the 10:00 UTC fleet-sync cron. Production serves the retired build and has no
registry code or table, so the order below cannot start until Promote.

**P0, owner steps (staged in decisions.md):** a package repository
`ghcr.io/ashneil12/hivra-hermes` with a write credential for the build machine (public pull);
production Promote with schema catch-up (already staged); lift PROD HOLD.

**P1, control-plane PR (canary first, follow-up task):**
(a) `DEFAULT_AGENT_IMAGE`, `DEFAULT_AGENT_IMAGE_REPO(_CANARY)` and `CI_ALLOWED_IMAGE_REPOS` point at the
overlay repository; (b) config builder and the update repair path write
`image_gen.provider`, `video_gen.provider`, `stt.provider: venice` on managed-Venice boxes;
(c) the runtime-env repair also drops `HERMES_HOME=` and `HOME=` lines from persisted `.env`;
(d) an "images by repository" guard so a box on one repository is never offered a digest from another;
(e) regression tests for each. The existing-box one-click migration with rollback (task t_69ee072e)
builds on this.

**P2, build and publish (self-hosted, no hosted CI minutes):**
`agent-overlay/scripts/build-overlay.sh v0.21.6 1 <upstream checkout>` builds, runs
`check-overlay.sh` and the 275 tests, and prints the image name. Push as an immutable tag
`v0.21.6-1-<sha12>` only; never `:stable` or `:latest`. Register it in the release registry by tag
(console, or the CI route once the allowlist includes the repository).

**Waves (hand to hivra-fleet-sre; success = per-box evidence, never `last_synced_at`):**

| Wave | Boxes | Gate to enter | Evidence required |
|---|---|---|---|
| 0 | Canary fixture (done by hand in this task, then restored) | none | section 2 |
| 1 | Canary registry channel: the fixture through the registry with UPDATE NOW | P0, P1, P2 on canary | roll completes; box reports `agent_version` 0.21.6 and the new digest; authenticated `/api/sessions` 200; doctor FAIL=0; rollback to the baseline row works |
| 2 | One real production box (Ash's, or the idlest) | Promote, prod registry, pre-flight audit passes | running image id, agent-source stamp, install stamp version, health, doctor, `/api/sessions`, a real chat reply |
| 3 | One idle box per host (4) | wave 2 clean for 24 h | same, per host; disk check |
| 4 | 2 to 3 boxes per host per batch, then the rest | wave 3 clean | same; stop on first failure and restore LKG |

Pre-flight audit before wave 2 (read-only, per box): free disk after the pull is at least 12 GB;
no stale `HERMES_HOME`/`HOME` lines in `.env`; `plugins.enabled` entries all exist in the new image;
config has the Venice provider lines if the box is managed-Venice. Busy boxes are deferred and counted.

**Rollback:** per box, the idle roller already saves `...:hermes-roll-lkg`; keep that, and keep the old
fork digest registered in the old repository so a halted release can fall back by registry. A box
whose LKG was pruned pulls the old digest.

**Self-update independence:** nothing here makes a box depend on the Hivra dashboard being up
at runtime; the roller already skips when the dashboard is unreachable. Whether a box can move itself
without the dashboard is the follow-up task's question (t_69ee072e).

## 8. What to archive (after the fleet is migrated and one release cycle has passed; staged, not done)

- `ashneil12/vanilla-hermes-agent-canary` and `ashneil12/vanilla-hermes-agent`: archive (read-only).
  Keep the GHCR images until the last box has moved and the old digest is no longer registered.
- Workflows: `upstream-release-sync.yml`, `upstream-sync-followup.yml`, `docker-build-immutable.yml`,
  `docker-publish.yml`, `fork-gate.yml`; fork PR 190 (register-on-CI) close as superseded; open
  `upstream-sync-stuck` issues and the `AEON_GITHUB_PAT` secret retire with them.
- Branch `feat/hivra-approval-relay-canary`: its content lives in the overlay now.
- Skills and docs that describe the fork flow (`hermes-upstream-sync`, parts of `hermes-webui-to-upstream`,
  `docs/release/HERMES-AGENT-RELEASES.md` fork sections) get rewritten to the overlay flow.

## 9. Regression tests, red then green

- Held-lock guard: 4 of 4 pass with the seam; **2 of 4 fail on stock v0.21.6 without it**
  (`HIVRA_TEST_SEAMS_EXCLUDE=held_lock`).
- `check-overlay.sh`: red on a planted `._bad.py` (junk and non-UTF-8), red on a file that collides with
  an upstream file (`hermes_cli/main.py`), red when a seam target is renamed (status `missing`);
  green on the real overlay. Green on `rc.3-v0.21.7` as well.
- Image-generate contract: a fresh-process test asserts `image_generate` is exposed with the provider
  line and not without it.
- All 275 run with `agent-overlay/scripts/run-tests.sh`. They are exempted from the hosted test-wiring
  check because they need Docker and the pinned upstream image (14 entries in
  `dashboard/scripts/test-wiring-exemptions.json`).

## 10. Cost and risk

| # | Risk or cost | Size | Mitigation |
|---|---|---|---|
| R1 | Upstream renames a function the seams wrap | Medium, loud | Build fails (`check-overlay.sh`). Metering seams are off by default, so a miss cannot silently unmeter a box today. |
| R2 | Disk: ~4.7 GB per image and 2.2 GB agent-source copy on 30 GB disks; roll holds old, new, LKG | **High for small disks** | Pre-flight disk gate; prune build cache; consider larger root disk or pruning the unused browser tool bundles in the overlay. UNVERIFIED on the fleet. |
| R3 | Web bridge drift per release (renderer adds a preload key) | Low, loud | Drift test caught `updateHold` on v0.21.6 on the first run; fix was 2 lines. 133 renderer tests on every bump. |
| R4 | Registry repo switch: a box's roller only accepts digests inside its baked repository | Medium | Switch happens through the live-update path that regenerates the roll script and compose together, per box, never by edit. |
| R5 | Rebuilding the web bundle needs `npm install` of the whole upstream workspace (~5 min, ~1.5 GB) | Low | Self-hosted build machine, cached. |
| R6 | Stock image carries more (full desktop, browsers) so the attack and update surface grows | Low to medium | Same as upstream; pin by digest. |
| R7 | Ash decides to want a runtime metering sidecar later | n/a | Build it as a plugin on upstream hooks (`pre_gateway_dispatch`, `pre_api_request`) or ask for an upstream hook; do not revive the decorators. |

Effort to keep current, after migration: one build per upstream release (about 30 minutes of machine
time, plus reading any red check) instead of a merge, conflict resolution, a fork CI run and an
image-proof ladder. Cost of the migration itself: P1 (one dashboard PR), P2 (a build machine), the
waves.

## 11. Decisions for Ash (all staged in `~/Projects/ops-notes/decisions.md`)

1. Create the `ghcr.io/ashneil12/hivra-hermes` package and a write token for the build machine
   (credential, so yours).
2. Approve the one recommended upstream PR (held lock), or choose the compose `pid:` alternative.
3. Keep the dormant metering seams in the overlay, or delete the module until a real sidecar exists.
4. Archive the fork repos once the fleet has moved (after wave 4 plus one release).

## Where things are

- Overlay: `agent-overlay/` (README there). Build: `scripts/build-overlay.sh`. Guards:
  `scripts/check-overlay.sh`, `scripts/run-tests.sh`. Experiment stub: `scripts/stub-llm-and-governor.py`.
- Delta by file: `docs/release/NO-FORK-DELTA.tsv`.
- Fixture: restored to the fork image; its doctor result is FAIL=0. Revert notes are not needed.
