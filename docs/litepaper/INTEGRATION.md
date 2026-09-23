# Main website integration

The approved litepaper is `LITEPAPER.md`, pinned by `APPROVED_SOURCE_SHA256` in
`dashboard/scripts/stage-litepaper.mjs` at SHA-256
`11313c967764fac0691f08ac9670db2b40543f8f2395d5ac876d4dcf4d091310`
(v2.1, approved 23 September 2026). `test_content.py` checks the source against
that pin. The founder section, all 15 product stories and all 12 token utilities
are intact. The linked `THOUGHTS.md` publishes the founder section and its
references as a standalone document.

## Build and public files

`dashboard/scripts/stage-litepaper.mjs` copies 19 explicitly named HTML, CSS,
JavaScript, font, image, library and Markdown files into `dashboard/public`.
It runs before the existing `predev` and `prebuild` hooks. Generated copies are
ignored by Git; source files remain under this directory and the repository root.
The script does not copy source scripts, ZIPs, environment
files or other repository content. It rejects symlinks, unexpected files in the
generated litepaper directory, missing inputs and source wording that differs
from the approved SHA-256 pinned in the staging script.

The site redirects `/docs/litepaper` to `/docs/litepaper/index.html` so the
document's relative assets resolve correctly. With `trailingSlash: false`,
`/docs/litepaper/` first normalizes to the path without the ending slash.
The full static document is served outside the React page layout. Its CSS and
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

The Node stage step copies the committed generated HTML; it does not require
Python in the deployment build environment. Renderer freshness and wording
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
