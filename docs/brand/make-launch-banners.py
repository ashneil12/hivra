#!/usr/bin/env python3
"""Draw the draft launch banners from owner-asserted Hivra artwork.

Outputs (drafts for owner review, not deployed by the site):

    docs/brand/drafts/hivra-header-1500x500-draft.png
        Profile header for X and the DexScreener token page. Brand only: the
        mark, the word "Hivra" and the line "A computer for you and your agents".
        No token name, price, claim or contract address.

    docs/brand/drafts/hivra-launch-announcement-1600x900-template.png
        Launch announcement TEMPLATE. It carries factual copy from the launch
        kit and an empty, clearly marked band where the contract address goes
        once hivra.cloud/token lists it. Needs UK financial-promotion / legal
        review before anyone posts it.

Inputs, each checked against its recorded SHA-256 so the drafts only ever use
approved, owner-asserted artwork (docs/release/asset-owner-assertions.json):

    docs/litepaper/assets/boundary-monolith-v5.png   background art
    docs/brand/hivra-logo.jpg                        the approved mark
    docs/litepaper/assets/fonts/Manrope-Variable.ttf text (OFL-1.1)
    docs/litepaper/assets/fonts/IBMPlexMono-Regular.ttf labels (OFL-1.1)

The art and the mark are only resized (Lanczos) and positioned; neither is
cropped into a new shape, recoloured, redrawn or traced. The script adds flat
colour, a fade from the art into that flat colour, and text.

Requires Pillow. Run from the repository root:

    python3 docs/brand/make-launch-banners.py
"""

from __future__ import annotations

import hashlib
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "docs/litepaper/assets/boundary-monolith-v5.png"
LOGO = ROOT / "docs/brand/hivra-logo.jpg"
SANS = ROOT / "docs/litepaper/assets/fonts/Manrope-Variable.ttf"
MONO = ROOT / "docs/litepaper/assets/fonts/IBMPlexMono-Regular.ttf"
PINNED = {
    ART: "cebb1ae84c23f7eaae8fdc9825c0fc028e90eb66c968e77d11fd9e844ebb5ee2",
    LOGO: "9ddfe937f7ab5e0025c903db1316bb2d960c15190ac49fdc6ab156d9e759a6f4",
    SANS: "d0639be45d0af36e798172419d7bd173c4bd4f29e2b76cbb69db1d11bf8b0a40",
    MONO: "6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46",
}
DRAFTS = ROOT / "docs/brand/drafts"
HEADER = DRAFTS / "hivra-header-1500x500-draft.png"
ANNOUNCEMENT = DRAFTS / "hivra-launch-announcement-1600x900-template.png"
MAX_BYTES = 1_500_000

# The site's dark theme (app/globals.css and lib/og-card.tsx).
FIELD = (10, 10, 11)
INK = (253, 252, 249)
MUTED = (163, 163, 163)
ACCENT = (255, 58, 59)

TAGLINE = "A computer for you and your agents"


def checked(path: Path) -> Path:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != PINNED[path]:
        sys.exit(f"{path.relative_to(ROOT)} is not the approved file (sha256 {digest}).")
    return path


def sans(size: int, weight: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(SANS), size)
    font.set_variation_by_axes([weight])
    return font


def mono(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(MONO), size)


def mark(edge: int) -> Image.Image:
    return Image.open(LOGO).convert("RGB").resize((edge, edge), Image.Resampling.LANCZOS)


def art_at_height(height: int) -> Image.Image:
    art = Image.open(ART).convert("RGB")
    width = round(art.width * height / art.height)
    return art.resize((width, height), Image.Resampling.LANCZOS)


def fade_left(image: Image.Image, fade: int) -> Image.Image:
    """Alpha mask that fades the left edge of the art into the flat field."""
    mask = Image.new("L", image.size, 255)
    draw = ImageDraw.Draw(mask)
    for x in range(fade):
        # Smoothstep keeps the join free of a visible edge.
        t = x / fade
        draw.line([(x, 0), (x, image.height)], fill=round(255 * t * t * (3 - 2 * t)))
    return mask


def shade(size: tuple[int, int], start: float, end: float, opacity: int) -> Image.Image:
    """Horizontal black shade: full `opacity` left of `start`, clear right of `end`."""
    width, height = size
    alpha = Image.new("L", size, 0)
    draw = ImageDraw.Draw(alpha)
    for x in range(width):
        position = x / width
        if position <= start:
            value = opacity
        elif position >= end:
            value = 0
        else:
            t = (position - start) / (end - start)
            value = round(opacity * (1 - t * t * (3 - 2 * t)))
        draw.line([(x, 0), (x, height)], fill=value)
    layer = Image.new("RGBA", size, (*FIELD, 0))
    layer.putalpha(alpha)
    return layer


