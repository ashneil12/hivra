# Public website refinement

Scope: public presentation only. The owner explicitly deferred authenticated
dashboard, login and billing changes. Those flows and the approved source papers
are unchanged.

## Changes

- Agents precede computers. DeepSeek uses the same Choose agent label while
  retaining its existing catalogue destination. More agents are visibly coming.
- Three distinct OS illustrations, switch animations, scroll-driven panel and
  heading movement, and hero parallax. Content remains readable without these
  animations; reduced-motion rules disable them. macOS and custom images have
  separate coming-soon placements.
- Open source moves higher. Header includes the official GitHub mark. No public
  repository or release installer was verified, so source and desktop download
  controls are honestly pending. No star count is invented. Central destinations
  config supports verified public URLs and timestamped star counts when ready.
- Pricing now distinguishes free platform/BYO infrastructure from paid hosted
  compute across eight locales. No trial, starter-agent, concurrent-agent cap or
  legacy subscription price is advertised by this section. Both CTAs use the
  existing infrastructure hub. Homepage structured data and FAQ agree.
- Tokenomics has its own nav destination and substantial section. Current
  access and proposed migration/treasury/uses remain visibly distinguished.
- Founder content has a prominent hero invitation, menu/footer access and a
  substantial editorial section. Four approved paragraphs remain exact quotes.
  A separate personal note expresses the owner's newly requested Christian,
  end-time-prophecy and evangelistic perspective without invented specifics.

## Verification

- Eleven focused Jest suites: 70 tests pass, including real pricing SSR for
  eight locales, distinct OS images and routes, accessible menu interactions,
  pending/published source/download states and exact founder quotations.
- TypeScript and scoped ESLint pass. Canonical paper sources remain unchanged.
- Final production build and rendered browser acceptance recorded below.

## Assets

Built-in image generation created the three OS illustrations, then Sharp encoded
WebP without compositional editing. Original generated PNGs remain in the Codex
image output directory. Website assets are labelled illustrations, not screenshots.

- `dashboard/public/images/computers/ubuntu-workspace.webp` (82,596 bytes)
- `dashboard/public/images/computers/windows-workspace.webp` (87,316 bytes)
- `dashboard/public/images/computers/omarchy-workspace.webp` (60,950 bytes)

Prompt set: cinematic physically convincing 3D thin graphite desktop display,
subtle three-quarter angle above a low plinth in a dark studio; 3:2 screen-dominant
composition, soft shadows, tactile metal, precise edges, faint coral edge light,
subtle reflection; no text, watermark or real-hardware advertisement. Ubuntu uses
burnt-orange and aubergine orbital forms with a subtle left dock. Windows uses an
ice-blue folded-silk bloom and understated centered abstract taskbar. Omarchy uses
charcoal tiled panes, abstract sage/ivory/amber lines and a mountain/sun wallpaper.

## Release boundaries

The source and installers are not published by this work. The website does not
change runtime admission, provision computers or alter any account. Existing
billing implementation is outside this front-end pass, as the owner requested.
Local preview uses disposable local authentication, no production credentials,
and an allowlisted GET/HEAD public-page relay.

## Final acceptance

The production build passes. Browser checks on the phone relay passed at 1440,
390 and 320 pixels: agents precede computers, Windows/Omarchy selection loads
different artwork, both pricing offers remain visible, mobile navigation closes
after selection, founder and tokenomics destinations work, download controls are
clearly pending and no horizontal overflow occurs. Scroll animation has a real
view timeline in the rendered browser. No browser errors occurred. All three
WebP requests return 200 and served runtime files match the worktree.

The running preview is http://192.168.1.157:4191/. Production site unchanged.
