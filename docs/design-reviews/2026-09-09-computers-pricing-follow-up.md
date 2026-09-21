# Homepage product expansion and pricing repair

## Request and scope

The owner reported invisible pricing and a homepage that still omitted independent
computers, open source and a GitHub placeholder. This follow-up rebuilds the
English homepage narrative around the final litepaper while preserving the
litepaper file itself, existing translated sections and the public blog layouts.

- Sibling hero links open the existing Agent and Computer launch choices.
- Ubuntu, Windows and Omarchy each have an always-present launch link and an
  interactive explanation. The illustration is labelled as an illustration.
- Hosting explains Hivra Cloud, an owner's cloud/server, self-hosting and model
  keys as a separate choice. macOS and custom images remain upcoming.
- The agent lineup includes Claude Code, Codex, Hermes, Agent Zero, DeepSeek,
  OpenClaw and Aeon. Existing runtime routes are used. DeepSeek links to its
  catalogue entry instead of falsely claiming public launch admission.
- Apache 2.0 and self-hosting have a dedicated section. The GitHub control is a
  visibly disabled placeholder for the pending public repository. No private
  repository URL or fabricated public repository is linked.
- The hero, features, setup steps, use cases, roadmap teaser, FAQ, title/social
  descriptions and structured data now describe computers and agents. The
  rendered English FAQ and schema share one source.
- Founder links now open the actual founder section, separately from the
  retained HermesOS transition note. The approved litepaper is unchanged.

## Source and availability

The current computer catalogue and launch parser accept
`/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop`, `windows` and
`omarchy`. These links open configuration and do not provision by themselves.
Ubuntu uses standard provisioning; Windows and Omarchy depend on compatible
prepared capacity. The older architecture text describing Omarchy as
non-launchable is documentation drift against the current catalogue, not a
reason to hide it on the homepage. This change does not open new runtime or
capacity admission.

Root Apache 2.0 is committed. Public-release verification still identifies final
publication review/approval work; the new GitHub placeholder reflects that.
Current active plan prices and billing destinations remain unchanged. The site
does not promise all operating systems on every infrastructure provider.

## Pricing failure and regression

The original `AnimateStaggerGroup` and every pricing item emitted inline
`opacity:0` during server rendering. Pricing therefore depended on the client
observer/animation. Existing unit tests mocked that wrapper and missed the
invisible first render.

The reported permanently blank state was not reproduced after hydration in the
root's old-preview browser: prices eventually appeared. The initial hidden
markup was directly observed in the served page and reproduced by an unmocked
React server-render regression. It failed against the old component and passes
against the new one. New plans use semantic articles, visible first-render
content and native resource disclosures. No visibility depends on animation.

## Verification

- Ten focused Jest suites, 45 tests pass: pricing including real SSR, OS
  selection/routes, hosting, source placeholder, full English narrative,
  founder links, locale continuity, mobile navigation and footer links.
- Scoped ESLint, full TypeScript, generator freshness, staged bytes and
  whitespace checks pass.
- The final litepaper still contains all 15 products and 14 token utilities;
  this follow-up does not modify its source or generated page.

- A normal production build passes, including TypeScript, 185 static pages and
  postbuild. All 21 affected runtime files in the running build match the source.
- Browser acceptance at `http://192.168.1.157:4191/` passes in a production build:
  all three pricing cards have computed opacity 1, show the actual prices and
  actions, and their native concurrency explanation opens and closes.
- At 1440px, all six navigation links fit. Ubuntu, Windows and Omarchy selectors
  update the visible explanation and retain their specific launch URLs.
- At 390px and 320px, pricing, computers, open-source content and the disabled
  GitHub placeholder fit without horizontal overflow. The phone menu navigates
  to Computers, Pricing and Open source and closes after selection.
- Dark and light themes render correctly. The production browser reports no
  warnings or errors during these checks. No provisioning action was submitted.

The development browser hit a lazy-module error after HMR and then a tab crash;
that development session is not acceptance evidence. The final build was checked
in a separate production copy with a cloned dependency directory. The error did
not recur in the final production browser. The development process is stopped;
the phone preview remains running. Hosted preview acceptance is separate from
these local production-build checks and is recorded in the PR.

No computer was provisioned, no account/billing operation was exercised and no
production release was requested. The original dirty owner checkout is intact.
