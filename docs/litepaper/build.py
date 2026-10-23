#!/usr/bin/env python3
"""Build the immersive litepaper using Python 3.9+ and the standard library.

Run from any directory: python3 docs/litepaper/build.py [--check]
LITEPAPER.md supplies all narrative, product stories and token utilities.
The template shapes that copy into the existing immersive scenes and controls. CSS and JavaScript
are separate assets and are never rewritten by this script.
"""

import argparse
import html
import hashlib
import json
import math
import re
import struct
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from link_policy import enhance_links
import restrict

REPO = Path(__file__).resolve().parents[2]
OUTPUT = REPO / "docs/litepaper/index.html"
# The page is served by the Next.js app at /docs/litepaper/index.html, so it may
# link these same-origin app files by site-root path. Each maps to the committed
# file the app serves at that path.
SITE_ROOT_FILES = {
    "/favicon.ico": "dashboard/src/app/favicon.ico",
    "/apple-icon.png": "dashboard/src/app/apple-icon.png",
    # The approved barcode mark, exported by docs/brand/export-brand-assets.py.
    "/brand/hivra-icon-192.png": "dashboard/public/brand/hivra-icon-192.png",
    # Web copies of assets/boundary-monolith-v5.png that the homepage also serves.
    "/images/home/monolith-900.webp": "dashboard/public/images/home/monolith-900.webp",
    "/images/home/monolith-1600.webp": "dashboard/public/images/home/monolith-1600.webp",
}
# App pages the page links to. They are routes rather than files, so they are
# checked by path; the query picks what Launch opens with.
SITE_ROUTES = {"/dashboard/launch"}
AGENT_LAUNCH = "/dashboard/launch?kind=agent&start=1"
COMPUTER_LAUNCH = "/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop"
# Tabler's MIT brand-github path; attribution is in vendor/NOTICE.md.
GITHUB_MARK = '<svg class="hero-open-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5"/></svg>'
BRAND_MARK = '<img class="brand-mark" src="/brand/hivra-icon-192.png" alt="" width="192" height="192" decoding="async">'
MONOLITH_WEBP = "/images/home/monolith-900.webp 900w, /images/home/monolith-1600.webp 1600w"


def delegation_figure():
    """The constitution's rule in three plain steps, using the refund and payouts
    example from Gate."""
    steps = [
        ("You", "Give your agent one job: refunding orders.", "granted", "Granted"),
        ("Your agent", "Asks a helper agent to refund one order.", "allowed", "Allowed"),
        ("The helper", "Tries to change where your payouts go.", "blocked", "Blocked. Nobody gave it that."),
    ]
    cards = "".join(
        f'<li class="rule-step" data-state="{state}"><span class="rule-who">{who}</span><p>{what}</p><span class="rule-verdict">{verdict}</span></li>'
        for who, what, state, verdict in steps
    )
    return f'<figure class="delegation"><ol class="rule-steps">{cards}</ol><figcaption>An example of the rule above.</figcaption></figure>'


DELEGATION = delegation_figure()


def monolith(attributes, sizes):
    """The monolith render as WebP where supported, with the PNG as fallback."""
    return ('<picture><source type="image/webp" srcset="{}" sizes="{}">'
            '<img src="assets/boundary-monolith-v5.png" {}></picture>').format(MONOLITH_WEBP, sizes, attributes)
# The three generated renders have WebP exports beside them, made by
# export-litepaper-images.py and recorded as derived exports in
# docs/release/asset-derived-exports.json.
WEBP_WIDTHS = (768, 1536)


def render(png, attributes, sizes):
    """A generated render as WebP where supported, with the PNG as fallback."""
    stem = png.removesuffix(".png")
    srcset = ", ".join("assets/{}-{}.webp {}w".format(stem, width, width) for width in WEBP_WIDTHS)
    return ('<picture><source type="image/webp" srcset="{}" sizes="{}">'
            '<img src="assets/{}" {}></picture>').format(srcset, sizes, png, attributes)


