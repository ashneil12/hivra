# Hivra public website redesign

## Review

- Local phone preview: http://192.168.1.157:4191/
- Blog: http://192.168.1.157:4191/blog
- Exact final founder text: http://192.168.1.157:4191/docs/litepaper/index.html#founder
- Requires the preview Mac to remain running and the phone to be on the same LAN.

Branch: `codex/hivra-website-redesign`, based on `68711c043` (the owner's
`Redesign` checkout, also the head of `codex/hivra-integrated-window`). The
website review is stacked on that branch so its diff contains only this work.
The pre-existing dirty litepaper files in the original checkout were preserved.

## Design and coverage

Graphite, red, Manrope and IBM Plex Mono now connect the public pages. A scoped
`PublicSite` frame provides navigation, native mobile dialog, theme/language
controls, reading progress and footer. It does not alter the authenticated
application's root styles or layouts.

The homepage has a new computer scene with desktop/terminal/files controls,
an interactive workspace illustration, numbered agent rows, asymmetric feature
and use-case layouts, setup steps, pricing presentation, native FAQ disclosures
and a large red vision section. Illustrations identify themselves as examples;
they do not present fabricated jobs or live machine state.

Public templates covered:

- Homepage.
- Blog index and all 24 registered article pages.
- Feature index and all six registered detail pages.
- Comparison index and all five registered detail pages.
- Why Hivra, roadmap, token, changelog, stats, status, privacy, terms and newupdate.

Article layouts support a section index, reading progress, Markdown, tables,
code blocks and related reading. Article registries, feature/comparison data,
metadata, structured data, RSS, unknown-slug handling and legal prose are
preserved. Existing locale data, plan slugs, launch CTA IDs, polling and token
contract controls remain connected to their original sources. The English
homepage headline adopts the final litepaper's headline; other locales keep
their translated heading. This visual change preserves the Canary branch's
commercial/catalogue data; it does not change billing policy or claim parity
with a different production revision.

External article links and Nibbii open a separate tab with `noopener noreferrer`.
Ordinary site navigation stays in the current tab. Explicit document links from
the homepage open another tab; navigation links to the litepaper remain normal
site navigation.

## Litepaper text contract

`LITEPAPER.md` is byte-identical to the supplied `Hivra_Litepaper_Final.md` and
the committed approved snapshot. SHA-256:
`792426ce866428fa34cbd0e7726177ff3b288482138285a97525964909813d5d`.
Check the actual source hash when reproducing; the source comparison tests are
authoritative.

The supplied founder section was already the same wording as the redesigned
litepaper source. Its only whole-document difference was the final newline.
All ten founder paragraphs, including the Christian paragraph and research
links, were checked in the served page. No viewpoint or prose was rewritten.
All 15 product stories and 14 token utilities are retained. Related product
lists use labelled buttons with the same names/order. The separate longer
`WHY.md` essay remains a clearly labelled placeholder; that essay was not
supplied.

`predev` and `prebuild` stage 19 explicitly approved public artifacts. They do
not expose the repository or historical review exports. The page is available
at `/docs/litepaper/index.html`; `/docs/litepaper/` redirects there. See
[the integration instructions](../litepaper/INTEGRATION.md).

## Verification

- Full Next.js production build, TypeScript, prerendering and postbuild pass in
  a disposable copy with installed dependencies. No production credentials.
- The initial automatic Vercel preview at `00bfc4d41` failed before compilation:
  the existing root `.vercelignore` excluded `/docs/`, including required
  litepaper build inputs. Local build success did not cover that packaging step.
  A narrow input allowlist fixes the packaging defect. A regression filters
  real sources with Vercel's ignore semantics, excludes private sentinels and
  successfully stages all 19 public files. Hosted acceptance requires the
  subsequent Vercel build; the local preview remains the verified delivery.
- Focused ESLint passes for the modified implementation.
- 13 focused Jest suites, 45 tests: hero/locales, scene controls, workspace
  controls, FAQ content, setup, use cases, pricing, footer, mobile navigation,
  article links, blog, changelog/RSS and token disclosure.
- Six litepaper content tests, four link-policy tests and five staging tests pass.
- Litepaper generator freshness and staged-byte checks pass.
- Read-only content audit: all metadata/structured-data ASTs inspected remain
  unchanged; privacy's 80 and terms' 22 text/expression blocks match their source.
- Browser checks at desktop and phone sizes: homepage; blog index/article;
  feature index/detail; comparison index/detail; all other listed public routes.
  No document overflow found at 390px; article reading also checked at 320px.
- Native menu opens, traps focus, closes on Escape and returns focus; route
  navigation closes it and restores scrolling. Article anchors land below the
  header. Computer/workspace controls switch the illustrated content.
- Both light/dark themes checked. Motion uses transforms/opacity and respects
  reduced-motion CSS; native disclosures keep FAQ content in the document.
- The built production artifact is served on loopback port4192 behind a
  GET/HEAD-only LAN relay on4191. Real phone-preview navigation, illustration
  controls and theme switching were verified in the browser. The development
  server is not the delivery surface.

The phone relay exposes only named public routes and static assets, rejects
mutations/private routes/traversal, and forwards no authentication headers or
cookies. Signup/login navigation goes to the real Hivra site; account and
billing workflows were not exercised. Status/statistics in this isolated
preview are not evidence about the production fleet. No public deployment,
merge, provisioning, wallet action or customer mutation was performed.
