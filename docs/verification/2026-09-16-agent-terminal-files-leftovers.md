# Canary verify — Hivra agent terminal + files leftovers

**Outcome:** Hivra agent terminal and files integration  
**Register:** https://app.notion.com/p/3dd7ce4e9faf8182963ec4eaaa3fd627  
**Codex continue-from:** `01a0a679-2c4d-7201-a0dd-ef2e4f49a080`  
**Impl tip:** branch `codex/agent-terminal-files-leftovers-20260916` (from `codex/agent-computer-integration-20260915` / PR #622); leftovers implementation + regression tests committed in `e341dbcbd` (2026-09-17)  
**Live surface:** https://canary.hermesos.cloud/dashboard/computers?hivra=1  
**Prior deploy receipt (PR #622):** tip `2dee8050aed8f1ae38e2f7232f2a53800c5d9c11` → Vercel `dpl_CAQytcdTxWqaYBt4airEHnHgMjmW` (promote current tip before scoring if alias moved)

## Acceptance map

| # | Acceptance | Pass when TRUE | Fail when FALSE |
|---|------------|----------------|-----------------|
| A1 | Human-control isolation / cross-path proof | Agents + Terminal + Files share one workspace; human-control boundary holds; health is **not** inferred from powered-on VMs alone | Workspace bleed across computers, or Ready/healthy solely because VM is powered on |
| A2 | Terminal + Files tab chrome = Desktop (NAV-5) | Desktop / Terminal / Files same chrome/mental model across Ubuntu + Omarchy + Windows (VMware-simple) | Tab labels/placement/chrome differ by runtime or look like separate products |
| A3 | Evidence linked | This file + tip SHA linked on Outcome Register Evidence | Chat-only claims |

**Out of scope:** Clawith; sibling PRs #623/#624/#625; reliability/desktop-launch isolation leftovers.

## Preflight

1. Confirm tip SHA under test on Canary Production alias `canary.hermesos.cloud` (Vercel Ready).
2. Sign in as Ash/QA. Use Chrome (not Arc).

## A1 — Human-control isolation / cross-path

### Click path
1. Computers (`?hivra=1`) → one **ready** Ubuntu agent computer.
2. **Desktop** → confirm human-control / takeover affordance (take/relinquish; no silent exclusive agent control without UI).
3. **Terminal** (same computer) → note workspace/cwd.
4. **Files** → note root/workspace path.
5. Re-enter same computer via a second path (agent row vs computers list). Repeat Terminal + Files path read.
6. Open a **second** computer. Compare Terminal/Files roots.
7. Find powered-on but not capability-ready (or Manage/lifecycle status). Confirm UI does **not** treat powered-on alone as consumer Ready/healthy desktop.

### Expected
| Check | Expected |
|-------|----------|
| A1.1 Same computer Desktop↔Terminal↔Files | TRUE — one workspace identity |
| A1.2 Cross-path re-entry | TRUE — same paths; no second tree |
| A1.3 Different computer | TRUE — distinct workspace; no bleed |
| A1.4 Human-control | TRUE — human can take control on Desktop; Terminal/Files do not bypass isolation story |
| A1.5 Powered-on ≠ healthy | TRUE — powered-on without capability receipt ≠ consumer Ready desktop |

### Evidence
Screenshots A+B paths; powered-on-not-ready status; tip SHA + deploy id.

## A2 — NAV-5 Terminal + Files chrome vs Desktop

### Click path
1. Ubuntu: screenshot tab strip (Desktop / Terminal / Files) — order, labels, selected state, chrome.
2. Omarchy: same.
3. Windows: same, or N/A with explicit gate (guidance → Open Desktop), not silent missing tabs.

### Expected
| Check | Expected |
|-------|----------|
| A2.1 Ubuntu | TRUE — Desktop / Terminal / Files, consistent chrome |
| A2.2 Omarchy | TRUE — same labels/order/chrome |
| A2.3 Windows | TRUE or N/A — same model or documented Desktop guidance |
| A2.4 Mental model | TRUE — one product (VMware-simple) |

## A3 — Evidence linkage
1. After tip lands: link this path on Outcome Register **Evidence**.
2. Fill Results below.

## Results (QA fills)

| Check | Result | Notes |
|-------|--------|-------|
| A1.1 | | |
| A1.2 | | |
| A1.3 | | |
| A1.4 | | |
| A1.5 | | |
| A2.1 | | |
| A2.2 | | |
| A2.3 | | |
| A2.4 | | |
| Tip SHA | | |
| Deploy id | | |
| Overall A1 | | |
| Overall A2 | | |
| Ready for Dept accept | NO until both Overall TRUE | |

## Sibling pointer
Isolation leftovers for desktop launch/reconnect (PR #625 lane) stay on that sibling.

## Dev note (2026-09-16 ~23:00 BST)
Prior Codex tip on PR #622 already includes Windows/Omarchy disconnected-tool guidance, legacy View Only browser default, capability projection, and bounded Canary browser acceptance (`docs/verification/2026-09-15-agent-computer-integration.md`). This leftover pass adds the QA checklist for A1–A3 only. Mac `git` CLI blocked by Xcode license — commits via GitHub API. Do not score until the tip under test is the live Canary alias.

## Dev note (2026-09-17) — leftovers implementation landed

Leftovers implementation + regression tests committed in `e341dbcbd`: provider-desktop refresh codes (`provider_desktop_refresh_required` / `provider_desktop_unverified`) stop the repair loop with an honest unavailable state, auto-prepare is gated to computers without a box connection, Files labels the shared workspace root `Hivra/`, and missing box credentials explain Update & restart instead of a false connection error. Focused checks on `e341dbcbd`: HivraRemoteDesktop 50/50, agent page 94/94, TypeScript, ESLint, `git diff --check`. Not deployed; do not score until the tip under test is the live Canary alias.