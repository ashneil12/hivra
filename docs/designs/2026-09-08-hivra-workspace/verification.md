# Design preview verification

**Date:** 8 September 2026. **Result:** ready for design review. This is acceptance
of a standalone prototype, not acceptance of a deployed dashboard change.

## Targets and scope

- Live observation: authenticated `https://canary.hermesos.cloud`, core dashboard
  routes listed in `audit.md`, and the running Mac Alpha at
  `apps/macos/HivraMac/dist/Hivra.app`. The deployed web revision was not resolved.
- Source reference at audit start: `2c4c5519cf2b42b61b3539595c6691a9f5d0bacb`.
  Concurrent native-desktop work continued separately during this review.
- Prototype: this directory, served only on `127.0.0.1:4196` and exercised in the
  Codex browser. It has fictional fixtures, no credentials and no backend calls.

## Automated checks actually run

`node --test docs/designs/2026-09-08-hivra-workspace/prototype.test.cjs`:
**7 passed, 0 failed**. The tests exercise:

1. Agent draft isolation when switching recipients and reloading.
2. Launch configuration restoration in a fresh page.
3. Honest feedback when browser storage is denied.
4. Arrow-key tab selection, roving focus and named tab panels.
5. Launch-step focus and dialog return focus.
6. Skip-link focus without changing the selected resource route.
7. A static ambient network under Reduce Motion, with animation paused while
   the browser tab is hidden and correctly resumed when visible.

`node --check docs/designs/2026-09-08-hivra-workspace/app.js` passed.
The same syntax check passed for `atmosphere.js` after the identity revision.
The DOM tests use JSDOM from the dashboard's installed development dependencies.
They do not verify real layout or runtime integration.

## Browser checks actually performed

| Check | Observed result |
| --- | --- |
| Desktop at 1280 × 720, dark and light themes | Home, inventories and agent workspace render with the shared shell; details starts closed. |
| Agent switching | Atlas draft remains with Atlas; Patch opens its native entry; switching back and refresh restore the draft. Deleting the text also persists after refresh. |
| Command switcher | Cmd+K opens search, searching Sandbox isolates the computer, selection opens its stopped-computer view without a composer. |
| Inventory search and filters | An unmatched search gives an explicit empty state; Needs attention shows Scout. |
| Manage | Agent configuration is grouped on the selected resource; review opens a named dialog and clearly states that no action occurred. |
| Tabs and dialogs | ArrowRight moves from Conversation to Native interface and focus follows. Escape closes overlays; dialog and inspector focus return were checked. |
| Launch at 980 × 690 | Choose, Configure and Review remain reachable. The body scrolls inside a bounded dialog; footer actions stay visible without covering form controls. |
| Launch persistence | Save produces a local-draft confirmation; refresh and New restore the review configuration. |
| Short window at 740 × 390 | Content scrolls. The whole sidebar scrolls at this height; keyboard navigation reaches Settings and the theme control within the viewport. |
| Mobile layout at 390 × 844 | Navigation becomes a drawer. Selecting an agent closes it; the agent tabs and composer fit. Launch configuration retains visible Back/Continue controls. |
| Mobile navigation focus | Drawer contains keyboard focus and hides background controls from accessibility navigation while open. |
| Browser console | No log entries were returned at the final check. |

After the identity revision, the same browser received a fresh pass at 1280 ×
720 (Home and agent workspace), 980 × 690 (paper theme and launch review),
740 × 390 (keyboard access to the sidebar footer), and 390 × 844 (Home,
conversation and navigation). Home's two panels and attention row fit within
the laptop view. Mobile has no page-level horizontal overflow; the Files label
and composer remain visible. The mobile icon-only attention action now has an
explicit accessible name, verified in the browser's accessibility query. This
small label fix was checked in the rendered UI instead of an implementation-only
unit assertion. All seven interaction tests passed again after the revision.

This is responsive browser verification, not testing on a physical phone or in
Safari. It is not a complete accessibility audit. Visible keyboard focus,
dialog names, tab semantics and primary-control contrast were reviewed; a full
screen-reader and touch-keyboard pass remains implementation acceptance work.

## Changes made following review

- Reduced sidebar duplication and secondary links; retained the original H.
  wordmark and bundled the existing typefaces for an offline preview.
- Made short-window navigation scrollable and constrained launch-dialog body
  scrolling so controls do not cover the name field or disappear below the window.
- Added contextual Manage groups and clearer launch placement/resource review.
- Corrected subtle text contrast, focus treatment and small-screen control sizing.
- Restored saved launch drafts on reload; validated stored values and handled
  storage failures without falsely claiming persistence.
- Added proper keyboard tab behavior, dialog focus and a route-preserving skip link.
- After the user's aesthetic review, replaced the softened palette and rounded
  surfaces with the current black/paper/crimson palette, sharp etched borders,
  white primary controls, Space Grotesk/Outfit/Space Mono and editorial serif
  headings. Corrected the earlier Playfair attribution against computed live styles.
- Restored grain and the decorative red network, capped at 36 points and 24 fps,
  with a static reduced-motion view and no animation in hidden tabs.
- Reunited agents and computers in adjacent Home panels at wide widths.

## Preservation and remaining work

The live walkthrough sent no agent messages, launched no resources, purchased no
capacity, and performed no power, update, reconnect or configuration operations.
The Canary launch form was restored to its initial unselected state and its
sidebar to the initial collapsed preference. The Mac app was observed only.

The local review draft text was cleared, the launch preview returned to Choose,
and browser viewport overrides were reset. The local preview server remains
running deliberately for review; stop it when no longer needed. Browser-local
theme and fictional draft preferences may remain.

No production dashboard source or native application bundle is modified by this
proposal. No deployment, merge or runtime repair is claimed. Chat adapters,
desktop access, sessions, real activity, actual launch capability/quotes, billing,
credentials and native installation still need the integration and live checks
listed in `implementation-plan.md`.
