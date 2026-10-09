#!/bin/sh
set -e
curl -LsSf https://astral.sh/uv/install.sh 2>/dev/null | env UV_UNMANAGED_INSTALL=/tmp/uvbin sh >/dev/null 2>&1
/tmp/uvbin/uv pip install -q --python /opt/hermes/.venv/bin/python pytest pytest-asyncio pytest-timeout pytest-xdist pytest-mock
cp -r /upstream-tests /opt/hermes/tests && cp -r /overlay-tests /opt/hermes/tests/hivra
cd /opt/hermes
export HERMES_HOME=/tmp/hh; mkdir -p "$HERMES_HOME"
exec /opt/hermes/.venv/bin/python -m pytest -o addopts="" -p no:cacheprovider -q --import-mode=importlib --timeout=120 "$@"
