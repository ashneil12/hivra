"""Managed-proxy upload sizing for image edit/upscale/compose/background-remove.

The HermesOS managed-Venice proxy runs on Vercel, which rejects request bodies
over ~4.5 MB at the platform layer (HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE) before
the route handler runs. Image *generate* is a tiny JSON prompt and is fine, but
the edit-family tools upload a full source image. These tests cover the
client-side guard that downscales oversized images before a managed upload and
the friendly error mapping when an upload is still rejected.
"""

import io

import pytest

import tools.image_edit_tool as ie

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402


def _big_png(width=2400, height=2400):
    """A PNG comfortably over the 4 MB managed budget (random noise = poor compression)."""
    import os

    img = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()
    assert len(data) > ie.MANAGED_UPLOAD_LIMIT_BYTES, "fixture should exceed the budget"
    return data


def _alpha_png(width=2000, height=2000):
    import os

    img = Image.frombytes("RGBA", (width, height), os.urandom(width * height * 4))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestManagedDetection:
    def test_direct_venice_is_not_managed(self):
        assert ie._is_managed_proxy("https://api.venice.ai/api/v1") is False

    def test_dashboard_proxy_is_managed(self):
        assert ie._is_managed_proxy("https://hermesos.cloud/api/managed-venice/v1") is True

    def test_empty_base_url_treated_as_managed(self):
        # Defensive: an unexpected/empty base shrinks rather than 413s.
        assert ie._is_managed_proxy("") is True


class TestShrink:
    def test_small_image_untouched(self):
        small = b"\x89PNG\r\n\x1a\n" + b"0" * 1000
        assert ie._shrink_image_bytes(small, ie.MANAGED_UPLOAD_LIMIT_BYTES) is small

    def test_large_photo_shrunk_under_budget(self):
        big = _big_png()
        out = ie._shrink_image_bytes(big, ie.MANAGED_UPLOAD_LIMIT_BYTES)
        assert len(out) <= ie.MANAGED_UPLOAD_LIMIT_BYTES
        assert len(out) < len(big)
        # Re-encoded as JPEG for an opaque photo.
        assert out[:3] == b"\xff\xd8\xff"
        assert Image.open(io.BytesIO(out)).size[0] > 0  # still a valid image

    def test_transparent_image_stays_png(self):
        big = _alpha_png()
        if len(big) <= ie.MANAGED_UPLOAD_LIMIT_BYTES:
            pytest.skip("alpha fixture under budget on this Pillow build")
        out = ie._shrink_image_bytes(big, ie.MANAGED_UPLOAD_LIMIT_BYTES)
        assert out[:8] == b"\x89PNG\r\n\x1a\n"
        assert len(out) <= ie.MANAGED_UPLOAD_LIMIT_BYTES


class TestPrepareUploadBytes:
    def test_direct_mode_is_noop_even_when_large(self):
        big = _big_png()
        out, name = ie._prepare_upload_bytes(big, "photo.png", "https://api.venice.ai/api/v1")
        assert out is big
        assert name == "photo.png"

    def test_managed_mode_shrinks_and_fixes_extension(self):
        big = _big_png()
        out, name = ie._prepare_upload_bytes(
            big, "photo.png", "https://hermesos.cloud/api/managed-venice/v1"
        )
        assert len(out) <= ie.MANAGED_UPLOAD_LIMIT_BYTES
        assert name == "photo.jpg"  # JPEG re-encode → matching extension

    def test_managed_mode_small_image_untouched(self):
        small = b"\x89PNG\r\n\x1a\n" + b"0" * 500
        out, name = ie._prepare_upload_bytes(
            small, "x.png", "https://hermesos.cloud/api/managed-venice/v1"
        )
        assert out is small
        assert name == "x.png"


class TestPayloadTooLargeDetection:
    class _Resp:
        def __init__(self, status, text=""):
            self.status_code = status
            self.text = text

    def test_413_status(self):
        assert ie._is_payload_too_large(self._Resp(413)) is True

    def test_vercel_text_marker(self):
        assert ie._is_payload_too_large(
            self._Resp(500, "Request Entity Too Large\nFUNCTION_PAYLOAD_TOO_LARGE")
        ) is True

    def test_normal_error_is_not_flagged(self):
        assert ie._is_payload_too_large(self._Resp(400, '{"error":"bad prompt"}')) is False
