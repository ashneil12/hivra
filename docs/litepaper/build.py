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
import math
import re
import struct
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from link_policy import enhance_links

REPO = Path(__file__).resolve().parents[2]
OUTPUT = REPO / "docs/litepaper/index.html"
# The page is served by the Next.js app at /docs/litepaper/index.html, so it may
# link these same-origin app files by site-root path. Each maps to the committed
# file the app serves at that path.
SITE_ROOT_FILES = {
    "/favicon.ico": "dashboard/src/app/favicon.ico",
    "/apple-icon.png": "dashboard/src/app/apple-icon.png",
}
# Share tags need absolute URLs; they name the canonical site.
SITE_URL = "https://hivra.cloud"
PAGE_URL = SITE_URL + "/docs/litepaper/index.html"
PAGE_TITLE = "Hivra · Somewhere better to work"
PAGE_DESCRIPTION = ("Your agent needs a computer. It doesn't need yours. Explore Hivra's vision for "
                    "independent agent computers and an ecosystem with boundaries outside the agent.")
SHARE_IMAGE = "assets/boundary-monolith-v5.png"
SHARE_IMAGE_ALT = "Architectural illustration of a bounded computer."
PRODUCT_GROUPS = {
    "Gate": "Next", "Exchange": "Next", "Arena": "Next", "Signal": "Next",
    "Vault": "Then", "Passport": "Then", "Seal": "Then", "Rescue": "Then",
    "Challenges": "Then", "Experience": "Then",
    "Missions": "Horizon", "Foundry": "Horizon", "Colony": "Horizon",
    "Interchange": "Horizon", "Ports": "Horizon",
}
REQUIRED_SECTIONS = {
    "Your agent needs a computer. It doesn't need yours.",
    "The problem is where it lives", "Why I'm building it",
    "Start with an agent. Or a computer.", "A computer you can actually work in",
    "Open source. Yours to run.", "Keeping a mistake from reaching everything",
    "What we're building around it", "The economy", "Read further",
    "Somewhere better to work",
}
REQUIRED_SUBSECTIONS = {
    "The problem is where it lives": {"Try it", "A good agent can still be led somewhere bad"},
    "Start with an agent. Or a computer.": {
        "Launch an agent", "Launch a computer", "Keep several running", "Choose who runs it",
    },
    "A computer you can actually work in": {
        "Come back to it", "Settle in", "Follow the work", "Know what has access",
    },
    "What we're building around it": {"Agent Computers · Available now", "Next", "Then", "Research"},
    "The economy": {
        "There's already a token, and it already does something", "The migration",
        "What it's for", "The treasury", "Rules for the token",
    },
}
UTILITY_NAMES = (
    "Access to compute", "Metered spending", "Packs", "Reserved capacity",
    "Containment bounties", "Certification bonds", "Threat report payouts",
    "Publisher payouts", "Certification fees", "Experience packages",
    "Mission funding", "Agent budgets",
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


def blocks(value):
    rendered = []
    for block in re.split(r"\n\s*\n", value.strip()):
        if not block or block == "---" or block.startswith("*[Interactive:"):
            continue
        if block.startswith("### "):
            rendered.append("<h3>" + inline(block[4:]) + "</h3>")
        elif re.match(r"^\d+\. ", block):
            items = re.findall(r"^\d+\. (.+)$", block, flags=re.MULTILINE)
            rendered.append("<ol>" + "".join("<li>" + inline(item) + "</li>" for item in items) + "</ol>")
        elif block.startswith("> "):
            rendered.append("<blockquote>" + inline(block[2:]) + "</blockquote>")
        elif block.startswith("```"):
            rendered.append("<pre>" + escape(block.strip("`\n")) + "</pre>")
        else:
            rendered.append("<p>" + inline(block) + "</p>")
    return "\n".join(rendered)


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
    path = unquote(target.path)
    require(not path.startswith("/") and "\\" not in path,
            "Local links must be repository-relative: " + value)
    resolved = (base / path).resolve()
    require(resolved == REPO or REPO in resolved.parents,
            "Local link escapes the repository: " + value)


def load_inputs():
    markdown = (REPO / "LITEPAPER.md").read_text(encoding="utf-8")
    require(not AUTHOR_NOTE.search(markdown), "Author-only note found in LITEPAPER.md")
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", markdown):
        check_local_url(target, REPO)
    sections = {}
    for chunk in re.split(r"^## ", markdown, flags=re.MULTILINE)[1:]:
        title, body = chunk.split("\n", 1)
        require(title not in sections, "Duplicate section: " + title)
        sections[title] = body.strip().removesuffix("---").strip()
    check_names(sections, REQUIRED_SECTIONS, "LITEPAPER.md sections")
    for title, expected in REQUIRED_SUBSECTIONS.items():
        check_names(split_sub(sections[title])[1], expected, title + " subsections")

    stages = split_sub(sections["What we're building around it"])[1]
    products = []
    roadmap_tail = ""
    for stage in ("Next", "Then", "Research"):
        group = "Horizon" if stage == "Research" else stage
        for match in re.finditer(
                r"^\*\*([A-Za-z]+)\.\*\* \*(.+?)\*\n\n(.*?)(?=^\*\*[A-Za-z]+\.\*\*|\Z)",
                stages[stage], flags=re.DOTALL | re.MULTILINE):
            name, summary, story = match.groups()
            related_match = re.search(r"^\*Related: (.+?)\.\*$", story, flags=re.MULTILINE)
            require(related_match is not None, "Missing Related line for " + name)
            related = [value.strip() for value in related_match[1].split(",")]
            require(2 <= len(related) <= 3 and len(set(related)) == len(related), "Invalid related products for " + name)
            require(all(value in PRODUCT_GROUPS and value != name for value in related), "Unknown related product for " + name)
            remainder = story[related_match.end():].strip().strip("-\n ")
            if remainder:
                require(stage == "Research" and name == "Ports", "Unexpected copy after Related line for " + name)
                roadmap_tail = remainder
            products.append({"name": name, "summary": summary,
                             "description": story[:related_match.start()].strip(),
                             "related": related, "group": group})
    require(len(products) == 15, "The roadmap must contain exactly 15 complete product stories")
    check_names([product["name"] for product in products], PRODUCT_GROUPS, "Roadmap product names")
    for product in products:
        require(product["group"] == PRODUCT_GROUPS[product["name"]], "Wrong roadmap group for " + product["name"])
    require(bool(roadmap_tail), "Missing roadmap closing paragraph")
    return sections, products, roadmap_tail


class LocalLinkChecker(HTMLParser):
    # Check output URLs after HTML escaping has been decoded by the parser.
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key not in {"href", "src"} or not value:
                continue
            check_local_url(value, OUTPUT.parent)


def png_size(path):
    header = path.read_bytes()[:24]
    require(header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR", "Not a PNG: " + str(path))
    return struct.unpack(">II", header[16:24])


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def build_page():
    sections, products, roadmap_tail = load_inputs()
    problem, sub = split_sub(sections["The problem is where it lives"])
    doors, doors_sub = split_sub(sections["Start with an agent. Or a computer."])
    qualities, quality_sub = split_sub(sections["A computer you can actually work in"])
    roadmap_intro, stages = split_sub(sections["What we're building around it"])
    economy, econ_sub = split_sub(sections["The economy"])
    feature_names = ["Come back to it", "Settle in", "Follow the work", "Know what has access"]
    feature_big = ['STAYS.', 'CLOSE.', 'VISIBLE.', 'BOUNDED.']
    feature_images = ['agent-computer-opportunity-v2.png', 'boundary-monolith-v5.png', 'observable-run-v2.png', 'agent-computer-hero-v2.png']
    feature_alts = ['One workspace connects to a laptop, tablet and phone.', SHARE_IMAGE_ALT, 'Concept illustration connecting a request, observed actions and result.', 'Personal device beside a separate agent computer.']
    features = ''
    for i, name in enumerate(feature_names):
        features += f'<article class="quality-panel"><div class="quality-word" aria-hidden="true">{feature_big[i]}</div><div class="quality-layout"><figure><img src="assets/{feature_images[i]}" alt="{feature_alts[i]}" width="1536" height="1024" loading="lazy"></figure><div class="quality-copy"><span class="quality-position" aria-hidden="true">{i+1:02d} / 04</span><h3>{escape(name)}</h3>{blocks(quality_sub[name])}</div></div></article>'
    launch_body, launch_list = doors_sub['Choose who runs it'].split('**The launch:**', 1)
    utility_source = econ_sub["What it's for"]
    utility_intro = utility_source.split('**Access to compute.**', 1)[0]
    utilities = []
    for match in re.finditer(r"^\*\*(.+?)\.\*\* (.*?)(?=^\*\*.+?\.\*\* |\Z)", utility_source, flags=re.MULTILINE | re.DOTALL):
        name, text = match.groups()
        utilities.append((name, text.strip()))
    check_names([name for name, text in utilities], UTILITY_NAMES, "Token utilities")
    require(len(utilities) == len(UTILITY_NAMES), "Expected exactly {} token utility entries".format(len(UTILITY_NAMES)))
    utility_html = ''.join(f'<article class="token-utility scene-reveal" id="utility-{slug(name)}"><div class="utility-heading"><span class="utility-index" aria-hidden="true">{i+1:02d}</span><h4>{escape(name)}.</h4></div><div class="utility-copy">{blocks(text)}</div></article>' for i, (name, text) in enumerate(utilities))
    economy_html = ''
    for name, text in econ_sub.items():
        if name == "What it's for":
            content = f'<div class="prose">{blocks(utility_intro)}</div><div class="token-utilities">{utility_html}</div>'
        else:
            content = f'<div class="prose">{blocks(text)}</div>'
        economy_html += f'<section class="economy-subsection scene-reveal" id="economy-{slug(name)}"><h3>{escape(name)}</h3>{content}</section>'
    hero_title = "Your agent needs a computer. It doesn't need yours."
    hero_intro = sections[hero_title].split('\n\n')[0]
    hero_caption = ''.join(f'<span>{inline(part)}</span>' for part in re.split(r'(?<=\.)\s+', hero_intro, maxsplit=1))
    reading_copy, reading_links = sections['Read further'].rsplit('\n\n', 1)
    finale_copy, finale_links = sections['Somewhere better to work'].rsplit('\n\n', 1)
    source_reading_links = inline(reading_links).replace('<a ', '<a class="text-link" ')
    source_finale_links = inline(finale_links).replace('<a ', '<a class="text-link" ')
    try_it_copy = blocks(sub['Try it'])
    # Tabler's MIT arrow-down-right path; attribution is in vendor/NOTICE.md.
    explore_arrow = '<svg class="action-arrow" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10"/><path d="M17 8l0 9l-9 0"/></svg>'
    node_html = ''
    panel_html = ''
    paths = ''
    # Product stories sit in source order around a single ring; this is not a dependency graph.
    for i,p in enumerate(products):
        group = p['group']
        angle=math.radians(-90 + i * (360 / len(products)))
        radius=285
        x = 350 + math.cos(angle) * radius
        y = 350 + math.sin(angle) * radius
        s = slug(p['name'])
        paths+=f'<path data-line="{s}" d="M350 350 Q{350+(x-350)*.3:.1f} {y:.1f} {x:.1f} {y:.1f}"/>'
        node_html+=f'<button class="atlas-node" data-product="{s}" aria-controls="product-{s}" aria-expanded="true" style="--x:{x/7:.2f}%;--y:{y/7:.2f}%"><span class="node-name">{p["name"]}</span><span class="node-invitation">Explore {explore_arrow}</span></button>'
        related=''.join(f'<button data-product="{slug(r)}">{escape(r)} {explore_arrow}</button>' for r in p['related'])
        extra = f'<div class="product-depth">{blocks(p["description"])}<p class="related-invitation"><span data-input-verb>Click</span> a related idea to keep exploring</p><div class="related"><span>Related:</span>{related}</div></div>'
        stage_label = 'Research' if group == 'Horizon' else group
        panel_html += f'<article class="product-panel" id="product-{s}" tabindex="-1" data-stage="{group}"><button class="back-to-atlas">{explore_arrow} All products</button><p class="product-stage">{stage_label}</p><h3>{p["name"]}.</h3><p class="product-summary">{inline(p["summary"])}</p>{extra}<div class="product-pagination"><button data-product="{slug(products[(i-1)%15]["name"])}" aria-label="Previous product: {products[(i-1)%15]["name"]}">← Previous</button><span>{i+1:02d} / 15</span><button data-product="{slug(products[(i+1)%15]["name"])}" aria-label="Next product: {products[(i+1)%15]["name"]}">Next →</button></div></article>'
    boundary_markup = (OUTPUT.parent / "boundary.html").read_text(encoding="utf-8")
    protection = sections['Keeping a mistake from reaching everything']
    before_quote, quote_and_after = protection.split('\n\n> ', 1)
    quote, after_quote = quote_and_after.split('\n\n', 1)
    problem_paragraphs = problem.split('\n\n')
    problem_opening = '\n\n'.join(problem_paragraphs[:3])
    problem_context = '\n\n'.join(problem_paragraphs[3:])
    chapter_links = [('opportunity', 'The problem'), ('founder', "Why I’m building it"), ('experience', 'Agent or computer'), ('observability', 'The product'), ('platform', 'Open by design'), ('security', 'The boundary'), ('future', 'The ecosystem'), ('economy', 'The economy'), ('reading-room', 'Read further')]
    index_links = ''.join(f'<a href="#{target}"><span class="index-number">{i+1:02d}</span><span>{label}</span>{explore_arrow}</a>' for i, (target, label) in enumerate(chapter_links))
    share_width, share_height = png_size(OUTPUT.parent / SHARE_IMAGE)
    # Reader copy is rendered at build time. Chapter headings and diagrams are intentionally shaped below.
    page=f'''<!doctype html>
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
<link rel="preload" as="image" href="assets/boundary-monolith-v5.png">
<link rel="stylesheet" href="litepaper.css?v={hashlib.sha256((OUTPUT.parent / "litepaper.css").read_bytes()).hexdigest()[:12]}">
<link rel="preload" as="font" type="font/ttf" crossorigin href="assets/fonts/Manrope-Variable.ttf">
<script defer src="vendor/gsap-3.15.0.min.js"></script>
<script defer src="vendor/ScrollTrigger-3.15.0.min.js"></script>
<script defer src="litepaper.js?v={hashlib.sha256((OUTPUT.parent / "litepaper.js").read_bytes()).hexdigest()[:12]}"></script>
<script defer src="experience-motion.js?v={hashlib.sha256((OUTPUT.parent / "experience-motion.js").read_bytes()).hexdigest()[:12]}"></script>
</head>
<body>
<div id="top" aria-hidden="true"></div>
<a class="skip-link" href="#main">Skip to the litepaper</a>
<header class="site-header"><a class="brand" href="/" aria-label="Back to the Hivra homepage"><span class="brand-mark" aria-hidden="true"></span>Hivra</a><nav aria-label="Primary navigation"><a href="#opportunity">Why Hivra</a><a href="#experience">How it works</a><a href="#observability">Activity</a><a href="#future">What's next</a></nav><div class="reader-tools"><button class="chapter-index-toggle" aria-controls="chapter-index" aria-expanded="false">Index<span aria-hidden="true" class="index-icon"></span></button><button class="reading-toggle" aria-pressed="false">Read</button><button class="motion-toggle" aria-pressed="false" aria-label="Pause animation">Motion on</button><button class="theme-toggle" aria-label="Switch to light theme">Light</button></div></header>
<dialog class="chapter-index-panel" id="chapter-index" aria-labelledby="index-title"><div class="index-top"><a class="brand" href="/" aria-label="Back to the Hivra homepage"><span class="brand-mark" aria-hidden="true"></span>Hivra</a><button class="chapter-index-close" aria-label="Close chapter index">Close <span aria-hidden="true">×</span></button></div><div class="index-layout"><div class="index-intro"><p class="mini-label">The Hivra litepaper</p><h2 id="index-title">Find your<br>place.</h2><p>Give it room to work.<br>Decide what it can reach.</p></div><nav class="index-links" aria-label="Chapter index">{index_links}</nav></div><div class="index-bottom"><a href="/">Back to Hivra {explore_arrow}</a><a href="../../LITEPAPER.md">Save the litepaper {explore_arrow}</a></div></dialog>
<main id="main">
<section class="hero" id="beginning" data-chapter="The beginning">
<div class="hero-art" aria-hidden="true"><div class="hero-object-stage"><div class="hero-object"><img src="assets/boundary-monolith-v5.png" alt="" width="1672" height="940" fetchpriority="high"><div class="hero-object-edge"></div></div><div class="hero-coordinate coordinate-top">HIVRA / AGENT COMPUTERS</div><div class="hero-coordinate coordinate-bottom">A place of its own.</div></div><div class="hero-shade"></div><canvas id="field-canvas"></canvas></div><div class="hero-watermark" aria-hidden="true">HIVRA</div>
<div class="hero-content"><p class="hero-kicker">The Hivra litepaper</p><h1><span class="line">Your agent</span><span class="line">needs a</span><span class="line hero-emphasis">computer.</span><span class="hero-answer">It doesn't need yours.</span></h1><a class="text-link enter-link" href="#opportunity">Enter <span class="enter-arrow" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10"/><path d="M17 8l0 9l-9 0"/></svg></span></a></div>
<div class="hero-caption"><span class="hero-caption-mark" aria-hidden="true">H—</span>{hero_caption}<span class="hero-scroll" aria-hidden="true">SCROLL TO EXPLORE<span></span></span></div>
<div class="hero-transition" aria-hidden="true">Give it room<br>to work.</div>
</section>
<section class="problem chapter shell" id="opportunity" data-chapter="The problem">
<div class="chapter-heading"><h2>The problem is<br>where it lives</h2></div>
<div class="prose problem-intro">{blocks(problem_opening)}</div><div class="problem-layout">{boundary_markup}<div class="prose problem-context">{blocks(problem_context)}<h3>Try it</h3>{try_it_copy}</div></div><div class="problem-prose"><h3>A good agent can still be led somewhere bad</h3><div class="prose">{blocks(sub["A good agent can still be led somewhere bad"])}</div></div>
</section>
<section class="founder chapter shell" id="founder" data-chapter="Why I’m building it"><div class="founder-heading"><span class="founder-rule" aria-hidden="true"></span><h2>Why I'm<br>building it</h2></div><div class="prose founder-copy">{blocks(sections["Why I'm building it"])}</div></section>
<section class="boundary-passage" aria-label="The central principle"><div class="passage-lines" aria-hidden="true">{''.join('<i></i>' for _ in range(8))}</div><p>Give it room to work.<br><span>Decide what it can reach.</span></p></section>
<section class="doors-section chapter shell" id="experience" data-chapter="Agent or computer"><div class="chapter-heading"><h2>Start with an agent.<br>Or a computer.</h2><div class="intro-copy">{blocks(doors)}</div></div><div class="doors"><article class="door door-agent scene-reveal"><div class="door-art" aria-hidden="true"><span class="door-frame"></span><span class="door-frame"></span><span class="door-frame"></span><span class="door-symbol">&gt;_</span></div><h3>Launch an agent</h3>{blocks(doors_sub['Launch an agent'])}</article><article class="door door-computer scene-reveal"><div class="door-art" aria-hidden="true"><span class="door-frame"></span><span class="door-frame"></span><span class="door-frame"></span><span class="door-symbol"><svg viewBox="0 0 80 70"><rect x="7" y="5" width="66" height="44" rx="3"/><path d="M40 50v12M24 64h32"/></svg></span></div><h3>Launch a computer</h3>{blocks(doors_sub['Launch a computer'])}</article></div><div class="two-column-copy"><div><h3>Keep several running</h3>{blocks(doors_sub['Keep several running'])}</div><div id="operation"><h3>Choose who runs it</h3>{blocks(launch_body)}</div></div><div class="launch-journey"><p>The launch:</p>{blocks(launch_list)}</div></section>
<section class="qualities chapter" id="observability" data-chapter="The product bar"><div class="shell chapter-heading"><h2>A computer you can<br>actually work in</h2><div class="intro-copy">{blocks(qualities)}</div></div><div class="quality-stage"><div class="quality-track">{features}</div></div></section>
<section class="open-section chapter shell" id="platform" data-chapter="Open by design"><div class="open-visual" aria-hidden="true"><div class="open-frame frame-one"></div><div class="open-frame frame-two"></div><div class="open-frame frame-three"></div><span>OPEN.</span></div><div class="open-copy"><h2>Open source.<br>Yours to run.</h2><div class="prose">{blocks(sections['Open source. Yours to run.'])}</div></div></section>
<section class="constitution chapter shell" id="security" data-chapter="The constitution"><div class="chapter-heading"><h2>Keeping a mistake<br>from reaching everything</h2></div><div class="constitution-layout"><div class="prose">{blocks(before_quote)}</div><div class="constitution-statement"><span class="constitutional-frame" aria-hidden="true"></span><p class="mini-label">The constitution</p><blockquote>{inline(quote)}</blockquote></div></div><div class="constitution-foot">{blocks(after_quote)}</div></section>
<section class="roadmap chapter" id="future" data-chapter="The ecosystem"><div class="shell chapter-heading"><h2>What we're building<br><span class="muted-text">around it</span></h2><div class="intro-copy">{blocks(roadmap_intro)}</div></div><div class="shell foundation"><span class="foundation-mark" aria-hidden="true"></span><div><h3>Agent Computers · Available now</h3>{blocks(stages['Agent Computers · Available now'])}</div></div><div class="shell interaction-invitation atlas-invitation"><span class="invitation-label">Explore the ecosystem</span><p><span data-input-verb>Click</span> any product to open its story.</p></div><div class="shell atlas-header"><div class="atlas-filter-set"><p class="atlas-filter-label"><span data-input-verb>Click</span> a stage to highlight its ideas</p><div class="atlas-filters" role="group" aria-label="Highlight roadmap stage"><button data-stage-filter="all" aria-pressed="true">All products</button><button data-stage-filter="Next" aria-pressed="false">Next</button><button data-stage-filter="Then" aria-pressed="false">Then</button><button data-stage-filter="Horizon" aria-pressed="false">Research</button></div></div><button class="expand-products" aria-pressed="false">Read all 15</button></div><div class="atlas-layout shell"><div class="atlas-map"><svg viewBox="0 0 700 700" aria-hidden="true" class="atlas-lines"><circle cx="350" cy="350" r="112"/><circle cx="350" cy="350" r="202"/><circle cx="350" cy="350" r="294"/>{paths}</svg><div class="atlas-core" aria-hidden="true"><span class="brand-mark"></span><strong>Hivra</strong><span>Agent Computers</span></div>{node_html}<p class="atlas-note">Positions group ideas; lines aren't implemented connections.</p></div><div class="product-panels">{panel_html}</div></div><div class="shell roadmap-foot">{blocks(roadmap_tail)}</div></section>
<section class="economy chapter shell" id="economy" data-chapter="The economy"><div class="chapter-heading"><h2>The economy</h2></div><div class="economy-intro prose">{blocks(economy)}</div><div class="economy-visual scene-reveal" aria-hidden="true"><span class="economy-wordmark">HIVRA</span><div class="economy-token"><span class="brand-mark"></span></div><div class="economy-visual-caption"><span>COMPUTE · TOOLS · WORK · KNOWLEDGE</span><span>ONE CONNECTED ECONOMY</span></div></div>{economy_html}</section>
<section class="reading-room chapter shell" id="reading-room" data-chapter="Read further"><h2>Read further</h2><div class="prose">{blocks(reading_copy)}</div><div class="reading-actions"><p class="source-links">{source_reading_links}</p><button class="text-link reading-toggle" aria-pressed="false">Continuous reading <span aria-hidden="true">↗</span></button></div></section>
<section class="finale chapter" id="somewhere-better" data-chapter="Somewhere better"><div class="finale-art" aria-hidden="true"><img src="assets/boundary-monolith-v5.png" alt="" width="1672" height="940" loading="lazy"></div><div class="shell"><h2>Somewhere<br><span>better to work</span></h2><div class="prose finale-copy">{blocks(finale_copy)}</div><div class="finale-links source-links">{source_finale_links}</div></div></section>
</main>
<footer class="shell site-footer"><a class="brand" href="/" aria-label="Back to the Hivra homepage"><span class="brand-mark" aria-hidden="true"></span>Hivra</a><p>Give it room to work.<br>Decide what it can reach.</p><div class="footer-links"><a href="/">Back to Hivra {explore_arrow}</a><a href="../../WHITEPAPER.md">White Paper {explore_arrow}</a></div></footer>
<nav class="chapter-dock" aria-label="Chapters"><button class="chapter-index-toggle dock-index-toggle" aria-label="Open chapter index"><span class="index-icon" aria-hidden="true"></span><span class="dock-index-label">Index</span><span class="dock-current">The beginning</span></button><a href="#opportunity" aria-label="The problem">The problem</a><a href="#experience" aria-label="The computer">The computer</a><a href="#security" aria-label="The constitution">The boundary</a><a href="#future" aria-label="The ecosystem">The ecosystem</a><a href="#economy" aria-label="The economy">The economy</a><div class="reading-progress" aria-hidden="true"></div></nav>
</body></html>'''
    # Chapter markers are navigational metadata; the approved narrative stays intact.
    markers = iter(('The problem', 'The computer', 'The experience', 'The boundary', 'The ecosystem', 'The economy'))
    marker_number = 0
    def masthead(match):
        nonlocal marker_number
        marker_number += 1
        label = next(markers)
        return match[0].replace('chapter-heading', 'chapter-heading chapter-masthead') + f'<div class="chapter-marker"><span>{label}</span><i aria-hidden="true"></i><span aria-hidden="true">H / {marker_number:02d}</span></div>'
    page = re.sub(r'<div class="(?:shell )?chapter-heading">', masthead, page)
    page = enhance_links(page)
    require(not AUTHOR_NOTE.search(page), "Author-only note found in generated HTML")
    LocalLinkChecker().feed(page)
    return page


def build_tokenomics():
    # Keep the standalone download on the same wording source as the website.
    markdown = (REPO / "LITEPAPER.md").read_text(encoding="utf-8")
    economy = markdown.split("\n## The economy\n", 1)[1].split("\n## ", 1)[0]
    return "# Hivra tokenomics\n\n" + economy.strip().replace("### ", "## ") + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the page or tokenomics download needs regeneration")
    args = parser.parse_args()
    try:
        outputs = {
            OUTPUT: build_page().encode("utf-8"),
            REPO / "TOKENOMICS.md": build_tokenomics().encode("utf-8"),
        }
        if args.check:
            stale = [str(path.relative_to(REPO)) for path, content in outputs.items()
                     if not path.exists() or path.read_bytes() != content]
            if stale:
                print("Stale " + ", ".join(stale) + "; run python3 docs/litepaper/build.py", file=sys.stderr)
                return 1
            print("Current: page and tokenomics download (15 products, {} token uses)".format(len(UTILITY_NAMES)))
        else:
            for path, content in outputs.items():
                path.write_bytes(content)
                print("Built {}: {} bytes".format(path.relative_to(REPO), len(content)))
    except (OSError, ValueError, KeyError, IndexError) as error:
        print("Litepaper build failed: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
