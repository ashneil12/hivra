#!/usr/bin/env python3
"""Focused navigation and copy-preservation checks for the litepaper."""

import unittest
from html.parser import HTMLParser
from pathlib import Path

from link_policy import enhance_links, opens_new_tab


class ParsedLinks(HTMLParser):
    def __init__(self, markup):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.text = []
        self.anchor_depth = 0
        self.nested_anchor = False
        self.feed(markup)

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.nested_anchor |= self.anchor_depth > 0
            self.anchor_depth += 1
            self.links.append(dict(attrs))

    def handle_endtag(self, tag):
        if tag == "a":
            self.anchor_depth -= 1

    def handle_data(self, data):
        self.text.append(data)


class LinkPolicyTests(unittest.TestCase):
    def assert_copy_unchanged(self, before, after):
        self.assertEqual("".join(ParsedLinks(before).text), "".join(ParsedLinks(after).text))

    def test_external_and_document_links_open_safely_without_changing_fragment_navigation(self):
        markup = """<p><a href='https://example.com/?a=1&amp;b=2' rel='ugc opener'>Research</a>
<a href='../../TOKENOMICS.md?v=123#rules' download>Tokenomics</a>
<a class='jump' href='#economy'>Economy</a>
<a href='#top' target='_blank'>Beginning</a>
<a href='mailto:hello@example.com'>Email</a></p>"""
        result = enhance_links(markup)
        links = ParsedLinks(result).links
        for link in links[:2]:
            self.assertEqual(link["target"], "_blank")
            self.assertTrue({"noopener", "noreferrer"}.issubset(link["rel"].split()))
            self.assertNotIn("opener", link["rel"].split())
        self.assertIn("ugc", links[0]["rel"].split())
        self.assertEqual(links[0]["href"], "https://example.com/?a=1&b=2")
        self.assertIn("download", links[1])
        self.assertIn("<a class='jump' href='#economy'>", result)
        self.assertEqual(links[3]["target"], "_self")
        self.assertNotIn("target", links[4])
        self.assert_copy_unchanged(markup, result)

    def test_duplicate_target_attributes_cannot_override_the_policy(self):
        for href, expected in (("https://example.com", "_blank"), ("#economy", "_self")):
            with self.subTest(href=href):
                markup = '<a href="{}" target="_self" target="_blank" rel="noopener" rel="noreferrer">Open</a>'.format(href)
                result = enhance_links(markup)
                self.assertEqual(result.count("target="), 1)
                self.assertEqual(ParsedLinks(result).links[0]["target"], expected)
                self.assert_copy_unchanged(markup, result)

    def test_nibbii_links_are_scoped_and_existing_links_are_never_wrapped(self):
        markup = """<p>Nibbii elsewhere.</p><section id="economy-what-it-s-for">
<p hidden>Nibbii hidden.</p><p>Hivra &amp; Nibbii, together. Nibbii again.</p>
<article id="utility-access-to-nibbii" class="token-utility"><h4>Access to Nibbii.</h4>
<p><a href="https://nibbii.pet/">Nibbii</a> costs $29. It's the same app.</p></article>
<article id="utility-commissioned-pets" class="token-utility"><p>Nibbii pets.</p></article>
</section>"""
        result = enhance_links(markup)
        parsed = ParsedLinks(result)
        self.assertEqual(len(parsed.links), 2)
        self.assertTrue(all(link["href"] == "https://nibbii.pet/" for link in parsed.links))
        self.assertFalse(parsed.nested_anchor)
        self.assertIn("<p>Nibbii elsewhere.</p>", result)
        self.assertIn("<p hidden>Nibbii hidden.</p>", result)
        self.assertIn("<h4>Access to Nibbii.</h4>", result)
        self.assert_copy_unchanged(markup, result)
        self.assertEqual(enhance_links(result), result)

    def test_generated_experience_preserves_every_text_character(self):
        original = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")
        result = enhance_links(original)
        self.assert_copy_unchanged(original, result)
        parsed = ParsedLinks(result)
        self.assertFalse(parsed.nested_anchor)
        nibbii = [link for link in parsed.links if link.get("href") == "https://nibbii.pet/"]
        self.assertGreaterEqual(len(nibbii), 1, "The economy must link the visible Nibbii mention")
        for link in parsed.links:
            href = link.get("href", "")
            if opens_new_tab(href):
                self.assertEqual(link.get("target"), "_blank", href)
                self.assertTrue({"noopener", "noreferrer"}.issubset(link.get("rel", "").split()), href)
            elif href.startswith("#"):
                self.assertIn(link.get("target"), (None, "_self"), href)
        self.assertEqual(enhance_links(result), result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
