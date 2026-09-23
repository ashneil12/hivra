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

## The URL to give Bankr

After the owner promotes a production build that contains this file:

```text
https://hivra.cloud/brand/hivra-token-1024.png
```

Until that Promote, the same bytes are served only by Canary:

```text
https://canary.hermesos.cloud/brand/hivra-token-1024.png
```

Prefer the `hivra.cloud` URL. Whatever URL goes into the launch has to keep
serving this file for as long as the token exists, so use the Canary URL only if
the launch cannot wait for the Promote. Before submitting either URL, confirm it
serves these exact bytes:

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

Never overwrite, rename or delete `hivra-token-1024.png`, `hivra-token-512.png`
or `hivra-token-256.png`. If the mark ever changes, export it under a new file
name. The app icons (`hivra-icon-*.png`, `favicon.ico`, `icon.png`,
`apple-icon.png`) are separate files so they can change without touching the
token image.
