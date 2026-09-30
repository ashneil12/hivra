"""Token-free copies of the public documents, for viewers in a country the token
geo-policy lists (dashboard/src/lib/compliance/token-geo-list.ts).

The app's routes and pages are gated by the geo-policy itself. The static
documents are served straight from public/, so the site rewrites them by
country (dashboard/next.config.ts) to the copies built here. Nothing is edited
by hand: each copy is cut from the approved source, and assert_clean refuses to
build one that still mentions the token.
"""

import re

TOKEN_WORDS = re.compile(r"\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b", re.IGNORECASE)
NOTICE = ("# Not available in your region\n\n"
          "Token features and token documents aren't available to people in the United Kingdom.\n"
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
    assert_clean(text, "restricted WHITEPAPER.md")
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
    # The script and stylesheet are shared with the full page, so only the reader's text is checked.
    body = re.sub(r"<(script|style)\b.*?</\1>", "", page, flags=re.DOTALL)
    body = re.sub(r"<[^>]+>", " ", body)
    assert_clean(body, "restricted litepaper page")
    if 'id="economy"' in page or "#economy" in page:
        raise ValueError("restricted litepaper page still has the economy chapter or a link to it")
    return page
