# Hivra responsive polish — rollout receipt

This follow-up adapts the existing Hivra workspace to phone, tablet and desktop widths. It preserves the dark/paper palette, crimson accents, etched borders, typography and existing resource workflows.

## Changed behavior

- Home, Agents, Computers, Launch and Settings respond to their available content width, including the space consumed by the sidebar. Narrow layouts stack controls, wrap long content and keep primary actions reachable. Wide layouts retain bounded reading widths.
- At tablet widths, the sidebar starts as a compact rail and can expand temporarily. This does not overwrite the saved desktop preference. Selection, outside interaction and Escape close the temporary expansion; keyboard focus returns appropriately.
- Resource headers and toolbars use the available pane width. Common surfaces and Manage retain accessible names when compact; the Tools popup uses measured available space and scrolls within the visible area. Opening navigation controls preserves the work pane.
- The workspace reacts to observed software-keyboard occlusion on phones and touch tablets, including iframe and editable-content focus. It reclaims bottom-navigation space while typing and restores normal sizing afterward. The heuristic requires editable or iframe focus, near-default zoom and more than 150px of observed occlusion.
- Launch and host selection have larger touch targets and readable inputs. Capacity details and review text wrap instead of clipping. Settings, Applications and Help share the same responsive treatment; the Settings language list expands in the page flow on narrow screens and retains its desktop popover.

Launch stages, authority/capacity checks, request IDs, receipts, authentication and native access contracts remain intact. This is dashboard polish, not a new native binary or a public-release milestone.

## Revisions and target

