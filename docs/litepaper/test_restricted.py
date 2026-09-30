#!/usr/bin/env python3
"""The token-free documents served to viewers in a country the token geo-policy lists.

Run after building: python3 docs/litepaper/test_restricted.py
"""

import html
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
        # The whole file, not its visible text: tags, meta, JSON-LD, aria, alt, data and class names count.
        restrict.assert_clean(html.unescape(PAGE), "litepaper page")

    def test_the_documents_served_without_a_country_check_stay_token_free(self):
        # THOUGHTS.md is a public static file: it is staged for every viewer, so it must never mention the token.
        restrict.assert_clean((REPO / "THOUGHTS.md").read_text(encoding="utf-8"), "THOUGHTS.md")

    def test_the_check_reads_attributes_meta_tags_json_ld_and_aria_text(self):
        # Each of these sits where a tag-stripping scan cannot see it, and must stop the build.
        injections = {
            "meta description": '<meta name="description" content="Hold $HIVRA tokens">',
            "open graph description": '<meta property="og:description" content="Tokenomics of $HermesOS">',
            "JSON-LD": '<script type="application/ld+json">{"description":"The $HIVRA token"}</script>',
            "aria-label": '<button aria-label="Buy the $HIVRA token">Go</button>',
            "aria-description": '<span aria-description="Locking tokens up to earn more of them.">Lock</span>',
            "data-tip": '<span data-tip="Bankr trading pool">Pool</span>',
            "alt text": '<img src="assets/x.png" alt="The token launch">',
            "title attribute": '<a href="/" title="Tokenomics">Home</a>',
            "class name": '<div class="hero-token"></div>',
            "HTML entity": '<meta name="description" content="Hold &#36;HIVRA">',
        }
        for label, markup in injections.items():
            with self.subTest(label):
                with self.assertRaises(ValueError):
                    restrict.litepaper_html(FULL_PAGE.replace("<body>", "<body>" + markup, 1))
                with self.assertRaises(ValueError):
                    restrict.litepaper_html(FULL_PAGE.replace("</head>", markup + "</head>", 1))

    def test_a_clean_page_still_passes_and_matches_the_committed_copy(self):
        self.assertEqual(restrict.litepaper_html(FULL_PAGE), PAGE)

    def test_the_chapter_index_counts_up_with_no_gap_where_the_economy_chapter_was(self):
        numbers = re.findall(r'<span class="index-number">(\d+)</span>', PAGE)
        self.assertEqual(numbers, ["{:02d}".format(n) for n in range(1, len(numbers) + 1)])
        self.assertEqual(len(numbers), len(re.findall(r'<span class="index-number">', FULL_PAGE)) - 1)

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
        for heading in ("## 5. Control outside the agent", "## 6. The Hivra umbrella"):
            self.assertIn(heading, cut)
        for heading in ("The economic layer", "The migration from", "## 9.", "## 10."):
            self.assertNotIn(heading, cut)

    def test_the_white_paper_is_numbered_without_gaps_and_points_only_at_sections_it_has(self):
        cut = (RESTRICTED / "WHITEPAPER.md").read_text(encoding="utf-8")
        headings = re.findall(r"^## (\d+)\. (.+)$", cut, flags=re.MULTILINE)
        self.assertEqual([number for number, _ in headings], [str(n) for n in range(1, 9)])
        self.assertEqual(headings[-2:], [("7", "Build order"), ("8", "Evidence, limits and open decisions")])
        for line in ("7. Build order", "8. Evidence, limits and open decisions"):
            self.assertIn("\n" + line + "\n", cut)
        self.assertIn("### 8.1 What Hivra cannot do", cut)
        self.assertIn("come later (section 7)", cut)
        self.assertIn("is given in section 7 and Appendix A", cut)
        restrict._assert_sections_consistent(cut, "restricted WHITEPAPER.md")

    def test_a_gap_or_a_dangling_section_reference_is_refused(self):
        cut = (RESTRICTED / "WHITEPAPER.md").read_text(encoding="utf-8")
        with self.assertRaises(ValueError):
            restrict._assert_sections_consistent(cut.replace("## 7. Build order", "## 9. Build order"), "sample")
        with self.assertRaises(ValueError):
            restrict._assert_sections_consistent(cut.replace("(section 7)", "(section 7.3)"), "sample")
        with self.assertRaises(ValueError):
            restrict._assert_sections_consistent(cut.replace("(section 7)", "(section 9)"), "sample")

    def test_the_white_paper_keeps_no_row_or_line_that_points_at_the_removed_sections(self):
        cut = (RESTRICTED / "WHITEPAPER.md").read_text(encoding="utf-8")
        for needle in ("Migration route", "migration", "Parameters open"):
            self.assertNotIn(needle, cut)

    def test_the_tokenomics_copy_is_only_a_notice_and_names_no_country(self):
        notice = (RESTRICTED / "TOKENOMICS.md").read_text(encoding="utf-8")
        self.assertIn("aren't available", notice)
        self.assertLess(len(notice), 400)
        # One file serves every listed country (dashboard/src/lib/compliance/token-geo-list.ts).
        for country in ("United Kingdom", "UK", "Britain", "England", "GB"):
            self.assertNotIn(country, notice)

    def test_a_source_that_still_mentions_the_token_is_refused(self):
        with self.assertRaises(ValueError):
            restrict.assert_clean("Hold $HIVRA for access.", "sample")


if __name__ == "__main__":
    unittest.main(verbosity=2)
