# Hivra brand source

The repository owner selected `hivra-logo.jpg` as the intended Hivra logo on
2026-09-21. This is the original supplied image, copied without alteration. Its
SHA-256 is `9ddfe937f7ab5e0025c903db1316bb2d960c15190ac49fdc6ab156d9e759a6f4`.

The owner stated that the illustrations were not taken from others. This records
that statement and the selected file; it does not invent a generation tool,
prompt, upstream source or independently verified generation receipt. The
committed logo was independently checked against the selected Downloads original
and is byte-identical. The exact assertion and its evidence boundary are bound in
`../release/asset-owner-assertions.json` and the asset provenance policy.

Use the [trademark policy](../../TRADEMARKS.md) when presenting the Hivra brand.
The repository README uses this image.

## Exports

[`export-brand-assets.py`](export-brand-assets.py) resizes this logo into every
deployed brand image. It only resizes: no crop, padding, colour change, redraw or
transparency.

| Output | Size | Used for |
|---|---|---|
| `dashboard/public/brand/hivra-token-{1024,512,256}.png` | 1024, 512, 256 px | $HIVRA token image (see [TOKEN-IMAGE.md](TOKEN-IMAGE.md)) and the homepage structured-data logo |
| `dashboard/public/brand/hivra-token-{200,64,32}.png` | 200, 64, 32 px | Listing-site logos: 200 px for CoinGecko, 64 px and 32 px for BaseScan |
| `dashboard/public/brand/hivra-icon-{192,512}.png` | 192, 512 px | Web app manifest icons (any and maskable), the Open Graph card mark and the site header mark |
| `dashboard/src/app/favicon.ico` | 16, 32, 48 px | Browser favicon |
| `dashboard/src/app/icon.png` | 192 px | `<link rel="icon">` |
| `dashboard/src/app/apple-icon.png` | 180 px | Apple touch icon |

The red H sits within 35% of the width from the centre, inside the 40% maskable
safe zone, so the full-bleed square works as a maskable icon without padding.

The script never overwrites a published export (`hivra-token-*`, `hivra-icon-*`).
It writes missing files, leaves identical ones alone and stops, writing nothing,
if an existing published file would change: a changed mark gets new file names.
The Next.js icon files (`favicon.ico`, `icon.png`, `apple-icon.png`) have names
fixed by the framework, so the script rewrites them when the mark changes.
[`test_export_brand_assets.py`](test_export_brand_assets.py) checks both rules.

## Launch banner drafts

[`make-launch-banners.py`](make-launch-banners.py) draws two drafts into
[`drafts/`](drafts/). They are for owner review and are not served by the site.

| Draft | Size | Content |
|---|---|---|
| `drafts/hivra-header-1500x500-draft.png` | 1500 × 500 | Header for X and DexScreener: the mark, "Hivra" and "A computer for you and your agents". No token claims, price or contract address. |
| `drafts/hivra-launch-announcement-1600x900-template.png` | 1600 × 900 | Launch announcement template with an empty, marked band for the contract address. Its token copy needs UK financial-promotion / legal review before it is posted, and the address goes in only after hivra.cloud/token lists it. |

Both use only owner-asserted art: `docs/litepaper/assets/boundary-monolith-v5.png`
and this logo, resized and positioned without redrawing, plus text set in the
litepaper's OFL-licensed Manrope and IBM Plex Mono. The script checks each input's
SHA-256 before drawing.
