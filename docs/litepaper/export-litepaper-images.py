#!/usr/bin/env python3
"""Export light WebP copies of the three generated litepaper renders.

Each output is a plain Lanczos resize of one approved PNG in
docs/litepaper/assets, saved as WebP. Nothing is cropped, recoloured, redrawn
or regenerated, so a copy is a derived export, not a new generation. The
derivation is recorded in docs/release/asset-derived-exports.json, which names
each source and its SHA-256, and the evidence builder checks that the source is
recorded, includable and unchanged.

Requires Pillow (the records were made with 11.3.0). Run from the repository root:

    python3 docs/litepaper/export-litepaper-images.py

The script refuses to run if a source is not the approved file. It never
overwrites a published export: a missing output is written, an existing output
that matches a fresh export is left alone, and one that differs stops the run
before anything is written. A changed source therefore gets new file names.
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
ASSETS = Path("docs/litepaper/assets")

# (source PNG, approved SHA-256). All are 1536x1024.
SOURCES = {
    ASSETS / "agent-computer-hero-v2.png": "ff789243915db5325495d364a27cb4e7b4cb30b431879a17eb370eae888dd173",
    ASSETS / "agent-computer-opportunity-v2.png": "df38e76c121b85560343da49fb0e19069be2426280e35c76198ba4bc97bece25",
    ASSETS / "observable-run-v2.png": "e38ee51e5b2eeb3e71f9e5458719a76ec501418e8dd646f68343531d15b3d2fe",
}
# Output widths in pixels, at the source aspect ratio, and the WebP settings.
WIDTHS = (768, 1536)
QUALITY = 78
METHOD = 6


def output_path(source: Path, width: int) -> Path:
    return source.with_name(f"{source.stem}-{width}.webp")


def output_paths() -> list[Path]:
    """Every file main() writes."""
    return [output_path(source, width) for source in SOURCES for width in WIDTHS]


def load_source(root: Path, source: Path) -> Image.Image:
    from PIL import Image

    data = (root / source).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SOURCES[source]:
        sys.exit(f"{source} is not the approved render (sha256 {digest}).")
    image = Image.open(io.BytesIO(data))
    image.load()
    return image.convert("RGB")


def webp_bytes(image: Image.Image, width: int) -> bytes:
    from PIL import Image

    height = round(image.height * width / image.width)
    buffer = io.BytesIO()
    resized = image if width == image.width else image.resize((width, height), Image.Resampling.LANCZOS)
    resized.save(buffer, format="WEBP", quality=QUALITY, method=METHOD)
    return buffer.getvalue()


def write_exports(root: Path, exports: list[tuple[Path, bytes]]) -> None:
    """Write fresh export bytes under root without changing a published file."""
    # Check every file before writing anything, so a mismatch leaves the tree as it was.
    changed = [path for path, data in exports if (root / path).exists() and (root / path).read_bytes() != data]
    if changed:
        names = ", ".join(str(path) for path in changed)
        sys.exit(
            f"Refusing to overwrite published exports whose bytes would change: {names}. "
            "Export a changed source under new file names."
        )
    for path, data in exports:
        target = root / path
        status = "kept" if target.exists() else "wrote"
        if status == "wrote":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        print(f"{hashlib.sha256(data).hexdigest()}  {len(data):>7}  {status:<5}  {path}")


def main(root: Path = ROOT) -> None:
    exports = []
    for source in SOURCES:
        image = load_source(root, source)
        exports += [(output_path(source, width), webp_bytes(image, width)) for width in WIDTHS]
    write_exports(root, exports)


if __name__ == "__main__":
    main()
