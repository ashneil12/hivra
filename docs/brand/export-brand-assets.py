#!/usr/bin/env python3
"""Export the $HIVRA token image and Hivra app icons from the approved logo.

Every output is a plain resize of docs/brand/hivra-logo.jpg (4096x4096, square,
opaque). Nothing is cropped, padded, recoloured, redrawn or made transparent:
the dark field is part of the approved mark, so the same full-bleed square is
used for the token image, the listing-site logos, the favicon, the Apple touch
icon and the PWA icons.

Requires Pillow. Run from the repository root:

    python3 docs/brand/export-brand-assets.py

The script refuses to run if the source logo is not the approved file, so the
outputs are always derived from the exact bytes recorded in docs/brand/README.md.

It never overwrites a published export: the hivra-token-* and hivra-icon-*
files in dashboard/public/brand, whose URLs a token launch, a listing site or the
web app manifest may already point at. A missing output is written. A published
output that already exists is compared with a fresh export: identical bytes are
left alone, and different bytes stop the script before it writes anything. A
changed mark therefore gets new published file names.

The Next.js icon files (favicon.ico, icon.png, apple-icon.png in
dashboard/src/app) have names fixed by the framework, so they cannot move to a
new name. They are rewritten whenever the approved mark changes.
"""

from __future__ import annotations

import hashlib
import io
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
# Paths below are relative to the repository root, so tests can pass another root.
SOURCE = Path("docs/brand/hivra-logo.jpg")
SOURCE_SHA256 = "9ddfe937f7ab5e0025c903db1316bb2d960c15190ac49fdc6ab156d9e759a6f4"

PUBLIC_BRAND = Path("dashboard/public/brand")
APP = Path("dashboard/src/app")

# (output path, edge length in pixels)
PNG_OUTPUTS = [
    # Token image for the Bankr launch. These URLs are permanent: never
    # overwrite them with a different mark once the token has launched.
    (PUBLIC_BRAND / "hivra-token-1024.png", 1024),
    (PUBLIC_BRAND / "hivra-token-512.png", 512),
    (PUBLIC_BRAND / "hivra-token-256.png", 256),
    # Listing-site logos: 200px for CoinGecko, 64px and 32px for BaseScan.
    (PUBLIC_BRAND / "hivra-token-200.png", 200),
    (PUBLIC_BRAND / "hivra-token-64.png", 64),
    (PUBLIC_BRAND / "hivra-token-32.png", 32),
    # Installable-app (web manifest) icons, also used by the Open Graph card
    # and the site header mark.
    (PUBLIC_BRAND / "hivra-icon-192.png", 192),
    (PUBLIC_BRAND / "hivra-icon-512.png", 512),
    # Next.js metadata file conventions (<link rel="icon"> / apple-touch-icon).
    # Their names are fixed, so these are rewritten when the mark changes.
    (APP / "icon.png", 192),
    (APP / "apple-icon.png", 180),
]
FAVICON = APP / "favicon.ico"
FAVICON_SIZES = (16, 32, 48)

# Outputs with these name prefixes are published URLs and are never overwritten.
PUBLISHED_PREFIXES = ("hivra-token-", "hivra-icon-")


def is_published(path: Path) -> bool:
    return path.name.startswith(PUBLISHED_PREFIXES)


def load_source(root: Path) -> Image.Image:
    from PIL import Image

    source = root / SOURCE
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        sys.exit(f"{SOURCE} is not the approved logo (sha256 {digest}).")
    image = Image.open(source)
    image.load()
    if image.size[0] != image.size[1]:
        sys.exit(f"{SOURCE} is not square ({image.size[0]}x{image.size[1]}).")
    return image.convert("RGB")


def resized(source: Image.Image, edge: int) -> Image.Image:
    from PIL import Image

    return source.resize((edge, edge), Image.Resampling.LANCZOS)


def png_bytes(source: Image.Image, edge: int) -> bytes:
    buffer = io.BytesIO()
    resized(source, edge).save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def favicon_bytes(source: Image.Image) -> bytes:
    # Each favicon frame is resampled from the full-size source, not from a
    # smaller intermediate, so the 16px frame keeps as much of the mark as it can.
    # Next.js only decodes RGBA frames inside an .ico; the alpha channel is fully
    # opaque, so this adds no transparency.
    frames = [resized(source, edge).convert("RGBA") for edge in FAVICON_SIZES]
    buffer = io.BytesIO()
    frames[-1].save(
        buffer,
        format="ICO",
        sizes=[(edge, edge) for edge in FAVICON_SIZES],
        append_images=frames[:-1],
    )
    return buffer.getvalue()


def write_exports(root: Path, exports: list[tuple[Path, bytes]]) -> None:
    """Write fresh export bytes under root without changing a published file."""
    # Check every published file before writing anything, so a mismatch leaves
    # the tree exactly as it was.
    changed = [
        path
        for path, data in exports
        if is_published(path) and (root / path).exists() and (root / path).read_bytes() != data
    ]
    if changed:
        names = ", ".join(str(path) for path in changed)
        sys.exit(
            f"Refusing to overwrite published exports whose bytes would change: {names}. "
            "Export a changed mark under a new file name."
        )
    for path, data in exports:
        target = root / path
        if not target.exists():
            status = "wrote"
        elif target.read_bytes() == data:
            status = "kept"
        else:
            # Only a Next.js icon file gets here: published files were checked above.
            status = "rewrote"
        if status != "kept":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        print(f"{digest}  {len(data):>7}  {status:<7}  {path}")


def main(root: Path = ROOT) -> None:
    source = load_source(root)
    exports = [(path, png_bytes(source, edge)) for path, edge in PNG_OUTPUTS]
    exports.append((FAVICON, favicon_bytes(source)))
    write_exports(root, exports)


if __name__ == "__main__":
    main()
