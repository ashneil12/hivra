"""Tests for the Venice video generation plugin."""

from __future__ import annotations

import pytest


class _FakeResponse:
    def __init__(self, data, status_code=200):
        self._data = data
        self.status_code = status_code
        self.text = str(data)

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if not self.responses:
            raise AssertionError("unexpected POST call")
        return self.responses.pop(0)

    async def get(self, url, **kwargs):  # pragma: no cover - should never be used
        self.calls.append(("GET", url, kwargs))
        raise AssertionError("Venice video polling must not use GET /video/{queue_id}")


@pytest.mark.asyncio
async def test_poll_job_uses_video_retrieve_post_endpoint():
    from plugins.video_gen.venice import _poll_job

    client = _FakeClient([
        _FakeResponse({"status": "completed", "download_url": "https://example.com/out.mp4"})
    ])

    result = await _poll_job(  # type: ignore[arg-type]
        client,
        "queue-123",
        api_key="test-key",
        base_url="https://api.venice.ai/api/v1",
        timeout_seconds=10,
        poll_interval=1,
    )

    assert result["status"] == "done"
    assert client.calls[0][0] == "POST"
    assert client.calls[0][1] == "https://api.venice.ai/api/v1/video/retrieve"
    assert client.calls[0][2]["json"] == {"queue_id": "queue-123"}
