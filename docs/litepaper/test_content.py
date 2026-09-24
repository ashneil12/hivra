#!/usr/bin/env python3
"""Guard against the renderer silently dropping approved litepaper copy.

Run after building: python3 docs/litepaper/test_content.py

The expectations come from LITEPAPER.md, not a second copy of its prose. In
particular, a product or utility with several paragraphs must retain all of
them inside its own article. This catches the former first-paragraph-only
renderer even when the page still builds and displays every product name.
"""

import hashlib
import re
import unittest
from collections import Counter
from dataclasses import dataclass, field
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


REPO = Path(__file__).resolve().parents[2]
PAGE = REPO / "docs/litepaper/index.html"
# Same-origin files the Next.js app serves at the site root, which the page
# links by site-root path. Kept separate from build.py so the test checks it.
SITE_ROOT_FILES = {
    "/favicon.ico": REPO / "dashboard/src/app/favicon.ico",
    "/apple-icon.png": REPO / "dashboard/src/app/apple-icon.png",
}
VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
NON_READER_TAGS = {"script", "style", "svg", "template", "noscript"}
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
ENTRY = re.compile(r"^\*\*([^*\n]+)\.\*\*[^\n]*", re.MULTILINE)
INTERACTIVE_NOTE = re.compile(r"^\*?\[Interactive:[\s\S]+\]\*?$", re.IGNORECASE)


@dataclass
class Element:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)

    def text(self):
        if self.tag in NON_READER_TAGS:
            return ""
        return " ".join(
            child.text() if isinstance(child, Element) else child
            for child in self.children
        )


class PageParser(HTMLParser):
    def __init__(self, markup):
        super().__init__(convert_charrefs=True)
        self.root = Element("document")
        self.stack = [self.root]
        self.elements = []
        self.feed(markup)

    def handle_starttag(self, tag, attrs):
        element = Element(tag, dict(attrs))
        self.stack[-1].children.append(element)
        self.elements.append(element)
        if tag not in VOID_TAGS:
            self.stack.append(element)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def words(value):
    """Ignore presentation punctuation, but retain every word and its order."""
    value = LINK.sub(lambda match: match[1], value)
    return " ".join(re.findall(r"\w+", unescape(value).casefold()))


def reader_blocks(markdown):
    for block in re.split(r"\n\s*\n", markdown.strip()):
        block = block.strip()
        if not block or re.fullmatch(r"-{3,}", block):
            continue
        # This is the sole author annotation, not prose supplied to the reader.
        if INTERACTIVE_NOTE.fullmatch(block):
            continue
        lines = block.splitlines()
        if all(re.match(r"^(?:\d+\.|[-+*])\s+", line) for line in lines):
            for line in lines:
                yield re.sub(r"^(?:\d+\.|[-+*])\s+", "", line)
        elif LINK.search(block) and not words(LINK.sub("", block)):
            # Adjacent action links may have a reader-mode button between them.
            yield from (match[1] for match in LINK.finditer(block))
        else:
            yield block


def section(markdown, heading, level):
    marker = "#" * level
    match = re.search(r"^" + marker + " " + re.escape(heading) + r"\s*$", markdown, re.MULTILINE)
    if not match:
        raise AssertionError("Source section not found: " + heading)
    following = markdown[match.end():]
    end = re.search(r"^#{1," + str(level) + r"} ", following, re.MULTILINE)
    return following[:end.start()] if end else following


def named_entries(markdown):
    matches = list(ENTRY.finditer(markdown))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        chunk = markdown[match.start():end]
        # The last product in a stage is followed by a separator and a heading
        # or the roadmap's closing paragraph, which belongs outside its article.
        chunk = re.split(r"^---\s*$|^#{1,6} ", chunk, maxsplit=1, flags=re.MULTILINE)[0]
        yield match[1], list(reader_blocks(chunk))


def missing_blocks(blocks, rendered_text):
    rendered_words = " " + words(rendered_text) + " "
    return [block for block in blocks if " " + words(block) + " " not in rendered_words]


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


class LitepaperContentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markdown = (REPO / "LITEPAPER.md").read_text(encoding="utf-8")
        cls.page = PageParser(PAGE.read_text(encoding="utf-8"))
        cls.by_id = {node.attrs["id"]: node for node in cls.page.elements if "id" in node.attrs}

    def test_source_matches_current_user_approved_wording_byte_for_byte(self):
        # The build pin in stage-litepaper.mjs is the approved wording contract.
        # Rendering edited source faithfully must not conceal an unapproved copy
        # change. Re-pin only to new user-approved copy.
        stage = (REPO / "dashboard/scripts/stage-litepaper.mjs").read_text(encoding="utf-8")
        pin = re.search(r"APPROVED_SOURCE_SHA256 = '([0-9a-f]{64})'", stage)
        self.assertIsNotNone(pin, "stage-litepaper.mjs must pin the approved LITEPAPER.md")
        self.assertEqual(
            hashlib.sha256((REPO / "LITEPAPER.md").read_bytes()).hexdigest(),
            pin[1],
            "LITEPAPER.md differs from the current user-approved wording",
        )

    def test_litepaper_has_a_clear_route_back_to_the_hivra_homepage(self):
        homepage_links = [
            node for node in self.page.elements
            if node.tag == "a" and node.attrs.get("href") == "/"
        ]
        self.assertGreaterEqual(len(homepage_links), 3)
        self.assertTrue(any("Back to Hivra" in node.text() for node in homepage_links))

    def test_shared_links_get_a_title_description_image_and_the_official_x_account(self):
        meta = {}
        for node in self.page.elements:
            if node.tag == "meta":
                key = node.attrs.get("property") or node.attrs.get("name")
                if key:
                    meta[key] = node.attrs.get("content")
        title = next(node for node in self.page.elements if node.tag == "title").text().strip()
        self.assertEqual(meta["og:title"], title)
        self.assertEqual(meta["og:description"], meta["description"])
        self.assertEqual(meta["og:type"], "website")
        self.assertEqual(meta["og:url"], "https://hivra.cloud/docs/litepaper/index.html")
        self.assertEqual(meta["twitter:card"], "summary_large_image")
        self.assertEqual(meta["twitter:site"], "@HivraOS")
        # The share image is absolute and names a committed litepaper asset.
        image = urlsplit(meta["og:image"])
        self.assertEqual((image.scheme, image.netloc), ("https", "hivra.cloud"))
        self.assertTrue(image.path.startswith("/docs/litepaper/assets/"))
        asset = REPO / image.path.lstrip("/")
        self.assertTrue(asset.is_file(), "Missing share image: " + meta["og:image"])
        header = asset.read_bytes()[:24]
        self.assertEqual(
            (int(meta["og:image:width"]), int(meta["og:image:height"])),
            (int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")),
        )
        self.assertTrue(meta["og:image:alt"])

    def test_the_tab_shows_the_app_favicon(self):
        icons = {
            node.attrs.get("rel"): node.attrs.get("href")
            for node in self.page.elements if node.tag == "link" and "icon" in node.attrs.get("rel", "")
        }
        self.assertEqual(icons.get("icon"), "/favicon.ico")
        self.assertEqual(icons.get("apple-touch-icon"), "/apple-icon.png")
        for href in icons.values():
            self.assertTrue(SITE_ROOT_FILES[href].is_file(), "Missing app file: " + href)

    def test_standalone_tokenomics_preserves_the_complete_economy_wording(self):
        expected = "# Hivra tokenomics\n\n" + section(
            self.markdown, "The economy", 2
        ).strip().replace("### ", "## ") + "\n"
        self.assertEqual(
            (REPO / "TOKENOMICS.md").read_text(encoding="utf-8"),
            expected,
            "TOKENOMICS.md must be the complete economy excerpt, not a separate paraphrase",
        )

    def assert_content(self, blocks, element, label):
        missing = missing_blocks(blocks, element.text())
        self.assertFalse(missing, label + " lost source copy:\n" + "\n".join(missing))

    def test_every_reader_block_survives(self):
        mains = [node for node in self.page.elements if node.tag == "main"]
        self.assertEqual(len(mains), 1, "The experience must have one main reading area")
        self.assert_content(reader_blocks(self.markdown), mains[0], "The page")

    def test_all_fifteen_product_narratives_stay_in_their_articles(self):
        roadmap = section(self.markdown, "What we're building around it", 2)
        products = list(named_entries(roadmap))
        self.assertEqual(len(products), 15, "The complete source roadmap has 15 products")
        rendered = [node for node in self.page.elements if "product-panel" in node.attrs.get("class", "").split()]
        self.assertEqual(len(rendered), len(products))
        for name, blocks in products:
            with self.subTest(product=name):
                article = self.by_id.get("product-" + slug(name))
                self.assertIsNotNone(article, "Missing product article: " + name)
                self.assert_content(blocks, article, name)

    def test_all_twelve_token_utility_explanations_stay_in_their_articles(self):
        economy = section(self.markdown, "The economy", 2)
        utilities = list(named_entries(section(economy, "What it's for", 3)))
        self.assertEqual(len(utilities), 12, "The complete source has 12 token utilities")
        rendered = [node for node in self.page.elements if "token-utility" in node.attrs.get("class", "").split()]
        self.assertEqual(len(rendered), len(utilities))
        for name, blocks in utilities:
            with self.subTest(utility=name):
                article = self.by_id.get("utility-" + slug(name))
                self.assertIsNotNone(article, "Missing token utility article: " + name)
                self.assert_content(blocks, article, name)

    def test_local_assets_documents_and_fragment_links_resolve(self):
        ids = [node.attrs["id"] for node in self.page.elements if "id" in node.attrs]
        duplicates = [value for value, count in Counter(ids).items() if count > 1]
        self.assertFalse(duplicates, "Duplicate navigation targets: " + repr(duplicates))
        for node in self.page.elements:
            for attribute in ("href", "src", "poster"):
                value = node.attrs.get(attribute)
                if not value:
                    continue
                if value == "/":
                    continue
                target = urlsplit(value)
                if target.scheme or target.netloc:
                    continue
                if target.path in SITE_ROOT_FILES:
                    with self.subTest(tag=node.tag, attribute=attribute, url=value):
                        self.assertTrue(SITE_ROOT_FILES[target.path].is_file(), "Missing app file: " + value)
                    continue
                with self.subTest(tag=node.tag, attribute=attribute, url=value):
                    resolved = (PAGE.parent / unquote(target.path)).resolve() if target.path else PAGE
                    self.assertIn(REPO, resolved.parents, "Local URL leaves the repository")
                    self.assertTrue(resolved.is_file(), "Missing local file: " + value)
                    if target.fragment and resolved.suffix.lower() == ".html":
                        parser = self.page if resolved == PAGE else PageParser(resolved.read_text(encoding="utf-8"))
                        target_ids = {element.attrs.get("id") for element in parser.elements}
                        self.assertIn(unquote(target.fragment), target_ids, "Missing fragment target: " + value)


if __name__ == "__main__":
    unittest.main(verbosity=2)
