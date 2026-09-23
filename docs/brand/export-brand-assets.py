#!/usr/bin/env python3
"""Export the $HIVRA token image and Hivra app icons from the approved logo.

Every output is a plain resize of docs/brand/hivra-logo.jpg (4096x4096, square,
opaque). Nothing is cropped, padded, recoloured, redrawn or made transparent:
the dark field is part of the approved mark, so the same full-bleed square is
used for the token image, the favicon, the Apple touch icon and the PWA icons.

Requires Pillow. Run from the repository root:

    python3 docs/brand/export-brand-assets.py

The script refuses to run if the source logo is not the approved file, so the
outputs are always derived from the exact bytes recorded in docs/brand/README.md.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/brand/hivra-logo.jpg"
SOURCE_SHA256 = "9ddfe937f7ab5e0025c903db1316bb2d960c15190ac49fdc6ab156d9e759a6f4"

PUBLIC_BRAND = ROOT / "dashboard/public/brand"
APP = ROOT / "dashboard/src/app"

# (output path, edge length in pixels)
PNG_OUTPUTS = [
    # Token image for the Bankr launch. These URLs are permanent: never
    # overwrite them with a different mark once the token has launched.
    (PUBLIC_BRAND / "hivra-token-1024.png", 1024),
    (PUBLIC_BRAND / "hivra-token-512.png", 512),
    (PUBLIC_BRAND / "hivra-token-256.png", 256),
    # Installable-app (web manifest) icons, also used by the Open Graph card.
    (PUBLIC_BRAND / "hivra-icon-192.png", 192),
    (PUBLIC_BRAND / "hivra-icon-512.png", 512),
    # Next.js metadata file conventions (<link rel="icon"> / apple-touch-icon).
    (APP / "icon.png", 192),
    (APP / "apple-icon.png", 180),
]
FAVICON = APP / "favicon.ico"
FAVICON_SIZES = (16, 32, 48)


def load_source() -> Image.Image:
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        sys.exit(f"{SOURCE} is not the approved logo (sha256 {digest}).")
    image = Image.open(SOURCE)
    image.load()
    if image.size[0] != image.size[1]:
        sys.exit(f"{SOURCE} is not square ({image.size[0]}x{image.size[1]}).")
    return image.convert("RGB")


def resized(source: Image.Image, edge: int) -> Image.Image:
    return source.resize((edge, edge), Image.Resampling.LANCZOS)


def main() -> None:
    source = load_source()
    PUBLIC_BRAND.mkdir(parents=True, exist_ok=True)
    for path, edge in PNG_OUTPUTS:
        resized(source, edge).save(path, format="PNG", optimize=True)
    # Each favicon frame is resampled from the full-size source, not from a
    # smaller intermediate, so the 16px frame keeps as much of the mark as it can.
    # Next.js only decodes RGBA frames inside an .ico; the alpha channel is fully
    # opaque, so this adds no transparency.
    frames = [resized(source, edge).convert("RGBA") for edge in FAVICON_SIZES]
    frames[-1].save(
        FAVICON,
        format="ICO",
        sizes=[(edge, edge) for edge in FAVICON_SIZES],
        append_images=frames[:-1],
    )
    for path in [p for p, _ in PNG_OUTPUTS] + [FAVICON]:
        data = path.read_bytes()
        print(f"{hashlib.sha256(data).hexdigest()}  {len(data):>7}  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