# Share tags need absolute URLs; they name the canonical site.
SITE_URL = "https://hivra.cloud"
PAGE_URL = SITE_URL + "/docs/litepaper/index.html"
PAGE_TITLE = "Hivra · Somewhere better to work"
PAGE_DESCRIPTION = ("Your agent needs a computer. It does not need yours. See how Hivra gives AI agents "
                    "computers of their own, with limits the agent can't talk its way past.")
SHARE_IMAGE = "assets/boundary-monolith-v5.png"
SHARE_IMAGE_ALT = "Architectural illustration of a bounded computer."
PRODUCT_GROUPS = {
    "Gate": "Next", "Exchange": "Next", "Arena": "Next", "Signal": "Next",
    "Vault": "Then", "Passport": "Then", "Seal": "Then", "Rescue": "Then",
    "Challenges": "Then", "Experience": "Then",
    "Missions": "Horizon", "Foundry": "Horizon", "Colony": "Horizon",
    "Interchange": "Horizon", "Ports": "Horizon",
}
# (title, anchor id, short label). The litepaper's sections, in reading order. A section added,
# removed or renamed in LITEPAPER.md fails the build until it is listed here.
HERO_TITLE = "Your agent needs a computer. It does not need yours."
FOUNDER_TITLE = "I am building the product I need"
ECONOMY_TITLE = "An economy for work the system can prove"
FINALE_TITLE = "Somewhere better to work"
THIN_LAYER_TITLE = "The thin layer between an agent and your life"
SECTIONS = (
    (HERO_TITLE, "opportunity", "The beginning"),
    (FOUNDER_TITLE, "founder", "Why I\u2019m building it"),
    ("The thin layer between an agent and your life", "thin-layer", "The thin layer"),
    ("The safer answer has always been obvious", "safer-answer", "The safer answer"),
    ("Open Hivra. Choose what you want.", "experience", "Agent or computer"),
    ("A computer that belongs to the work", "persistence", "It stays"),
    ("The remote computer has to disappear", "close", "It feels close"),
    ("Your cloud is welcome too", "your-cloud", "Your cloud"),
    ("Every run should leave evidence", "observability", "Evidence"),
    ("One computer opens the door to a platform", "platform", "A platform"),
    ("The Hivra system", "future", "The system"),
    (ECONOMY_TITLE, "economy", "The economy"),
    ("Move at AI speed. Publish at evidence speed.", "pace", "The pace"),
    ("A constitution written before the power arrives", "security", "The constitution"),
    (FINALE_TITLE, "somewhere-better", "Somewhere better"),
)
AUTHOR_NOTE = re.compile(
    r"\[\s*(?:NOTE TO ASH|TO CONFIRM|HERO VISUAL|VISUAL(?: BLOCK)?)\b"
    r"|not for the page|internal publication checklist",
    re.IGNORECASE,
)
escape = html.escape


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_names(actual, expected, label):
    missing, unexpected = set(expected) - set(actual), set(actual) - set(expected)
    require(not missing and not unexpected,
            "{}: missing {}; unexpected {}".format(label, sorted(missing), sorted(unexpected)))


def inline(value):
    value = escape(value, quote=False)

    def link(match):
        target = {"WHITEPAPER.md": "../../WHITEPAPER.md", "LITEPAPER.md": "../../LITEPAPER.md", "TOKENOMICS.md": "../../TOKENOMICS.md?v=" + hashlib.sha256((REPO / "LITEPAPER.md").read_bytes()).hexdigest()[:12], "THOUGHTS.md": "../../THOUGHTS.md", "#the-problem": "#opportunity", "#the-problem-is-where-it-lives": "#opportunity", "#hivra": "#top"}.get(match[2], match[2])
        return '<a href="{}">{}</a>'.format(escape(target, quote=True), match[1])

    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, value)
    value = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", value)
    return re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", value)


