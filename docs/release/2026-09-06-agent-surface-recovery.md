# Canary agent surface recovery — 2026-09-06

## Navigation fix: accepted

Source `5c9ba0dfb1018495859ad8264666b1d4136c8dd9`, PR #600 branch
`codex/hivra-core-experience-plan`. Canary project
`prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA` only. Clean source archive built as
`dpl_68M8jUgJCX68wz6DDFH4th6XXVg6`, reached Ready, then promoted. Vercel inspection
of `canary.hermesos.cloud` resolved that exact deployment. No actual-production
project, database migration, guest bundle or installed runtime changed.

Before: the existing CODEX_AGENT native terminal displayed “Connection update
needed” and told the owner to open Manage, but offered only Check again. Manage
was beyond the visible portion of the horizontal tab strip at this viewport.

Change: legacy and unavailable authenticated surfaces now offer Open Manage
beside the existing retry action. The callback selects the local Manage tab;
it does not dispatch an update, restart or auth fallback. Native terminal,
Box Terminal, embedded agent dashboard and Browser all use the same action.

Checks: all 77 agent page tests passed, including navigation from legacy
terminal/browser/dashboard and unavailable Box Terminal without a bootstrap
submission, extra fetch, iframe, or exposed token. Touched-file ESLint and
`tsc --noEmit --pretty false` passed. Normal-risk verification plan was used.

Live acceptance around 23:40 UTC on 2026-09-05 (00:40 London on September 6):
opened `/dashboard/agent/00000000-0000-4000-8000-000000001055`, observed the new
Open Manage button, clicked it and saw the real Manage panel including Update
& restart. Computer remained Running, 2 CPU / 4 GB, VM 1104. No lifecycle,
model setting, credential, cookie-import or restore-point control was pressed.
This proves navigation, not that the old Codex runtime has been updated or can
perform inference. Rollback is the prior Ready Canary deployment
`dpl_FatGMZxH9tfQ79uWFRJYU9FR1aC7`; rollback was not needed or exercised.

## Native Agent Zero check: model connection missing

Opened the existing owned Canary fixture CANARY_CHANNEL_A0_0905,
`00000000-0000-4000-8000-000000001017`. Its real Agent Zero dashboard rendered
through the normal authenticated iframe. Before testing, it listed no chats.
Submitted one short no-tools/no-files/no-settings prompt asking for the marker
`HIVRA_AGENT_ZERO_REPLY_OK`. The native application instead displayed its model
connection picker and said the message would send after connection. No model
reply was received. No model account or key was added; a greeting or a rendered
dashboard is not inference evidence.

Cleanup: Clear Chat reset the greeting but the pending model-setup prompt
remained visible. This is a separate observed native cleanup issue, not fixed
by the navigation patch. Used the test chat row's Close chat confirmation
instead, then reloaded the Hivra page. The native dashboard again showed
“No chats to list” and the empty welcome composer, with no pending test prompt.
The fixture, its settings and pre-existing data were not destroyed or changed.
The disposable test conversation was removed; no other conversation existed in
the displayed list or was targeted.

No additional Hetzner resources or reservation. Conservative campaign
reservations remain GBP 5.90 / GBP 10, not invoice totals. The full core goal
remains incomplete: native model access, remaining runtime/OS launch paths,
Omarchy lease/route integration, Windows acceptance and full recovery are not
closed by this scoped result.
