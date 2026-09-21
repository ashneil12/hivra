import { log } from "@/lib/logger";

const LOG_SOURCE = "abuse-fingerprint";
const FINGERPRINT_API_BASE = "https://api.fpjs.io";
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * Device-level signals from FingerprintJS Pro, verified server-side.
 *
 * The frontend SDK gives us a `requestId` per identification event. We
 * fetch the canonical record from FPJS's Server API using our secret key
 * — never trust visitor IDs sent directly from the client without this
 * server-side verification (they'd be trivially spoofable otherwise).
 */
export interface FingerprintSignals {
  visitorId: string;
  requestId: string;
  /** FPJS's confidence score for the visitor identification (0.0-1.0). */
  confidence: number | null;
  /** True if FPJS flagged this event as coming from incognito mode. */
  incognito: boolean;
  /** True if FPJS flagged the browser as bot-driven. */
  bot: boolean;
  /** True if FPJS flagged a VPN at identification time. */
  vpn: boolean;
  /** True if the IP changed since the last identification (account-sharing signal). */
  ipChanged: boolean;
  /** Raw FPJS event payload for persistence in raw_signals. */
  raw: Record<string, unknown>;
}

/**
 * Verify a FingerprintJS request id server-side and extract the signals
 * we care about for risk scoring.
 *
 * Returns `null` (rather than throwing) for graceful degradation:
 *   - missing FINGERPRINT_SECRET_KEY (treat as neutral)
 *   - missing/empty requestId (frontend script blocked, treat as neutral)
 *   - network errors / timeouts
 *   - upstream API errors (bad request id, etc)
 *
 * Note: The FPJS Server API uses the requestId (per-event) rather than the
 * visitorId (cross-event). We pull the visitorId out of the event response
 * for downstream collision detection.
 */
export async function verifyRequest(
  requestId: string | null | undefined
): Promise<FingerprintSignals | null> {
  if (!requestId || typeof requestId !== "string") return null;

  const apiKey = process.env.FINGERPRINT_SECRET_KEY;
  if (!apiKey) {
    log.warn("FINGERPRINT_SECRET_KEY not set — skipping device fingerprint", {
      source: LOG_SOURCE,
      failureType: "fingerprint_secret_missing",
    });
    return null;
  }

  // FPJS Pro Server API: GET /events/{requestId}
  const url = `${FINGERPRINT_API_BASE}/events/${encodeURIComponent(requestId)}`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Auth-API-Key": apiKey,
          Accept: "application/json",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.warn("fingerprint request failed", {
      source: LOG_SOURCE,
      failureType: "fingerprint_request_failed",
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }

  if (!response.ok) {
    log.warn("fingerprint returned non-2xx", {
      source: LOG_SOURCE,
      failureType: "fingerprint_http_error",
      status: response.status,
    });
    return null;
  }

  let body: FingerprintEventResponse;
  try {
    body = (await response.json()) as FingerprintEventResponse;
  } catch (err) {
    log.warn("fingerprint returned invalid JSON", {
      source: LOG_SOURCE,
      failureType: "fingerprint_invalid_json",
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }

  // FPJS event response shape: { products: { identification: { data: {...} }, ... } }
  const identification = body?.products?.identification?.data;
  if (!identification || !identification.visitorId) {
    log.warn("fingerprint event missing identification data", {
      source: LOG_SOURCE,
      failureType: "fingerprint_no_identification",
    });
    return null;
  }

  const incognitoData = body?.products?.incognito?.data;
  const botData = body?.products?.botd?.data;
  const vpnData = body?.products?.vpn?.data;
  const ipInfoData = body?.products?.ipInfo?.data;

  return {
    visitorId: identification.visitorId,
    requestId,
    confidence:
      typeof identification.confidence?.score === "number"
        ? identification.confidence.score
        : null,
    incognito: Boolean(incognitoData?.result),
    bot: botData?.bot?.result === "bad",
    vpn: Boolean(vpnData?.result),
    // ipInfo.v4.address vs visitor's previous IP — populated when FPJS detects change
    ipChanged: Boolean(ipInfoData && ipInfoData.v4?.geolocation?.changedFromPrevious),
    raw: body as unknown as Record<string, unknown>,
  };
}

// ── FPJS event response shape (subset we care about) ─────────────────────────

interface FingerprintEventResponse {
  products?: {
    identification?: {
      data?: {
        visitorId?: string;
        confidence?: { score?: number };
      };
    };
    incognito?: { data?: { result?: boolean } };
    botd?: { data?: { bot?: { result?: string } } };
    vpn?: { data?: { result?: boolean } };
    ipInfo?: {
      data?: {
        v4?: {
          address?: string;
          geolocation?: { changedFromPrevious?: boolean };
        };
      };
    };
  };
}
