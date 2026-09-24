# Native workspace contract

Test fixtures for the contract between the dashboard and a native desktop shell.
The dashboard's Jest suite and the Mac app's `swift test` both read these files,
so a change that passes one side but not the other fails the suite on the side that
drifted. Dashboard CI runs the Jest side; no CI job runs `swift test` yet, so run it
locally (`cd apps/macos/HivraMac && swift test`) when these files or the Mac grammar change.

This directory holds data only. Nothing here is built into the dashboard or an app,
and it is unrelated to the Solidity sources in the repository's root `contracts/`.

| File | Contract | Checked by |
| --- | --- | --- |
| `route-grammar.v1.json` | Which dashboard hrefs a shell may adopt into a tab or ask the page to open, and their canonical form | `dashboard/src/lib/__tests__/native-route-grammar.test.ts`, `apps/macos/HivraMac/Tests/HivraMacTests/HivraNativeContractTests.swift` |
| `primary-navigation.v1.json` | The primary sidebar destinations, their labels and their order (Command/Ctrl 1-5 in a shell) | the same two suites |

## Route grammar

Implementations: `dashboard/src/lib/native-route-grammar.ts` (used by
`nativeDashboardHref` for `hivra:navigate`) and
`apps/macos/HivraMac/Sources/HivraMacCore/HivraWorkspaceRouteGrammar.swift` (used for
tab adoption, reselection, inventory hrefs and navigation requests). Every case's
`expect` must be returned exactly by both; accepted results must also be fixed points.

- Security rejections stay strict: absolute or scheme-relative URLs, anything outside
  `/dashboard`, non-printable or non-ASCII input, backslashes, traversal, encoded
  separators, double encoding, malformed escapes and repeated parameters.
- A fragment is discarded, never forwarded.
- Each route family lists the parameters it keeps (validated and written in a fixed
  order) and the one-shot arrival parameters it discards (for example `welcome` on
  a launch result). Any other parameter rejects the route, so the page that owns it
  (billing returns, checkout results) keeps handling its own URL.
- `shell` records what a shell derives from the canonical route: the resource tab
  identity (`x-<id>` for `/dashboard/agent/<id>`, `h-<id>` for
  `/dashboard/instances/<id>`) and the sidebar destination. Only the Swift suite
  checks it today, because only the Mac app implements it.

When the dashboard adds a query parameter to a route a shell can observe, add
fixture cases and update both implementations in the same change.
`native-route-grammar.test.ts` also runs the dashboard's own href builders (launch
results, launch links, capacity handoffs, the native inventory) through the grammar,
so a builder that emits an unrecognized parameter fails there first.

## Versioning

The `version` in each file names the contract revision both implementations
declare (`NATIVE_ROUTE_GRAMMAR_VERSION`, `HivraWorkspaceRoute.grammarVersion`).
Accepting a new parameter or route is a compatible change within a version; changing
what an existing input canonicalizes to needs a new version and a new file.

These fixtures do not change the v1 bridge messages (`workspace`, `surfaces`,
`hivra:navigate`, `hivra:select-surface`): the shipped Mac parser rejects unknown
keys, so new fields belong to a future negotiated protocol version.

## Current state

The Mac alpha (`apps/macos/HivraMac`) is the only shell. It identifies itself with
the `HivraMac/<version>` user-agent token. Other desktop shells are planned to use
`HivraDesktop/<version>`; none exists yet, and any that ships must pass these fixtures.
