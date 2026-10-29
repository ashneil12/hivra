"""SSRF guard for agent-supplied source URLs (venice text_parser, voice_clone, image_edit uploads).

The agent picks these URLs and the VM fetches them, so loopback, link-local/metadata and sibling
Hermes service names must be refused before any request leaves the VM. Network-free: DNS is
stubbed and requests.get is replaced, so these tests never touch a real host.
"""

import json

import pytest
import requests

import tools.image_edit_tool as ie
import tools.venice_extras_tool as extras_mod


BLOCKED_URLS = [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8789/session/start",
    "http://localhost/doc.pdf",
    "http://sub.localhost/doc.pdf",
    "http://[::1]/doc.pdf",
    "http://0.0.0.0/doc.pdf",
    "http://[::ffff:127.0.0.1]/doc.pdf",
    "http://[::ffff:169.254.169.254]/latest/",
    "http://warden:8080/",
    "http://browser-sidecar:8789/health",
    "http://metadata.google.internal/computeMetadata/v1/",
    "file:///etc/passwd",
    "ftp://example.com/file.pdf",
    "http:///no-host",
]


@pytest.mark.parametrize("url", BLOCKED_URLS)
def test_blocked_targets_are_refused_before_any_request(url, monkeypatch):
    def no_request(*a, **kw):
        raise AssertionError(f"requests.get must not run for {url}")

    monkeypatch.setattr(requests, "get", no_request)
    with pytest.raises(extras_mod.UnsafeURLError):
        extras_mod.assert_fetchable_url(url)


def test_name_resolving_to_loopback_is_refused(monkeypatch):
    monkeypatch.setattr(
        extras_mod.socket,
        "getaddrinfo",
        lambda host, port, **kw: [(2, 1, 6, "", ("127.0.0.1", port))],
    )
    with pytest.raises(extras_mod.UnsafeURLError):
        extras_mod.assert_fetchable_url("https://files.example.com/a.pdf")


def test_name_resolving_to_public_address_is_allowed(monkeypatch):
    monkeypatch.setattr(
        extras_mod.socket,
        "getaddrinfo",
        lambda host, port, **kw: [(2, 1, 6, "", ("93.184.216.34", port))],
    )
    extras_mod.assert_fetchable_url("https://files.example.com/a.pdf")


def test_rfc1918_lan_address_stays_allowed():
    # The browser sidecar allows LAN targets on purpose; keep the agent consistent with it.
    extras_mod.assert_fetchable_url("http://192.168.1.20/sample.mp3")


class _FakeResp:
    def __init__(self, status, headers=None, chunks=(b"",)):
        self.status_code = status
        self.headers = headers or {}
        self._chunks = list(chunks)
        self.closed = False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size=1):
        yield from self._chunks

    def close(self):
        self.closed = True


def test_redirect_into_metadata_is_refused(monkeypatch):
    calls = []

    def fake_get(url, **kw):
        calls.append(url)
        assert kw.get("allow_redirects") is False, "redirects must be followed by hand"
        return _FakeResp(302, {"location": "http://169.254.169.254/latest/meta-data/"})

    monkeypatch.setattr(extras_mod.socket, "getaddrinfo", lambda host, port, **kw: [(2, 1, 6, "", ("93.184.216.34", port))])
    monkeypatch.setattr(requests, "get", fake_get)
    with pytest.raises(extras_mod.UnsafeURLError):
        extras_mod.fetch_url_bytes("https://files.example.com/a.pdf")
    assert calls == ["https://files.example.com/a.pdf"]


def test_text_parser_does_not_fetch_metadata_url(monkeypatch):
    monkeypatch.setenv("VENICE_API_KEY", "k")
    fetched = []
    monkeypatch.setattr(requests, "get", lambda url, **kw: fetched.append(url))
    out = json.loads(extras_mod.text_parser_tool("http://169.254.169.254/latest/meta-data/"))
    assert out["success"] is False
    assert out["error_type"] == "api_error"
    assert fetched == []


def test_voice_clone_does_not_fetch_loopback_url(monkeypatch):
    monkeypatch.setenv("VENICE_API_KEY", "k")
    fetched = []
    monkeypatch.setattr(requests, "get", lambda url, **kw: fetched.append(url))
    out = json.loads(extras_mod.voice_clone_tool(action="create", sample_url="http://127.0.0.1:8789/x.mp3"))
    assert out["success"] is False
    assert fetched == []


def test_image_edit_source_fetch_refuses_metadata_url(monkeypatch):
    fetched = []
    monkeypatch.setattr(requests, "get", lambda url, **kw: fetched.append(url))
    with pytest.raises(ValueError):
        ie._open_image_for_upload("http://169.254.169.254/latest/meta-data/")
    assert fetched == []


def test_fetch_returns_body_and_content_type_for_public_url(monkeypatch):
    monkeypatch.setattr(extras_mod.socket, "getaddrinfo", lambda host, port, **kw: [(2, 1, 6, "", ("93.184.216.34", port))])
    monkeypatch.setattr(
        requests,
        "get",
        lambda url, **kw: _FakeResp(200, {"content-type": "image/png"}, chunks=[b"\x89PNG", b"data"]),
    )
    body, ctype = extras_mod.fetch_url_bytes("https://files.example.com/a.png")
    assert body == b"\x89PNGdata"
    assert ctype == "image/png"


def test_fetch_caps_response_size(monkeypatch):
    monkeypatch.setattr(extras_mod, "_MAX_FETCH_BYTES", 8)
    monkeypatch.setattr(extras_mod.socket, "getaddrinfo", lambda host, port, **kw: [(2, 1, 6, "", ("93.184.216.34", port))])
    monkeypatch.setattr(
        requests,
        "get",
        lambda url, **kw: _FakeResp(200, {}, chunks=[b"0123456789"]),
    )
    with pytest.raises(ValueError):
        extras_mod.fetch_url_bytes("https://files.example.com/big.bin")
