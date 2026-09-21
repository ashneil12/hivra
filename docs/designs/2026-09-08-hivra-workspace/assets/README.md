Bundled public presentation assets; the prototype has no runtime network dependencies.

- Outfit, Space Grotesk and Space Mono: the repository's existing Next.js public font builds, copied from `dashboard/.next/static/media/`. Space Mono includes regular and bold. Their SIL Open Font Licenses are included; the new font licenses come from the official `google/fonts` repository (`ofl/spacemono` and `ofl/spacegrotesk`). Home's editorial headings use the same browser serif stack observed in the live app. The initial preview's unused Playfair assets were removed after this correction.
- `icons.js`: static SVG markup rendered from the repository's installed `lucide-react` package using React's `renderToStaticMarkup`. The Lucide license is included. No icon library is loaded at runtime.
- The sidebar retains the text-based Hivra wordmark. No screenshots, private images, credentials, or customer data are bundled.
