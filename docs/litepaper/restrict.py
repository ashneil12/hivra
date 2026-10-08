"""Token-free copies of the public documents, for viewers in a country the token
geo-policy lists (dashboard/src/lib/compliance/token-geo-list.ts).

The app's routes and pages are gated by the geo-policy itself. The four token
documents (LITEPAPER.md, WHITEPAPER.md, TOKENOMICS.md and the litepaper page)
are not public files: the route handlers behind their addresses
(dashboard/src/lib/compliance/token-geo-documents.ts) serve the copies built
here to a listed country and the full document to everyone else. Nothing is
edited by hand: each copy is cut from the approved source, and assert_clean
refuses to build one that still mentions the token.
"""

import html
import re

TOKEN_WORDS = re.compile(r"\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b", re.IGNORECASE)
# One notice for every listed country, so it names none of them.
NOTICE = ("# Not available in your region\n\n"
          "Token features and token documents aren't available in your region.\n"
          "The rest of Hivra, including the litepaper and the white paper, is.\n")


def assert_clean(text, label, allow=()):
    hits = sorted({m[0] for m in TOKEN_WORDS.finditer(text) if m[0] not in allow})
    if hits:
        raise ValueError("{} still mentions the token: {}".format(label, ", ".join(hits)))


def litepaper_md(text):
    """LITEPAPER.md without the economy section and its one-page link."""
    start = text.index("\n## The economy\n")
    end = text.index("\n## Read further\n")
    text = text[:start] + text[end:]
    text = re.sub(r" · \*\*\[Tokenomics in one page\]\(TOKENOMICS\.md\)\*\*", "", text)
    assert_clean(text, "restricted LITEPAPER.md")
    return text


def _renumber_whitepaper(text):
    """Sections 7 and 8 are cut, so the ones after them move up: 9 becomes 7 and 10 becomes 8."""
    for old, new in (
        ("\n9. Build order\n", "\n7. Build order\n"),
        ("\n10. Evidence, limits and open decisions\n", "\n8. Evidence, limits and open decisions\n"),
        ("\n## 9. Build order\n", "\n## 7. Build order\n"),
        ("\n## 10. Evidence, limits and open decisions\n", "\n## 8. Evidence, limits and open decisions\n"),
        ("\n### 10.1 ", "\n### 8.1 "),
        ("\n### 10.2 ", "\n### 8.2 "),
        ("\n### 10.3 ", "\n### 8.3 "),
        ("come later (section 9)", "come later (section 7)"),
        ("is given in section 9 and Appendix A", "is given in section 7 and Appendix A"),
    ):
        if text.count(old) != 1:
            raise ValueError("White paper changed under the restricted copy: " + old.strip()[:60])
        text = text.replace(old, new)
    return text


def _assert_sections_consistent(text, label):
    """The headings count up from 1 and every 'section N' the text mentions is one of them."""
    headings = [int(n) for n in re.findall(r"^## (\d+)\. ", text, flags=re.MULTILINE)]
    if headings != list(range(1, len(headings) + 1)):
        raise ValueError("{} sections are not numbered 1 to {}: {}".format(label, len(headings), headings))
    contents = [int(n) for n in re.findall(r"^(\d+)\. ", text.split("\n---\n")[1], flags=re.MULTILINE)]
    if contents != headings:
        raise ValueError("{} contents list {} does not match its sections {}".format(label, contents, headings))
    known = {str(n) for n in headings} | set(re.findall(r"^### (\d+\.\d+) ", text, flags=re.MULTILINE))
    missing = sorted(set(re.findall(r"\b[Ss]ections? (\d+(?:\.\d+)?)", text)) - known)
    if missing:
        raise ValueError("{} points at a section that is not in it: {}".format(label, missing))


def whitepaper_md(text):
    """WHITEPAPER.md without the token sections, and without the lines that point at them."""
    start = text.index("\n## 7. The economic layer ($HIVRA)\n")
    end = text.index("\n## 9. Build order\n")
    text = text[:start] + text[end:]
    drop_lines = (
        "Token and migration sections are proposals.",
        "7. The economic layer ($HIVRA)",
        "8. The migration from $HermesOS to $HIVRA",
        "Founder allocation (none, or Bankr's standard vesting).",
        "| Token access to compute and token payment ($HermesOS)",
        "| $HIVRA access and payment",
        "| Migration route |",
    )
    text = "\n".join(line for line in text.split("\n") if not line.startswith(drop_lines))
    for old, new in (
        ("connected product or token action cannot", "or connected product cannot"),
        ("company key, token vote or government instruction", "company key or government instruction"),
        (" Token access to compute and token payment, with $HermesOS.", ""),
        (" $HIVRA access and payment, and the optional conversion from $HermesOS.", ""),
        (" Availability of any token feature depends on the participant's jurisdiction and applicable rules.", ""),
    ):
        if text.count(old) != 1:
            raise ValueError("White paper changed under the restricted copy: " + old[:60])
        text = text.replace(old, new)
    text = _renumber_whitepaper(text)
    assert_clean(text, "restricted WHITEPAPER.md")
    _assert_sections_consistent(text, "restricted WHITEPAPER.md")
    return text


def tokenomics_md():
    return NOTICE


def _cut_element(page, start):
    """Remove the element that begins at `start`, including everything nested in it."""
    tag = re.match(r"<([a-zA-Z0-9]+)", page[start:])[1]
    depth, position = 0, start
    for match in re.finditer(r"<(/?)" + tag + r"\b[^>]*>", page[start:]):
        depth += -1 if match[1] else 1
        if depth == 0:
            position = start + match.end()
            break
    return page[:start] + page[position:]


def litepaper_html(page):
    """The generated litepaper page without the economy chapter and every link into it."""
    start = page.index('<section class="economy chapter shell"')
    page = _cut_element(page, start)
    page = re.sub(r'<a class="hero-open hero-token"[^>]*>.*?</a>', "", page, flags=re.DOTALL)
    page = re.sub(r'\s*·\s*<strong><a [^>]*TOKENOMICS\.md[^>]*>.*?</a></strong>', "", page, flags=re.DOTALL)
    page = re.sub(r'\s*·\s*<a [^>]*TOKENOMICS\.md[^>]*>.*?</a>', "", page, flags=re.DOTALL)
    page = re.sub(r'<a [^>]*href="#economy"[^>]*>.*?</a>', "", page, flags=re.DOTALL)
    # The index numbers were counted with the economy chapter in them: close the gap.
    numbers = iter(range(1, 100))
    page = re.sub(r'(<span class="index-number">)\d+(</span>)', lambda m: "{}{:02d}{}".format(m[1], next(numbers), m[2]), page)
    # The whole page is read, not only its visible text: meta and Open Graph tags, JSON-LD, aria-label
    # and aria-description, alt and title text, data attributes, class and id names, inline scripts
    # and styles. The shared stylesheet and script files are separate files and are not part of this page.
    assert_clean(html.unescape(page), "restricted litepaper page")
    if 'id="economy"' in page or "#economy" in page:
        raise ValueError("restricted litepaper page still has the economy chapter or a link to it")
    return page
