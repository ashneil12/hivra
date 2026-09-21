# Computer tab state across refresh and native Detach

Source checkpoint: `180f66cc7164b0e4916af4a9568788dafa135d99`.
Status: PASS for this bounded tab-state repair, including the live Mac journey
below. This does not establish full core or multi-OS completion.

## Defect and repair

The preceding Mac acceptance found that selecting Manage on a computer left
`tab=desktop` in the URL. Refresh and native Detach consequently reopened the
wrong surface even after the native app's stale-navigation-state repair.

The detail page now replaces its current history entry with the selected tab,
preserving the computer path, unrelated query parameters and fragment. It uses
the [Next.js-supported native History API](https://nextjs.org/docs/app/getting-started/linking-and-navigating#native-history-api)
without a document reload or a history entry per tab click. Changed valid deep
links also update the displayed tab. An opened desktop remains mounted through
local tab switches; reloading directly on Manage does not start a desktop.
The existing cross-computer chat/terminal preference is unchanged.

## Source verification and target

- 79 focused AgentPage tests passed, including URL preservation, unchanged
  history length, retained desktop identity, remount on Manage, changed deep
  links and invalid-tab handling.
- Scoped ESLint and full dashboard TypeScript checks passed. The initial
  effect-based reconciliation failed lint; guarded reconciliation before
  rendering replaced it and the checks were rerun successfully.
- Risk recommendation: normal; no database, guest, permission, credential,
  lifecycle or provisioner release change.
- Clean archive: `/tmp/hivra-canary-tab-state.2UbBUo`. The changed page's
  SHA-256 matches the source checkout:
  `6261768b4fe5f4aaefe8a9f51f284657461d089dc095cccfc783a161ea574a8b`.
- Exact authorized project: `hermesos-canary`,
  `prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`, root `dashboard`, Node 24.
- Candidate deployment: `dpl_5B6Mp9xMfwRUm4JnhybmSnyRNTyW`.
- Previous accepted Canary / rollback target:
  `dpl_68M8jUgJCX68wz6DDFH4th6XXVg6`.

The actual production project is outside this change. No Hetzner resource or
additional spend is required for this verification.

## Live acceptance, 2026-09-06 00:30–00:32 UTC

The candidate reached Ready, was promoted only within `hermesos-canary`, and
Vercel inspection confirmed `canary.hermesos.cloud` resolves to
`dpl_5B6Mp9xMfwRUm4JnhybmSnyRNTyW`.

Used the existing signed-in local Mac Alpha from source `3f30a43c7` (the exact
binary is recorded in the [Mac navigation receipt](2026-09-06-mac-history-navigation.md)).
Refreshed its inventory to load this web deployment, then opened the existing
CANARY_ALIGNED_UBUNTU_0905 computer, VM 1120,
`00000000-0000-4000-8000-000000001025`.

1. Selected Files. The actual WebView URL changed from `tab=desktop` to
   `tab=files`; the normal file listing rendered.
2. Pressed native Refresh once. Files remained selected and its listing
   returned; no second refresh or Desktop redirect was needed.
3. Selected Manage. The URL became `tab=manage` and the existing computer's
   management panel rendered.
4. Pressed native Detach. A separate Hivra Surface window opened the exact
   computer URL with `tab=manage` and displayed Manage directly, not Desktop
   or Home. A transient screen-capture error was resolved by rereading that
   same window; no second Detach action was submitted.
5. Closed the test-created window and returned the main window to Computers.

No files, credentials, computer settings or lifecycle controls were changed.
Read-only Canary database observation confirmed the sole desktop session
created in this check, `00000000-0000-4000-8000-000000001094`, was revoked at
00:31:00.589477 UTC and `input_state=released` at 00:31:01.209879 UTC.
No owned temporary desktop access remains. No provider resource was purchased
or removed. The previous deployment remains the rollback target; rollback was
not exercised.

Remaining scope: physical monitor changes and multi-monitor DPI are not proved
by tab-state tests. Native Omarchy, Windows, all agent inference paths and the
complete core goal remain open. Detach still opens another window; active
controller-lease transfer is not implemented by this change.