def table(block):
    """A Markdown table as HTML. Yes/No cells get a class so they can carry a mark;
    the words stay in the cell so they read the same without CSS."""
    rows = [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in block.splitlines()]
    require(len(rows) >= 3 and all(re.fullmatch(r":?-{3,}:?", cell) for cell in rows[1]), "Malformed table")
    header, body = rows[0], rows[2:]
    require(all(len(row) == len(header) for row in body), "Table rows differ in length")
    def cell_class(value, column):
        kind = {"Yes": "is-yes", "No": "is-no"}.get(value, "is-partial")
        return kind + (" is-hivra" if column == len(header) - 1 else "")
    head = "".join('<th scope="col"{}>{}</th>'.format(' class="is-hivra"' if i == len(header) - 1 else "", inline(cell)) for i, cell in enumerate(header))
    rows_html = "".join(
        "<tr><th scope=\"row\">{}</th>{}</tr>".format(
            inline(row[0]),
            "".join('<td class="{}">{}</td>'.format(cell_class(cell, i + 1), inline(cell)) for i, cell in enumerate(row[1:])),
        )
        for row in body
    )
    return '<div class="fit-table" role="region" aria-label="Where each option stands" tabindex="0"><table><thead><tr>{}</tr></thead><tbody>{}</tbody></table></div>'.format(head, rows_html)


GLOSSARY = json.loads((REPO / "dashboard/src/lib/glossary.json").read_text(encoding="utf-8"))
# Token-facing tooltips are part of the token copy and wait for its review.
GLOSS_TOKEN_TERMS = True
GLOSS_SKIP = {"a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code"}


def glossify(markup, seen):
    """Wrap the first use of each glossary term in a hover and focus tooltip.

    The definition lives in data-tip, so it is never reader text: the approved
    wording is unchanged, and the Markdown file stays plain. Links and headings
    are skipped. `seen` holds the terms already explained in this stretch of copy."""
    entries = [(entry, re.compile(r"\b(?:" + entry["pattern"] + r")\b",
                                  0 if entry.get("caseSensitive") else re.IGNORECASE))
               for entry in GLOSSARY if GLOSS_TOKEN_TERMS or not entry.get("token")]
    parts, depth = re.split(r"(<[^>]+>)", markup), 0
    for index, part in enumerate(parts):
        if part.startswith("<"):
            tag = re.match(r"</?([a-zA-Z0-9]+)", part)
            if tag and tag[1].lower() in GLOSS_SKIP and not part.endswith("/>"):
                depth += -1 if part.startswith("</") else 1
            continue
        if depth > 0 or not part.strip():
            continue
        hits = []
        for entry, pattern in entries:
            if entry["key"] in seen:
                continue
            match = pattern.search(part)
            if match and not any(match.start() < end and start < match.end() for start, end, _, _ in hits):
                hits.append((match.start(), match.end(), entry, match[0]))
        if not hits:
            continue
        out, cursor = [], 0
        for start, end, entry, text in sorted(hits, key=lambda hit: hit[0]):
            seen.add(entry["key"])
            out.append(part[cursor:start])
            out.append('<span class="gloss" tabindex="0" aria-description="{0}" data-tip="{0}">{1}</span>'.format(
                escape(entry["tip"], quote=True), text))
            cursor = end
        out.append(part[cursor:])
        parts[index] = "".join(out)
    return "".join(parts)


def blocks(value):
    rendered = []
    for block in re.split(r"\n\s*\n", value.strip()):
        if not block or block == "---" or block.startswith("*[Interactive:"):
            continue
        if block.startswith("|"):
            rendered.append(table(block))
        elif block.startswith("### "):
            rendered.append("<h3>" + inline(block[4:]) + "</h3>")
        elif re.match(r"^\d+\. ", block):
            items = re.findall(r"^\d+\. (.+)$", block, flags=re.MULTILINE)
            rendered.append("<ol>" + "".join("<li>" + inline(item) + "</li>" for item in items) + "</ol>")
        elif block.startswith("> "):
            rendered.append("<blockquote>" + inline(" ".join(line[2:] if line.startswith("> ") else line for line in block.splitlines())) + "</blockquote>")
        elif block.startswith("```"):
            rendered.append("<pre>" + escape(block.strip("`\n").removeprefix("text\n")) + "</pre>")
        else:
            rendered.append("<p>" + inline(block) + "</p>")
    return glossify("\n".join(rendered), set())