def brand_lockup(canvas: Image.Image, origin: tuple[int, int], edge: int, word_size: int) -> int:
    """Mark plus the word "Hivra"; returns the x where the word ends."""
    x, y = origin
    canvas.paste(mark(edge), (x, y))
    draw = ImageDraw.Draw(canvas)
    font = sans(word_size, 800)
    word_x = x + edge + round(edge * 0.28)
    # Centre the cap height on the mark.
    top, bottom = font.getbbox("H")[1], font.getbbox("H")[3]
    word_y = y + (edge - (bottom - top)) // 2 - top
    draw.text((word_x, word_y), "Hivra", font=font, fill=INK)
    return word_x + round(draw.textlength("Hivra", font=font))


def header() -> Image.Image:
    width, height = 1500, 500
    canvas = Image.new("RGB", (width, height), FIELD)
    art = art_at_height(height)
    art_x = width - art.width
    canvas.paste(art, (art_x, 0), fade_left(art, 260))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shade((width, height), 0.34, 0.62, 200)).convert("RGB")

    # X lays the profile photo over the lower left of the header, and narrow
    # screens trim the top and bottom, so the lockup sits high and centred
    # vertically in the band that stays visible.
    edge = 124
    left, top = 132, 150
    brand_lockup(canvas, (left, top), edge, 112)
    draw = ImageDraw.Draw(canvas)
    draw.text((left, top + edge + 34), TAGLINE, font=sans(40, 500), fill=MUTED)
    draw.rectangle([left, top - 34, left + 56, top - 30], fill=ACCENT)
    return canvas


def announcement() -> Image.Image:
    width, height = 1600, 900
    art = Image.open(ART).convert("RGB")
    # Cover the frame: the art is 1672x940, so this is a uniform resize with at
    # most a pixel of overflow trimmed from the right and bottom.
    scale = max(width / art.width, height / art.height)
    art = art.resize((round(art.width * scale), round(art.height * scale)), Image.Resampling.LANCZOS)
    canvas = art.crop((0, 0, width, height))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shade((width, height), 0.46, 0.78, 225)).convert("RGB")
    draw = ImageDraw.Draw(canvas)

    left = 96
    brand_lockup(canvas, (left, 88), 84, 72)

    draw.text((left, 244), "The $HIVRA contract on Base", font=sans(62, 800), fill=INK)

    # Empty band for the contract address, wide enough for all 42 characters
    # of a Base address in a monospaced face. It holds only a placeholder
    # label: the address is added only after hivra.cloud/token lists it.
    band = (left, 364, 1504, 484)
    draw.rectangle(band, fill=(22, 22, 24))
    dash, gap = 18, 12
    x0, y0, x1, y1 = band
    for x in range(x0, x1, dash + gap):
        draw.line([(x, y0), (min(x + dash, x1), y0)], fill=ACCENT, width=3)
        draw.line([(x, y1), (min(x + dash, x1), y1)], fill=ACCENT, width=3)
    for y in range(y0, y1, dash + gap):
        draw.line([(x0, y), (x0, min(y + dash, y1))], fill=ACCENT, width=3)
        draw.line([(x1, y), (x1, min(y + dash, y1))], fill=ACCENT, width=3)
    label = "[ CONTRACT ADDRESS GOES HERE AFTER LAUNCH ]"
    label_font = mono(28)
    label_width = draw.textlength(label, font=label_font)
    label_top, label_bottom = label_font.getbbox(label)[1], label_font.getbbox(label)[3]
    draw.text(
        ((x0 + x1 - label_width) / 2, (y0 + y1 - (label_bottom - label_top)) / 2 - label_top),
        label,
        font=label_font,
        fill=ACCENT,
    )

    body = sans(36, 500)
    draw.text((left, 540), "Check it at hivra.cloud/token, the only place", font=body, fill=INK)
    draw.text((left, 590), "Hivra publishes contract addresses.", font=body, fill=INK)
    draw.text((left, 660), "We never send addresses by DM.", font=body, fill=MUTED)
    draw.text((left, 792), "This is information, not an offer.", font=sans(28, 500), fill=MUTED)
    return canvas


def png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    data = buffer.getvalue()
    if len(data) <= MAX_BYTES:
        return data
    # Fall back to an adaptive palette. The art is near-monochrome with one red
    # accent, so 256 dithered colours hold up at posting sizes.
    buffer = io.BytesIO()
    image.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(
        buffer, format="PNG", optimize=True
    )
    return buffer.getvalue()


def main() -> None:
    for path in PINNED:
        checked(path)
    DRAFTS.mkdir(parents=True, exist_ok=True)
    for path, image in ((HEADER, header()), (ANNOUNCEMENT, announcement())):
        data = png(image)
        if len(data) > MAX_BYTES:
            sys.exit(f"{path.relative_to(ROOT)} would be {len(data)} bytes, over {MAX_BYTES}.")
        path.write_bytes(data)
        print(f"{hashlib.sha256(data).hexdigest()}  {len(data):>8}  {image.width}x{image.height}  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
