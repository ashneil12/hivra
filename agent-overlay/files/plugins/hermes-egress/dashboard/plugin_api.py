"""HermesOS synthetic outbound-network health probe (fleet egress sweep).

Ported from the hermes-webui fork's ``api/health_egress.py`` as an additive
agent dashboard plugin (no edits to upstream ``web_server.py``). Mounted at
``/api/plugins/hermes-egress/`` by the dashboard plugin loader.

Background: the Hermesdeploy dashboard runs a cron (``probe-instance-egress``)
that hits every running agent and uses per-target results to detect VMs that
can't reach upstream model APIs even when the gateway looks healthy. Designed
around the 2026-05-02 incident where every Proxmox VM lost UDP/53 to Cloudflare,
all chat sends started timing out with ``gaierror``, and the regular health
check stayed green because the HTTPS port was answering fine.

Wire contract (matches the webui original so the sweep consumer is unchanged):

    GET /api/plugins/hermes-egress/check?targets=api.openai.com,api.anthropic.com
    -> 200, {"targets": [
        {"target": "api.openai.com", "ok": true, "durationMs": 42},
        {"target": "api.anthropic.com", "ok": false,
         "errorClass": "gaierror", "errorDetail": "...", "durationMs": 2503}
      ]}

Security: the allowlist is hardcoded so the endpoint can't be turned into an
arbitrary port-reachability oracle. Unknown hostnames in ?targets= are ignored;
an empty/garbage query falls back to probing the full default list.

NOTE (migration): the webui route lived at the public ``/api/health/egress``.
This plugin route is ``/api/plugins/hermes-egress/check`` and rides the normal
dashboard auth. The Hermesdeploy egress-sweep cron
(``dashboard/src/lib/instance-egress-sweep.ts``) must be repointed to this path
and send the per-instance token. See .hermesos/customizations.yaml (health-egress).
"""

from __future__ import annotations

import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import APIRouter, Query

router = APIRouter()

# Probe-able hostnames. Kept narrow on purpose - every agent VM does a DNS +
# TCP probe to every entry per cron tick, and an over-broad list turns this
# into a noisy reachability oracle. Add a host only for a concrete ops reason.
_DEFAULT_TARGETS: tuple[str, ...] = (
    "api.openai.com",
    "api.anthropic.com",
)
_ALLOWED_TARGETS: frozenset[str] = frozenset(_DEFAULT_TARGETS)

_PROBE_PORT: int = 443
_PER_TARGET_TIMEOUT_S: float = 2.5
# The dashboard sweep aborts the whole HTTP request at 8s; parallel probing
# keeps wall-clock at ~_PER_TARGET_TIMEOUT_S even with several targets.
_MAX_PARALLEL_PROBES: int = 4
# Hard ceiling on the whole endpoint even if a probe's getaddrinfo hangs - the
# DNS-outage case this probe exists to detect (getaddrinfo takes no timeout
# arg). Kept under the dashboard sweep's 8s request abort.
_OVERALL_TIMEOUT_S: float = 6.0


def _probe_one_target(target: str) -> dict:
    """DNS-resolve ``target`` and open a TCP connection to port 443.

    Returns the EgressTargetResult shape consumed by the dashboard. Never
    raises - failures are reported in-band via ``ok=False`` so the sweep sees a
    per-target verdict rather than a 500.
    """
    started = time.monotonic()
    sock = None
    try:
        # getaddrinfo first so a DNS failure is classified distinctly from a
        # TCP failure - the 2026-05-02 incident was DNS-only.
        infos = socket.getaddrinfo(target, _PROBE_PORT, proto=socket.IPPROTO_TCP)
        family, socktype, proto, _canon, sockaddr = infos[0]
        sock = socket.socket(family, socktype, proto)
        sock.settimeout(_PER_TARGET_TIMEOUT_S)
        sock.connect(sockaddr)
        duration_ms = int((time.monotonic() - started) * 1000)
        return {"target": target, "ok": True, "durationMs": duration_ms}
    except Exception as exc:  # noqa: BLE001 - verdict is reported in-band
        duration_ms = int((time.monotonic() - started) * 1000)
        return {
            "target": target,
            "ok": False,
            "errorClass": type(exc).__name__,
            "errorDetail": str(exc)[:200],
            "durationMs": duration_ms,
        }
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def _resolve_targets(raw: str) -> list[str]:
    requested = [t.strip() for t in (raw or "").split(",") if t.strip()]
    allowed = [t for t in requested if t in _ALLOWED_TARGETS]
    # Empty/garbage query → probe the full default list so the sweep still gets
    # a useful signal rather than an empty result.
    return allowed or list(_DEFAULT_TARGETS)


@router.get("/check")
def egress_check(targets: str = Query(default="")) -> dict:
    """Probe outbound reachability to the allowed model-API hosts.

    Always returns within ~``_OVERALL_TIMEOUT_S`` even if a probe's DNS
    resolution hangs: any target that hasn't finished by the deadline is
    reported as a ``timeout`` failure rather than blocking the endpoint (which
    would defeat the whole point during a DNS outage).
    """
    to_probe = _resolve_targets(targets)
    results: list[dict] = []
    pool = ThreadPoolExecutor(max_workers=_MAX_PARALLEL_PROBES)
    futures = {pool.submit(_probe_one_target, t): t for t in to_probe}
    try:
        for fut in as_completed(futures, timeout=_OVERALL_TIMEOUT_S):
            results.append(fut.result())
    except TimeoutError:
        done = {r["target"] for r in results}
        for _fut, target in futures.items():
            if target not in done:
                results.append({
                    "target": target,
                    "ok": False,
                    "errorClass": "timeout",
                    "errorDetail": f"probe exceeded {_OVERALL_TIMEOUT_S}s",
                    "durationMs": int(_OVERALL_TIMEOUT_S * 1000),
                })
    finally:
        # Don't wait on a wedged getaddrinfo thread; let it leak and reap itself
        # when the resolver finally errors out.
        pool.shutdown(wait=False, cancel_futures=True)
    # Stable order = request order, so the consumer can rely on it.
    order = {t: i for i, t in enumerate(to_probe)}
    results.sort(key=lambda r: order.get(r["target"], 1_000))
    return {"targets": results}