def split_sub(value):
    chunks = re.split(r"^### ", value, flags=re.MULTILINE)
    subsections = {}
    for chunk in chunks[1:]:
        title, body = chunk.split("\n", 1)
        require(title not in subsections, "Duplicate subsection: " + title)
        subsections[title] = body.strip()
    return chunks[0].strip(), subsections


def check_local_url(value, base):
    target = urlsplit(value)
    require(target.scheme in {"", "http", "https", "data"},
            "Unsupported link scheme: " + value)
    if target.scheme or target.netloc or not target.path:
        return
    if target.path == "/":
        return
    if target.path in SITE_ROOT_FILES:
        require((REPO / SITE_ROOT_FILES[target.path]).is_file(),
                "Site file is missing from the dashboard: " + value)
        return
    if target.path in SITE_ROUTES:
        return
    path = unquote(target.path)
    require(not path.startswith("/") and "\\" not in path,
            "Local links must be repository-relative: " + value)
    resolved = (base / path).resolve()
    require(resolved == REPO or REPO in resolved.parents,
            "Local link escapes the repository: " + value)


def load_inputs():
    markdown = re.sub(r"<!--.*?-->\n?", "", (REPO / "LITEPAPER.md").read_text(encoding="utf-8"), flags=re.DOTALL)
    require(not AUTHOR_NOTE.search(markdown), "Author-only note found in LITEPAPER.md")
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", markdown):
        check_local_url(target, REPO)
    sections = {}
    for chunk in re.split(r"^## ", markdown, flags=re.MULTILINE)[1:]:
        title, body = chunk.split("\n", 1)
        require(title not in sections, "Duplicate section: " + title)
        sections[title] = body.strip().removesuffix("---").strip()
    check_names(sections, [title for title, _, _ in SECTIONS], "LITEPAPER.md sections")
    return sections


class LocalLinkChecker(HTMLParser):
    # Check output URLs after HTML escaping has been decoded by the parser.
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if not value:
                continue
            if key in {"href", "src"}:
                check_local_url(value, OUTPUT.parent)
            elif key in {"srcset", "imagesrcset"}:
                for candidate in value.split(","):
                    check_local_url(candidate.split()[0], OUTPUT.parent)


