#!/usr/bin/env python3
"""The token-free documents served to viewers in a country the token geo-policy lists.

Run after building: python3 docs/litepaper/test_restricted.py
"""

import re
import unittest
from pathlib import Path

import restrict

REPO = Path(__file__).resolve().parents[2]
RESTRICTED = REPO / "docs/litepaper/restricted"
PAGE = (REPO / "docs/litepaper/restricted.html").read_text(encoding="utf-8")
FULL_PAGE = (REPO / "docs/litepaper/index.html").read_text(encoding="utf-8")


class RestrictedDocumentTests(unittest.TestCase):
    def test_no_restricted_document_mentions_the_token(self):
        restrict.assert_clean((RESTRICTED / "LITEPAPER.md").read_text(encoding="utf-8"), "LITEPAPER.md")
        restrict.assert_clean((RESTRICTED / "WHITEPAPER.md").read_text(encoding="utf-8"), "WHITEPAPER.md")
        restrict.assert_clean(re.sub(r"<(script|style)\b.*?</\1>|<[^>]+>", " ", PAGE, flags=re.DOTALL), "litepaper page")

    def test_the_page_has_no_economy_chapter_and_no_link_into_it(self):
        for needle in ('id="economy"', "#economy", "TOKENOMICS.md", "hero-token", "$HIVRA", "$HermesOS"):
            self.assertNotIn(needle, PAGE)
            if needle in ("id=\"economy\"", "TOKENOMICS.md"):
                self.assertIn(needle, FULL_PAGE, "the full page should still have " + needle)

    def test_everything_else_survives(self):
        for needle in ("The problem is", "Why I", "Where it fits", "Agent Computers", "Read further", "Somewhere", "boundary-lab"):
            self.assertIn(needle, PAGE)
        self.assertEqual(PAGE.count("<section"), PAGE.count("</section>"))
        self.assertEqual(FULL_PAGE.count("<section") - 1 - FULL_PAGE.count("economy-subsection"), PAGE.count("<section"))

    def test_the_founder_letter_is_untouched(self):
        full = (REPO / "LITEPAPER.md").read_text(encoding="utf-8")
        cut = (RESTRICTED / "LITEPAPER.md").read_text(encoding="utf-8")
        start, end = "## Why I'm building it", "## Start with an agent."
        self.assertEqual(full[full.index(start):full.index(end)], cut[cut.index(start):cut.index(end)])

    def test_the_white_paper_keeps_the_architecture_and_drops_the_token_sections(self):
        cut = (RESTRICTED / "WHITEPAPER.md").read_text(encoding="utf-8")
        for heading in ("## 5. Control outside the agent", "## 6. The Hivra umbrella", "## 9. Build order"):
            self.assertIn(heading, cut)
        for heading in ("## 7.", "## 8."):
            self.assertNotIn(heading, cut)

    def test_the_tokenomics_copy_is_only_a_notice(self):
        notice = (RESTRICTED / "TOKENOMICS.md").read_text(encoding="utf-8")
        self.assertIn("aren't available", notice)
        self.assertLess(len(notice), 400)

    def test_a_source_that_still_mentions_the_token_is_refused(self):
        with self.assertRaises(ValueError):
            restrict.assert_clean("Hold $HIVRA for access.", "sample")


if __name__ == "__main__":
    unittest.main(verbosity=2)
