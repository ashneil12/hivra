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
| `dashboard/public/brand/hivra-icon-{192,512}.png` | 192, 512 px | Web app manifest icons (any and maskable) and the Open Graph card mark |
| `dashboard/src/app/favicon.ico` | 16, 32, 48 px | Browser favicon |
| `dashboard/src/app/icon.png` | 192 px | `<link rel="icon">` |
| `dashboard/src/app/apple-icon.png` | 180 px | Apple touch icon |

The red H sits within 35% of the width from the centre, inside the 40% maskable
safe zone, so the full-bleed square works as a maskable icon without padding.
