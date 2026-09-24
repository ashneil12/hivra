# $HIVRA token image

This is the image to give Bankr for the $HIVRA launch. Bankr's current launcher
cannot change a token's image after launch, so treat it as final.

## The file

| | |
|---|---|
| File | [`dashboard/public/brand/hivra-token-1024.png`](../../dashboard/public/brand/hivra-token-1024.png) |
| SHA-256 | `1a5518f79b5ebc1357f7d47b9457d03d89cefc8cba672663320f0c63d17f70ce` |
| Dimensions | 1024 × 1024 px, square |
| Format | PNG, 8-bit RGB, opaque, no embedded metadata |
| Size | 905,157 bytes |

Smaller copies of the same image, for anywhere that asks for them:

| File | Dimensions | Bytes | SHA-256 |
|---|---|---|---|
| `dashboard/public/brand/hivra-token-512.png` | 512 × 512 | 232,005 | `5d3ee5d906648daf6f1c22631066a0242e7b2a658f530ae2309931cd245a9c53` |
| `dashboard/public/brand/hivra-token-256.png` | 256 × 256 | 63,484 | `f500fd90cc8c85cb2d73f6591d3222eda152985aaf4a3dede490733bf376b80c` |
| `dashboard/public/brand/hivra-token-200.png` | 200 × 200 | 40,296 | `950f037aff0e527d2921526fff10e802ab08b97ea6c3cf9f4d18059f57690497` |
| `dashboard/public/brand/hivra-token-64.png` | 64 × 64 | 6,396 | `14a000404d817ba8d2854bd3bac304061410d132a8b319ae62a7834dc975e871` |
| `dashboard/public/brand/hivra-token-32.png` | 32 × 32 | 2,217 | `74f175228ab6a59ccaf5378aee1db84da57cff9bd2eb0e64e8f6e67650d8198d` |

The 200 px copy is the size CoinGecko asks for, and the 64 px and 32 px copies
are the sizes BaseScan asks for. Each one is resized straight from the 4096 px
source, not from a smaller copy.

## The URL to give Bankr

After the owner promotes a production build that contains this file:

```text
https://hivra.cloud/brand/hivra-token-1024.png
```

Until that Promote, the same bytes are served only by Canary:

```text
https://canary.hermesos.cloud/brand/hivra-token-1024.png
```

Prefer the `hivra.cloud` URL. Bankr pins the image to IPFS at launch, so the
token's image does not depend on either URL afterwards, and the Canary URL is
fine if the launch cannot wait for the Promote. Keep the file served anyway:
listing sites and anyone checking the image against Hivra's own copy use these
URLs. Before submitting either URL, confirm it serves these exact bytes:

```bash
curl -fsS https://hivra.cloud/brand/hivra-token-1024.png | shasum -a 256
```

The output must start with `1a5518f79b5e`.

## How it was made

The image is the approved logo, [`hivra-logo.jpg`](hivra-logo.jpg) (4096 × 4096
JPEG, SHA-256 `9ddfe937f7ab5e0025c903db1316bb2d960c15190ac49fdc6ab156d9e759a6f4`),
resized with Lanczos resampling by
[`export-brand-assets.py`](export-brand-assets.py) (Pillow 11.3.0). That is the
only change:

- no crop and no padding, because the logo is already square;
- no colour, contrast or sharpening change;
- no redraw or vector trace;
- no transparency, because the dark field is part of the approved mark.

The script refuses to run unless the source logo has the SHA-256 above.

## Keep these URLs stable

Never overwrite, rename or delete any `hivra-token-*.png` file. If the mark
ever changes, export it under a new file name. The export script enforces this:
it writes a missing file, leaves an identical one alone, and stops without
writing anything if an existing file's bytes would change. The app icons (`hivra-icon-*.png`, `favicon.ico`, `icon.png`,
`apple-icon.png`) are separate files so they can change without touching the
token image.