- Starting baseline: `c12530c6b`.
- Initial review revision: `d40023dee`; final code review revision: `f836876c1`, on the existing [draft PR #606](https://github.com/ashneil12/hermesdeploy-canary/pull/606).
- Initial responsive delivery: `94ce3af3a12d4b32362ea6ec3e9aa301b5ba6ebb`.
- Final code revision: `16d300460ef53a624e50de95cfa50a1b513a3363` (three-line mobile language-menu adjustment).
- Delivery was rebased to retain Windows fixes `f73521e39` (complete capability receipt) and `b6921c744` (inspection progress output).
- Authorized deployment target: project `hermesos-canary`, custom environment `canary`.
- First READY deployment: `dpl_29gnMBAYN1K7WnvaGB7czZRVAR2A`.
- Deployment URL: <https://hermesos-canary-3r4o4s6wh-ashneil12s-projects.vercel.app>.
- Final READY deployment: `dpl_3EcE2nGWEGzEgG96bUK3SwtyWUXE`, <https://hermesos-canary-bfkhhtjcx-ashneil12s-projects.vercel.app>.
- Deployment metadata verified the final SHA, project and custom Canary environment. The `canary.hermesos.cloud` alias was assigned and inspected against that exact deployment. Authenticated browser acceptance completed on 2026-09-09 at approximately 00:20 UTC.

Canary deployment is complete. PR #606 remains an open draft and is unmerged. Public production was not changed.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Focused UI, keyboard, menu and native tests before rebase | 22 suites, 335 tests passed | `/tmp/hivra-responsive-focused.log` |
| Native capability tests after rebase | 2 suites, 58 tests passed | `/tmp/hivra-responsive-native-rebase-tests.log` |
| Delivery TypeScript and lint | Passed; migration manifest unchanged | `/tmp/hivra-responsive-typecheck.log`, `/tmp/hivra-responsive-lint.log` |
| Review branch focused tests | 19 suites, 259 tests passed | `/tmp/hivra-responsive-review-tests.log` |
| Review branch TypeScript | Passed; migration manifest unchanged | `/tmp/hivra-responsive-review-typecheck.log` |
| Final language-menu adjustment | 16 Settings tests passed; CSS parsing and diff check passed | Focused Settings verification |
| Final Vercel build | Passed compilation, TypeScript and build | `/tmp/hivra-responsive-final-deploy.log` |

These are separate verification runs with overlapping coverage, not an aggregate test count. Behavioral regressions cover tablet sidebar preferences, keyboard occlusion/recovery, menu geometry and keyboard navigation, session handling and authenticated surfaces. CSS layout fixes use rendered geometry evidence because JSDOM does not implement container queries; DOM tests alone do not establish that a layout fits a screen.

The earlier full-suite baseline failures are recorded in [the core workspace receipt](./rollout.md). This follow-up does not claim a newly passing full repository suite.

## Authenticated browser acceptance

**PASS for the inspected responsive dashboard flows.** Chrome in a separate task tab; desktop viewport emulation rather than physical mobile devices. The screen matrix was exercised on `94ce3af3a`; the only subsequent code change was the mobile Settings language list. That final behavior, account pages and preserved Home state were accepted on `16d300460`.

| Area | Observed result |
| --- | --- |
| 320×568 resource workspace | No horizontal overflow. Header and tabs each measured 53px; common tabs fit one row. The status/work pane measured 260px high. Its controls were reachable in the pane's scroll area and measured 44px high. |
| Phone Tools | At 320×568, popup y=194–496, above the bottom navigation at y=504. After scrolling, Export measured y=444.9–488.9. At 740×390 landscape, the popup measured 140px high and ended at y=318, above navigation at y=326. |
| Home and inventories | Inspected Home at 320px, 1024px, 1440px and 1920px; Agents at 390×844; Computers at 320px and 768px. Names and status remained readable, with no page-level horizontal overflow. Windows search isolated one computer; Stopped isolated the stopped agent; clearing filters restored the inventories. |
| Tablet navigation | At 768×1024, the rail measured 72px. Expanding it to 256px left the main workspace unchanged at x=72 and width=696. Escape closed the overlay; desktop expansion returned at 1024px. The saved collapsed desktop preference was restored after testing. |
| Wide desktop | At 1920×1080, Home's outer content was capped at 1280px and centered within the space after the sidebar. Both inventories remained visible side by side. At 1024×768 with the expanded sidebar, panels stacked within the available width. |
| Search and switching | At 740×390, the search dialog kept its input and footer visible around one scrolling result list. Filtering and Enter opened the chosen agent and closed the mobile drawer. The selected resource surface remained correct. |
| Launch | At 320×568, Computer → Ubuntu → Configure → Review completed without submitting Launch. Name, hosting, capacity guidance and review text wrapped. Back retained the test name. The final Back/Launch controls were 44px high and ended at y=476.2, above bottom navigation at y=504. Configuration also fit the 768px tablet layout. |
| Settings and themes | At 320px, theme choices remained usable. Settled Light mode retained the paper palette with rgb(26,26,26) text; System was restored. Final language-list width was 258px at x=29–287, position static. After page scrolling, the last 44px option was fully visible at y=316.1–360.1 and the next preference followed at y=407.2–451.2, above navigation at y=504. |
| Applications and Help | Both were inspected at 390×844 with no horizontal overflow. Account destinations, installation guidance, support and legal links remained accessible. No installation or outgoing message was triggered. |
| Browser console | No errors during inspected flows; only the existing Clerk development-key warning for Canary. |

Preservation: the account still showed 3 agents and 3 computers, comprising 5 running and 1 stopped. No resource was launched, restarted, updated, stopped or deleted; no agent prompt, guest input, file edit or purchase was made. The unsubmitted test draft was reset through the catalog's new-launch flow, then Cancel. System appearance and the collapsed sidebar preference were restored. Viewport emulation was reset to the original 1291×744 window and the browser was left on Home. The original native Omarchy/browser session was untouched.

Software-keyboard behavior is covered by focused simulations for input/iframe focus, viewport occlusion, touch tablets, pinch zoom, blur, resize and cleanup. **Physical iPhone/iPad/Safari keyboard and safe-area acceptance remain unverified.** The selected Codex connection/runtime update guard remained visible. This pass does not claim live chat/terminal execution or renewed native desktop acceptance; existing runtime gates were preserved.