def png_size(path):
    header = path.read_bytes()[:24]
    require(header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR", "Not a PNG: " + str(path))
    return struct.unpack(">II", header[16:24])


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def figure(alt, target):
    """A litepaper image: the generated PNG with its WebP renditions, from docs/litepaper/assets."""
    png = Path(target).name
    require(target == "docs/litepaper/assets/" + png, "Images must live in docs/litepaper/assets: " + target)
    width, height = png_size(OUTPUT.parent / "assets" / png)
    image = render(png, 'alt="{}" width="{}" height="{}" loading="lazy" decoding="async"'.format(escape(alt, quote=True), width, height),
                   "(max-width: 999px) 100vw, 960px")
    return '<figure class="lp-figure">{}</figure>'.format(image)


def prose(value):
    """Markdown blocks as HTML, with the litepaper's own images."""
    parts = []
    for block in re.split(r"\n\s*\n", value.strip()):
        found = re.fullmatch(r"!\[([^\]]*)\]\(([^)]+)\)", block.strip())
        parts.append(figure(found[1], found[2]) if found else blocks(block))
    return "".join(parts)


def build_page():
    sections = load_inputs()
    ids = {title: anchor for title, anchor, _ in SECTIONS}
    labels = {title: label for title, _, label in SECTIONS}
    hero_intro = sections[HERO_TITLE].split("\n\n")
    hero_sentence = next(p for p in hero_intro if p.startswith("Hivra is building"))
    hero_caption = "".join("<span>{}</span>".format(inline(part)) for part in re.split(r"(?<=\.)\s+", hero_sentence, maxsplit=1)[:1])
    explore_arrow = '<svg class="action-arrow" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10"/><path d="M17 8l0 9l-9 0"/></svg>'

    def subsections(body, wrap="problem-prose"):
        intro, subs = split_sub(body)
        html_out = '<div class="prose">{}</div>'.format(prose(intro)) if intro else ""
        for name, text in subs.items():
            html_out += '<div class="{} scene-reveal" id="{}-{}"><h3>{}</h3><div class="prose">{}</div></div>'.format(
                wrap, "sub", slug(name), escape(name), prose(text))
        return html_out

    chapters = ""
    for title, anchor, label in SECTIONS:
        if title in (FINALE_TITLE,):
            continue
        body = sections[title]
        if title == HERO_TITLE:
            content = '<div class="prose problem-intro">{}</div>'.format(prose(body))
        elif title == FOUNDER_TITLE:
            chapters += ('<section class="founder chapter shell" id="{}" data-chapter="{}"><div class="founder-heading"><span class="founder-rule" aria-hidden="true"></span>'
                         '<h2>{}</h2></div><div class="prose founder-copy">{}</div></section>').format(anchor, escape(label), escape(title), prose(body))
            continue
        else:
            content = subsections(body)
            if title == THIN_LAYER_TITLE:
                # The interactive boundary lab: the reader sees what a permission prompt does and does not protect.
                content += '<div class="problem-layout">{}</div>'.format((OUTPUT.parent / "boundary.html").read_text(encoding="utf-8"))
        klass = "economy chapter shell" if title == ECONOMY_TITLE else "lp-chapter chapter shell"
        chapters += ('<section class="{}" id="{}" data-chapter="{}"><div class="chapter-heading"><h2>{}</h2></div>{}</section>').format(
            klass, anchor, escape(label), escape(title), content)
        if title == "The safer answer has always been obvious":
            chapters += ('<section class="boundary-passage" aria-label="The central principle"><div class="passage-lines" aria-hidden="true">{}</div>'
                         '<p><span class="passage-room">Give it room to work.</span><br><span class="passage-decide">Decide what it can reach.</span></p></section>').format(
                             "".join("<i></i>" for _ in range(8)))

    finale_copy, finale_links = sections[FINALE_TITLE].rsplit("\n\n", 1)
    source_finale_links = inline(finale_links).replace("<a ", '<a class="text-link" ')
    index_entries = [(anchor, label) for title, anchor, label in SECTIONS if title != FINALE_TITLE]
    index_links = "".join('<a href="#{}"><span class="index-number">{:02d}</span><span>{}</span>{}</a>'.format(target, i + 1, label, explore_arrow)
                          for i, (target, label) in enumerate(index_entries))
    share_width, share_height = png_size(OUTPUT.parent / SHARE_IMAGE)
    HERO_SIZES = "(max-width: 999px) 100vw, 62vw"
    css_v = hashlib.sha256((OUTPUT.parent / "litepaper.css").read_bytes()).hexdigest()[:12]
    js_v = hashlib.sha256((OUTPUT.parent / "litepaper.js").read_bytes()).hexdigest()[:12]
    motion_v = hashlib.sha256((OUTPUT.parent / "experience-motion.js").read_bytes()).hexdigest()[:12]
    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="{escape(PAGE_DESCRIPTION)}">
<meta name="theme-color" content="#090909">
<title>{escape(PAGE_TITLE)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Hivra">
<meta property="og:title" content="{escape(PAGE_TITLE)}">
<meta property="og:description" content="{escape(PAGE_DESCRIPTION)}">
<meta property="og:url" content="{PAGE_URL}">
<meta property="og:image" content="{SITE_URL}/docs/litepaper/{SHARE_IMAGE}">
<meta property="og:image:width" content="{share_width}">
<meta property="og:image:height" content="{share_height}">
<meta property="og:image:alt" content="{escape(SHARE_IMAGE_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@HivraOS">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-icon.png">
<link rel="preload" as="image" type="image/webp" href="/images/home/monolith-1600.webp" imagesrcset="{MONOLITH_WEBP}" imagesizes="{HERO_SIZES}" fetchpriority="high">
<link rel="stylesheet" href="litepaper.css?v={css_v}">
<link rel="preload" as="font" type="font/ttf" crossorigin href="assets/fonts/Manrope-Variable.ttf">
<script defer src="vendor/gsap-3.15.0.min.js"></script>
<script defer src="vendor/ScrollTrigger-3.15.0.min.js"></script>
<script defer src="litepaper.js?v={js_v}"></script>
<script defer src="experience-motion.js?v={motion_v}"></script>
</head>
<body>
<div id="top" aria-hidden="true"></div>
<a class="skip-link" href="#main">Skip to the litepaper</a>
<header class="site-header"><a class="brand" href="/" aria-label="Back to the Hivra homepage">{BRAND_MARK}Hivra</a><nav aria-label="Primary navigation"><a href="#thin-layer">Why Hivra</a><a href="#experience">How it works</a><a href="#future">The system</a><a href="#pace">What's next</a></nav><div class="reader-tools"><button class="chapter-index-toggle" aria-controls="chapter-index" aria-expanded="false">Index<span aria-hidden="true" class="index-icon"></span></button><button class="reading-toggle" aria-pressed="false">Read</button><button class="motion-toggle" aria-pressed="false" aria-label="Pause animation">Motion on</button><button class="theme-toggle" aria-label="Switch to light theme">Light</button></div></header>
<dialog class="chapter-index-panel" id="chapter-index" aria-labelledby="index-title"><div class="index-top"><a class="brand" href="/" aria-label="Back to the Hivra homepage">{BRAND_MARK}Hivra</a><button class="chapter-index-close" aria-label="Close chapter index">Close <span aria-hidden="true">×</span></button></div><div class="index-layout"><div class="index-intro"><p class="mini-label">The Hivra litepaper</p><h2 id="index-title">Find your<br>place.</h2><p>Give it room to work.<br>Decide what it can reach.</p></div><nav class="index-links" aria-label="Chapter index">{index_links}</nav></div><div class="index-bottom"><a href="/">Back to Hivra {explore_arrow}</a><a href="../../LITEPAPER.md">Save the litepaper {explore_arrow}</a></div></dialog>
<main id="main">
<section class="hero" id="beginning" data-chapter="The beginning">
<div class="hero-art" aria-hidden="true"><div class="hero-object-stage"><div class="hero-object">{monolith('alt="" width="1672" height="940" fetchpriority="high"', HERO_SIZES)}<div class="hero-object-edge"></div></div><div class="hero-coordinate coordinate-top">HIVRA / AGENT COMPUTERS</div><div class="hero-coordinate coordinate-bottom">A place of its own.</div></div><div class="hero-shade"></div><canvas id="field-canvas"></canvas></div><div class="hero-watermark" aria-hidden="true">HIVRA</div>
<div class="hero-content"><p class="hero-kicker">The Hivra litepaper</p><h1><span class="line">Your agent</span><span class="line">needs a</span><span class="line hero-emphasis">computer.</span><span class="hero-answer">It does not need yours.</span></h1><a class="text-link enter-link" href="#opportunity">Enter <span class="enter-arrow" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10"/><path d="M17 8l0 9l-9 0"/></svg></span></a><div class="hero-links"><a class="hero-open" href="https://github.com/ashneil12/hivra">{GITHUB_MARK}Open source · Run it yourself</a><a class="hero-open hero-token" href="#economy">Economy<span aria-hidden="true">&rarr;</span></a></div></div>
<div class="hero-caption"><span class="hero-caption-mark" aria-hidden="true">H / 00</span>{hero_caption}<span class="hero-scroll" aria-hidden="true">SCROLL TO EXPLORE<span></span></span></div>
<div class="hero-transition" aria-hidden="true">Give it room<br>to work.</div>
</section>
{chapters}
<section class="finale chapter" id="somewhere-better" data-chapter="Somewhere better"><div class="finale-art" aria-hidden="true">{monolith('alt="" width="1672" height="940" loading="lazy" decoding="async"', '100vw')}</div><div class="shell"><h2>Somewhere<br><span>better to work</span></h2><div class="prose finale-copy">{blocks(finale_copy)}</div><div class="finale-actions"><a class="finale-launch" href="{AGENT_LAUNCH}">Launch an agent {explore_arrow}</a><a class="finale-computer" href="{COMPUTER_LAUNCH}">Start with a computer {explore_arrow}</a></div><div class="finale-links source-links">{source_finale_links}</div></div></section>
</main>
<footer class="shell site-footer"><a class="brand" href="/" aria-label="Back to the Hivra homepage">{BRAND_MARK}Hivra</a><p>Give it room to work.<br>Decide what it can reach.</p><div class="footer-links"><a href="/">Back to Hivra {explore_arrow}</a><a href="../../WHITEPAPER.md">White Paper {explore_arrow}</a><a href="../../LITEPAPER.md">Litepaper (Markdown) {explore_arrow}</a></div></footer>
<nav class="chapter-dock" aria-label="Chapters"><button class="chapter-index-toggle dock-index-toggle" aria-label="Open chapter index"><span class="index-icon" aria-hidden="true"></span><span class="dock-index-label">Index</span><span class="dock-current">The beginning</span></button><a href="#thin-layer" aria-label="The problem">The problem</a><a href="#experience" aria-label="Agent or computer">Agent or computer</a><a href="#future" aria-label="The system">The system</a><a href="#economy" aria-label="The economy">The economy</a><a href="#security" aria-label="The constitution">The constitution</a><a class="dock-launch" href="{AGENT_LAUNCH}">Launch an agent {explore_arrow}</a><div class="reading-progress" aria-hidden="true"></div></nav>
</body></html>'''
    marker_number = 0
    marker_labels = iter(label for title, _, label in SECTIONS if title not in (FOUNDER_TITLE, FINALE_TITLE))

    def masthead(match):
        nonlocal marker_number
        marker_number += 1
        return match[0].replace("chapter-heading", "chapter-heading chapter-masthead") + '<div class="chapter-marker"><span>{}</span><i aria-hidden="true"></i><span aria-hidden="true">H / {:02d}</span></div>'.format(next(marker_labels), marker_number)

    page = re.sub(r'<div class="(?:shell )?chapter-heading">', masthead, page)
    page = enhance_links(page)
    require(not AUTHOR_NOTE.search(page), "Author-only note found in generated HTML")
    LocalLinkChecker().feed(page)
    return page


def build_tokenomics():
    # Keep the standalone download on the same wording source as the website.
    markdown = (REPO / "LITEPAPER.md").read_text(encoding="utf-8")
    economy = markdown.split("\n## " + ECONOMY_TITLE + "\n", 1)[1].split("\n## ", 1)[0]
    return "# Hivra tokenomics\n\n" + economy.strip().replace("### ", "## ") + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the page or tokenomics download needs regeneration")
    args = parser.parse_args()
    try:
        page = build_page()
        outputs = {
            OUTPUT: page.encode("utf-8"),
            REPO / "TOKENOMICS.md": build_tokenomics().encode("utf-8"),
            # Token-free copies, served by country (dashboard/next.config.ts).
            OUTPUT.parent / "restricted.html": restrict.litepaper_html(page).encode("utf-8"),
            OUTPUT.parent / "restricted/LITEPAPER.md": restrict.litepaper_md((REPO / "LITEPAPER.md").read_text(encoding="utf-8")).encode("utf-8"),
            OUTPUT.parent / "restricted/WHITEPAPER.md": restrict.whitepaper_md((REPO / "WHITEPAPER.md").read_text(encoding="utf-8")).encode("utf-8"),
            OUTPUT.parent / "restricted/TOKENOMICS.md": restrict.tokenomics_md().encode("utf-8"),
        }
        if args.check:
            stale = [str(path.relative_to(REPO)) for path, content in outputs.items()
                     if not path.exists() or path.read_bytes() != content]
            if stale:
                print("Stale " + ", ".join(stale) + "; run python3 docs/litepaper/build.py", file=sys.stderr)
                return 1
            print("Current: page and tokenomics download")
        else:
            for path, content in outputs.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                print("Built {}: {} bytes".format(path.relative_to(REPO), len(content)))
    except (OSError, ValueError, KeyError, IndexError) as error:
        print("Litepaper build failed: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
