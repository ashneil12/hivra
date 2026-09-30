"""Enhance navigation without rewriting approved reader copy."""

import html
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit


VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
NON_READER_TAGS = {"script", "style", "template", "noscript", "svg"}


def opens_new_tab(href):
    """Document downloads and other websites leave the experience open."""
    target = urlsplit(href.strip())
    if target.scheme.lower() in {"http", "https"} or target.netloc:
        return True
    return not target.scheme and target.path.lower().endswith(".md")


def _anchor_tag(raw, attrs):
    values = dict(attrs)
    href = values.get("href") or ""
    target = urlsplit(href.strip())
    same_page = not target.scheme and not target.netloc and not target.path and href.strip().startswith("#")
    if same_page:
        targets = [value for name, value in attrs if name == "target"]
        if not targets or (len(targets) == 1 and (not targets[0] or targets[0].lower() == "_self")):
            return raw
        attrs = [(name, value) for name, value in attrs if name != "target"]
        attrs.append(("target", "_self"))
    elif opens_new_tab(href):
        relations = []
        for name, value in attrs:
            if name == "rel":
                for relation in (value or "").split():
                    relation = relation.lower()
                    if relation != "opener" and relation not in relations:
                        relations.append(relation)
        if (values.get("target") == "_blank"
                and sum(name == "target" for name, value in attrs) == 1
                and sum(name == "rel" for name, value in attrs) == 1
                and {"noopener", "noreferrer"}.issubset(relations)
                and "opener" not in (values.get("rel") or "").lower().split()):
            return raw
        for relation in ("noopener", "noreferrer"):
            if relation not in relations:
                relations.append(relation)
        attrs = [(name, value) for name, value in attrs if name not in {"target", "rel"}]
        attrs.extend((("target", "_blank"), ("rel", " ".join(relations))))
    else:
        return raw
    attributes = "".join(
        " " + name if value is None else ' {}="{}"'.format(name, html.escape(value, quote=True))
        for name, value in attrs
    )
    return "<a" + attributes + ("/>" if raw.rstrip().endswith("/>") else ">")


class _LinkEnhancer(HTMLParser):
    def __init__(self, markup):
        super().__init__(convert_charrefs=False)
        self.markup = markup
        self.line_starts = [0] + [match.end() for match in re.finditer("\n", markup)]
        self.stack = []
        self.edits = []
        self.feed(markup)

    def _offset(self):
        line, column = self.getpos()
        return self.line_starts[line - 1] + column

    def handle_starttag(self, tag, attrs):
        raw = self.get_starttag_text()
        if tag == "a":
            replacement = _anchor_tag(raw, attrs)
            if replacement != raw:
                start = self._offset()
                self.edits.append((start, start + len(raw), replacement))
        if tag not in VOID_TAGS:
            self.stack.append((tag, dict(attrs)))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                return

    def result(self):
        # Edit only changed opening anchors. Every other byte, including
        # approved text, entities and whitespace, survives.
        result = self.markup
        for start, end, replacement in sorted(self.edits, reverse=True):
            result = result[:start] + replacement + result[end:]
        return result


def enhance_links(markup):
    """Set link targets for documents, other websites and same-page fragments.

    This is idempotent and changes markup only. Same-page fragments keep their
    navigation, and no existing anchor is wrapped in another anchor.
    """
    return _LinkEnhancer(markup).result()
