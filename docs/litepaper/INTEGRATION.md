# Main website integration

The approved litepaper is `LITEPAPER.md`, pinned by `APPROVED_SOURCE_SHA256` in
`dashboard/scripts/stage-litepaper.mjs` at SHA-256
`6c4b5015fcdc7e529e285e53015262be7a4606258f21291e097f6ccd04cdc2b9`
(v2.6, plain-English pass with a rewritten token section and a Tokenomics button in the hero, 30 September 2026; the token wording still needs UK financial-promotion and legal review before it is published). v2.5 rewrites the hard words outside the founder letter for a 12-year-old reader: it defines "AI agent", "model", the cloud, open source, snapshots, virtual machines and containers where they first appear, and swaps jargon (terminals, repositories, SSH keys, credentials, tenants, MCP servers) for plain words. v2.4 (28 September 2026) opens with the real risk: a harder problem section, a new "This is not a future problem" evidence chapter, the full-computer and computer-use case in the positioning, a rewritten founder letter from Ash's draft (his scripture passage kept word for word; THOUGHTS.md keeps the fuller original with its references), and "Keeping a mistake from reaching everything" renamed "The boundary lives outside the model". v2.3 rewrote the page in plainer, shorter
language, treats every surface it names as live (no preview labels, at Ash's
direction), adds Windows desktops to the positioning, simplifies "Keeping a
mistake from reaching everything", trims the 15 product stories and drops the token section's closing line.
v2.2 (same day) added "Keep the agents you like. Move them off your computer."
and moved open source ahead of the founder letter; v2.1 (23 September) was
`8ccc34344b3a00884e6f37295ebefa9208a43c0826632508ea9a68d185dddca7`. `test_content.py` checks the source against
that pin. The founder section, all 15 product stories and all 12 token utilities
are intact. The linked `THOUGHTS.md` publishes the founder section and its
references as a standalone document.

## Build and public files

`dashboard/scripts/stage-litepaper.mjs` stages explicitly named files in two
places. It runs before the existing `predev` and `prebuild` hooks. Generated
copies are ignored by Git; source files remain under this directory and the
repository root.

- `dashboard/public` gets the files that carry no token text: the stylesheet,
  scripts, images, fonts, library files, `THOUGHTS.md`, and the token-free copies
  (`restricted.html` and `restricted/*.md`).
- `dashboard/.generated/litepaper/{full,restricted}` gets the four documents that
  do carry token text (`LITEPAPER.md`, `WHITEPAPER.md`, `TOKENOMICS.md` and the
  litepaper page), each beside its token-free copy. They are not public files.
  Route handlers at `/LITEPAPER.md`, `/WHITEPAPER.md`, `/TOKENOMICS.md` and
  `/docs/litepaper/index.html` read them and pick one by the viewer's country
  (`dashboard/src/lib/compliance/token-geo-documents.ts`), so no spelling of the
  address can reach a full document as a static file. `next.config.ts` carries
  them into each handler's function (`outputFileTracingIncludes`). See
  `docs/token/TOKEN-GEO-POLICY.md`.

The script does not copy source scripts, ZIPs, environment
files or other repository content. It rejects symlinks, unexpected files in the
generated litepaper directories, missing inputs and source wording that differs
from the approved SHA-256 pinned in the staging script. It removes a full token
document that an earlier release left in `dashboard/public`, and `--check`
fails if one is there.

The site redirects `/docs/litepaper` to `/docs/litepaper/index.html` so the
document's relative assets resolve correctly. With `trailingSlash: false`,
`/docs/litepaper/` first normalizes to the path without the ending slash.
The litepaper page is served outside the React page layout. Its CSS and
animations cannot alter the main site's components.

After an authorized source or renderer update, run from the repository root:

```sh
python3 docs/litepaper/build.py
python3 docs/litepaper/build.py --check
python3 docs/litepaper/test_content.py
python3 docs/litepaper/test_link_policy.py
node dashboard/scripts/stage-litepaper.mjs
node dashboard/scripts/stage-litepaper.mjs --check
node --test dashboard/scripts/stage-litepaper.test.mjs
```

The Node stage step copies the committed generated HTML and the committed
token-free copies; it does not require Python in the deployment build
environment. Renderer freshness and wording
coverage are checked by the Python commands above.

## Vercel source packaging

The first Vercel preview at `00bfc4d41` failed before compilation because the
root `.vercelignore` excluded all of `/docs/`, including the approval snapshot
needed by the staging script. Local builds retained those files and therefore
did not reproduce the packaging failure.

The ignore rules admit only the named public Litepaper HTML and assets from the
documentation tree. Required parent directories are reopened explicitly, and
every other file beneath them remains excluded by default. Historical review
files, ZIPs, renderer scripts, internal documentation and unapproved assets stay
outside the Vercel upload. Deployment validates the public Markdown against its
pinned approved hash, so it does not depend on the private review snapshot.

The staging suite now includes a package regression using the installed `ignore`
implementation with directory pruning, matching Vercel's filtering semantics.
It filters the real required source files plus private-document sentinels,
executes the staging script from that filtered package, verifies all 19 public
artifacts byte for byte, and checks that private files are absent. All five
staging tests pass locally. Vercel also built the exact Canary release source
successfully on 9 September 2026.

## Local verification · 9 September 2026

All seven source/content tests, four link tests and five staging tests pass.
The builder and staged-file freshness checks pass. Local Next dev runs on
`127.0.0.1:4190` using local authentication and a disposable randomly generated
JWT secret. Its process environment contains only basic runtime paths, development
mode, telemetry disabled, and localhost app/site URLs. No production environment
file, API secret, customer database or customer instance is configured.
The local process was started directly after the litepaper and migration-manifest
steps; the unrelated Apple certificate download hook was not needed for this
static preview. Normal npm development/build hooks remain preserved.

HTTP requests to both directory forms reach the approved HTML and return 200.
All four linked Markdown documents and sampled image, font, script and stylesheet
requests also return 200 with exact source bytes and the expected content types.
Root coordinates browser acceptance and any full application build separately.
No public deployment or production runtime acceptance is implied by this check.
