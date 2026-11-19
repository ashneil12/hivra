// Sends a Google Analytics 4 event from the server (Measurement Protocol).
//
// Used when Google Analytics stays off signed-in pages
// (NEXT_PUBLIC_HIVRA_GA_PUBLIC_PAGES_ONLY): the sign-up conversion happens on a
// signed-in page, so the browser no longer sends it. The server sends it with
// the visitor's GA client id and session id, read from the `_ga` cookies GA set
// on the public pages, so GA attributes the sign-up to the session and landing
// page that brought the visitor in.
//
// Never pass personal data (email, name, user id) in params.

const MP_ENDPOINT = "https://www.google-analytics.com/mp/collect";
const SEND_TIMEOUT_MS = 3_000;

/** `_ga` = "GA1.1.<random>.<first-visit seconds>"; the client id is the last two parts. */
export function gaClientIdFromCookie(value: string | null | undefined): string | null {
  const match = /^GA\d\.\d+\.(\d{1,20}\.\d{1,20})$/.exec(value?.trim() ?? "");
  return match ? match[1] : null;
}

/** The session cookie GA4 sets for one measurement id: `_ga_<id without "G-">`. */
export function gaSessionCookieName(measurementId: string): string {
  return `_ga_${measurementId.replace(/^G-/, "")}`;
}

/**
 * The current session id from the `_ga_<id>` cookie, in either format GA4 has
 * used: "GS1.1.<session id>.<count>...." or "GS2.1.s<session id>$o<count>$...".
 */
export function gaSessionIdFromCookie(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  const gs1 = /^GS1\.\d+\.(\d{1,20})\./.exec(raw);
  if (gs1) return gs1[1];
  const gs2 = /^GS2\.\d+\.s(\d{1,20})(?:\$|$)/.exec(raw);
  return gs2 ? gs2[1] : null;
}

export type GaEventParams = Record<string, string | number>;

export type MeasurementProtocolResult = { ok: true } | { ok: false; status?: number; error?: string };

export async function sendGaMeasurementProtocolEvent(input: {
  measurementId: string;
  apiSecret: string;
  clientId: string;
  sessionId?: string | null;
  name: string;
  params?: GaEventParams;
  fetchImpl?: typeof fetch;
}): Promise<MeasurementProtocolResult> {
  const url = new URL(MP_ENDPOINT);
  url.searchParams.set("measurement_id", input.measurementId);
  url.searchParams.set("api_secret", input.apiSecret);

  const params: GaEventParams = {
    ...(input.params ?? {}),
    // Ties the event to the visitor's session, so it carries that session's
    // source and landing page. Engagement time makes GA count the session.
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    engagement_time_msec: 1,
  };
  const body = JSON.stringify({
    client_id: input.clientId,
    non_personalized_ads: true,
    events: [{ name: input.name, params }],
  });

  const doFetch = input.fetchImpl ?? fetch;
  try {
    const response = await doFetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // The collect endpoint answers 2xx for anything it accepts and does not
    // validate events; a non-2xx means the request itself was refused.
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
