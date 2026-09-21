/**
 * ────────────────────────────────────────────────────────────────────────────
 *  THE REAL CHAT SURFACE — drive Hermes Desktop Web's remote-gateway socket
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `probeAgentReply` used to POST `/api/instances/[id]/send-stream`, a dashboard
 * proxy to hermes-webui's `POST /api/chat/start`. No agent image has served that
 * endpoint since the webui-free cutover; every box answered `405 Allow: GET`, so
 * the route was retired and the probe was stubbed `transport_retired`. There is
 * no HTTP chat surface on a box at all: the gateway `api_server` that owns
 * `POST /v1/responses` and `POST /api/sessions/{id}/chat/stream` binds :8642 on
 * the compose network only — the VM publishes just 80/443.
 *
 * The surface real users chat over is the agent's TUI-gateway JSON-RPC protocol.
 * Hermes Desktop Web reaches that gateway through Hivra's public `/desktop`
 * remote-gateway namespace, so the browser socket is `/desktop/api/ws`. Caddy
 * strips `/desktop` before forwarding it to the official dashboard service.
 *
 * ── HOW THE IFRAME AUTHENTICATES THE WS (verified live 2026-07-09, sloane box) ─
 * The dashboard mints a signed handoff whose redirect target is
 * `<box>/webchat#iframe_token=<apiServerKey>`. Caddy serves `/webchat` as a
 * STATIC shell (`file_server`, no server-injected session token — which is why
 * `window.__HERMES_SESSION_TOKEN__` is absent on these boxes). That shell's
 * `iframe-shim.js` reads the `#iframe_token` fragment (the per-instance
 * apiServerKey), strips it, and patches fetch/XHR/SSE/**WebSocket** to append
 * `?token=<apiServerKey>`. The box Caddy's `@authQueryToken query
 * token=<apiServerKey>` matcher then routes `/desktop/api/ws` through the
 * dashboard-sidecar (which swaps the SPA token for a gated session on hardened
 * images; Caddy also strips the browser `Origin` upstream). So the real WS
 * credential is `?token=<apiServerKey>` — NOT the gated `/api/auth/ws-ticket`.
 *
 * The FIRST proving run failed at `ws_ticket_http_401` precisely because this
 * probe minted a gated ws-ticket: on a webfree box `/api/auth/ws-ticket` is the
 * OAuth-cookie path (`gated_auth_middleware` wants `hermes_session_at`), which
 * these boxes do not use, so it 401s for the real SPA too. Verified live: a raw
 * socket uses that token.
 *
 * The probe therefore:
 *   1. `GET /api/instances/[id]/webui-login-url` → the signed handoff, and pulls
 *      the apiServerKey out of its `next=…#iframe_token=<key>` fragment.
 *   2. Navigates a page to the handoff → lands on the BOX ORIGIN.
 *   3. Opens `wss://<box>/desktop/api/ws?token=<apiServerKey>` (the Desktop Web
 *      adapter's exact route), waits for `gateway.ready`, then
 *      `session.create` → `prompt.submit`,
 *      and reads the streamed `message.delta` / terminal `message.complete`.
 *   (Fallback: a genuinely OAuth-gated box — `window.__HERMES_AUTH_REQUIRED__` —
 *    with no hash bearer mints a single-use `/api/auth/ws-ticket` instead, the
 *    SPA's `buildWsAuthParam` gated branch.)
 *
 * WHAT COUNTS AS AN ANSWER. `message.complete.payload.text` is the assistant's
 * final turn. The agent surfaces backend failures IN that text (`"Error: …"` when
 * a turn failed/partial with no visible response — e.g. an empty-wallet 402 on the
 * model call), or as a top-level `error` event. Both are recorded as a FAILURE
 * with the reason verbatim, never as a pass. Only a non-empty, non-error turn is
 * `ok:true`.
 *
 * The handoff entry can still differ (`/webchat` or `/`), but both shapes boot
 * Desktop Web and use the same `/desktop/api/ws` remote-gateway route. The
 * legacy root `/api/ws` alias is not the release gate: it can exist for mobile
 * and compatibility clients without proving that the actual workspace works.
 *
 * On any ws_error /
 * ws_closed the probe now also fetches, same-origin from the box page,
 * `/desktop/api/sessions` (Authorization: Bearer) and a plain
 * `GET /desktop/api/ws?token=` and
 * folds both statuses into the reason:
 *   sessions=401            → the bearer itself is rejected (apiServerKey
 *                             drift, or the handoff carried no/some other
 *                             token — see `auth=`).
 *   sessions=200 + ws 4xx   → auth fine; the upgrade path (sidecar ws bridge /
 *                             ticket mint / dashboard WS route) is what broke.
 *   sessions/ws 5xx or ERR  → sidecar up but a container behind it is down —
 *                             the known first-boot window where the workspace
 *                             already paints while chat is still dead.
 */
import type { APIRequestContext, BrowserContext } from '@playwright/test';

import type { AuditConfig } from './config';
import { sleep } from './instances';

/** Deterministic, cheap, single-token prompt. We assert a NON-EMPTY reply. */
export const AUDIT_CHAT_PROMPT = 'Reply with exactly one word: ping';

/** Public route used by the Hermes Desktop Web remote-gateway adapter. */
export const AUDIT_DESKTOP_WS_PATH = '/desktop/api/ws';

/** Matching HTTP endpoint used to attribute a failed Desktop Web handshake. */
export const AUDIT_DESKTOP_SESSIONS_PATH = '/desktop/api/sessions';

/** Result of a single in-page WS attempt (what `page.evaluate` returns). */
interface WsAttemptResult {
  ok: boolean;
  reason?: string;
  text?: string;
  chars?: number;
  /** Terminal WS state: message.complete | error | timeout | ws_closed | ws_error | auth_missing | ticket_failed | ws_ctor. */
  terminal: string;
  waited_ms: number;
  /** Which credential the socket carried: the iframe-shim's ?token= or a minted ws-ticket. */
  auth?: 'token' | 'ticket';
  /** HTTP-layer statuses gathered after a ws_error/ws_closed — names the failing layer. */
  postmortem?: string;
  /** Small breadcrumb trail of the handshake, for diagnosing a stall. */
  log: string[];
}

export interface AgentChatResult {
  attempted: boolean;
  ok: boolean;
  reason?: string;
  chars?: number;
  text?: string;
  terminal?: string;
  attempts?: number;
  waited_ms?: number;
  /** WS credential of the last attempt: token (iframe-shim lane) | ticket (gated fallback). */
  auth?: string;
  /** Handoff entry path — '/webchat' (canary static shell) vs '/' (prod SPA root). */
  entry?: string;
  /** Last attempt's handshake breadcrumbs, joined — only recorded on failure. */
  detail?: string;
}

/**
 * A failure we must NOT retry: a billing/config wall is deterministic within a
 * run, so re-sending only burns the budget and (worse) could mask the very
 * signal this outcome exists to catch. A transient "runtime still warming up"
 * (agent build, gateway 5xx, socket closed on cold boot) IS retryable.
 */
function isTerminalReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /402|insufficient|credit|payment|unconfigured|no provider|invalid model|no_handoff|auth_missing/i.test(
    reason,
  );
}

/**
 * Mint a fresh signed handoff and pull the apiServerKey out of it.
 *
 * The handoff's `next` fragment carries `#iframe_token=<apiServerKey>` — the
 * exact bearer the box's iframe-shim uses for the WS `?token=`. Extracting it
 * here is how the probe authenticates the socket the way the iframe does.
 */
async function mintHandoff(
  request: APIRequestContext,
  baseUrl: string,
  instanceId: string,
): Promise<
  { url: string; apiServerKey: string | null; entry: string } | { url: null; status: number }
> {
  const res = await request.get(`${baseUrl}/api/instances/${instanceId}/webui-login-url`, {
    timeout: 60_000,
  });
  if (res.status() !== 200) return { url: null, status: res.status() };
  const body = (await res.json().catch(() => null)) as { url?: string } | null;
  if (!body?.url) return { url: null, status: res.status() };

  // The redirect target path identifies the handoff shape: '/webchat' is the
  // canary static shell, '/' is the prod-shape SPA-root landing. Recorded in
  // the verdict so a run names the topology it actually drove.
  let apiServerKey: string | null = null;
  let entry = '?';
  try {
    const next = decodeURIComponent(new URL(body.url).searchParams.get('next') ?? '');
    entry = next.split('#')[0].split('?')[0] || '?';
    const m = next.match(/iframe_token=([^&]+)/);
    if (m) apiServerKey = decodeURIComponent(m[1]);
  } catch {
    apiServerKey = null;
  }
  return { url: body.url, apiServerKey, entry };
}

/**
 * Drive the real chat surface and assert the agent answers.
 *
 * Runs entirely against the PRODUCT: the dashboard mints the handoff, the box
 * serves the workspace, and the box's agent produces the reply. Nothing here
 * reaches around a product surface.
 */
export async function probeAgentChatOverWs(
  context: BrowserContext,
  cfg: AuditConfig,
  instanceId: string,
): Promise<AgentChatResult> {
  const startedMs = Date.now();
  const budgetMs = cfg.agentReplyTimeoutMs;

  const handoff = await mintHandoff(context.request, cfg.baseUrl, instanceId);
  if (!handoff.url) {
    return {
      attempted: false,
      ok: false,
      reason: `no_handoff_url (webui-login-url HTTP ${'status' in handoff ? handoff.status : '?'})`,
      terminal: 'handoff_failed',
      attempts: 0,
      waited_ms: Date.now() - startedMs,
    };
  }

  const boxOrigin = new URL(handoff.url).origin;
  const page = await context.newPage();
  try {
    // Land on the box origin. A 302 from the sidecar lands us on the SPA shell;
    // `domcontentloaded` is enough — we need the box origin, not a booted SPA.
    try {
      await page.goto(handoff.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch {
      // A client-side redirect can abort the top-level navigation; fine as long
      // as we ended up on the box origin (checked next).
    }

    if (new URL(page.url()).origin !== boxOrigin) {
      return {
        attempted: false,
        ok: false,
        reason: `handoff_landed_off_box origin=${new URL(page.url()).origin} expected=${boxOrigin}`,
        terminal: 'handoff_failed',
        attempts: 0,
        waited_ms: Date.now() - startedMs,
      };
    }

    let attempts = 0;
    let last: WsAttemptResult | null = null;

    // Retry across the budget: cold boots make the first turn fail with a
    // retryable reason (agent build racing the first prompt, a socket that
    // closes before ready). A billing/config wall is terminal and breaks the
    // loop immediately with its reason intact.
    while (Date.now() - startedMs < budgetMs) {
      attempts += 1;
      const remaining = budgetMs - (Date.now() - startedMs);
      const attemptTimeoutMs = Math.max(20_000, Math.min(120_000, remaining));

      last = (await page.evaluate(runWsAttempt, {
        prompt: AUDIT_CHAT_PROMPT,
        timeoutMs: attemptTimeoutMs,
        token: handoff.apiServerKey,
        wsPath: AUDIT_DESKTOP_WS_PATH,
        sessionsPath: AUDIT_DESKTOP_SESSIONS_PATH,
      })) as WsAttemptResult;

      if (last.ok) {
        return {
          attempted: true,
          ok: true,
          text: last.text,
          chars: last.chars,
          terminal: last.terminal,
          attempts,
          waited_ms: Date.now() - startedMs,
          auth: last.auth,
          entry: handoff.entry,
        };
      }
      if (isTerminalReason(last.reason)) break;
      if (Date.now() - startedMs >= budgetMs) break;
      await sleep(12_000);
    }

    // Compose an ATTRIBUTED failure reason. fixturecase05 taught us a bare
    // `ws_error` is unactionable — name the credential, the entry shape, the
    // HTTP post-mortem, and whether the handoff even carried a bearer.
    const parts = [
      `auth=${last?.auth ?? (handoff.apiServerKey ? 'token_unused' : 'no_iframe_token_in_handoff')}`,
      `entry=${handoff.entry}`,
    ];
    if (last?.postmortem) parts.push(last.postmortem);
    const crumbs = last?.log?.slice(-6).join('>') ?? '';
    if (crumbs) parts.push(`log=${crumbs}`);

    return {
      attempted: true,
      ok: false,
      reason: `${last?.reason ?? 'no_reply'} [${parts.join(' ')}]`.slice(0, 400),
      text: last?.text,
      terminal: last?.terminal ?? 'none',
      attempts,
      waited_ms: Date.now() - startedMs,
      auth: last?.auth,
      entry: handoff.entry,
      detail: crumbs || undefined,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * The in-page WebSocket handshake. Serialised into the box page by
 * `page.evaluate` — it must be a self-contained function (no closure over module
 * scope) and return only JSON-serialisable values.
 *
 * Auth mirrors the Desktop Web adapter: prefer `?token=<apiServerKey>`. Only a
 * genuinely OAuth-gated box
 * (`window.__HERMES_AUTH_REQUIRED__ === true`) with no hash bearer falls back to
 * minting a single-use `/api/auth/ws-ticket` — the SPA's `buildWsAuthParam`
 * gated branch.
 *
 * Wire protocol (newline-delimited JSON-RPC of `tui_gateway`):
 *   server → `{method:"event", params:{type, session_id?, payload?}}` for events,
 *            `{id, result|error}` for request replies.
 *   client → `{jsonrpc:"2.0", id, method, params}` requests.
 */
function runWsAttempt(args: {
  prompt: string;
  timeoutMs: number;
  token: string | null;
  wsPath: string;
  sessionsPath: string;
}): Promise<WsAttemptResult> {
  const { prompt, timeoutMs, token, wsPath, sessionsPath } = args;
  const t0 = Date.now();
  const log: string[] = [];

  return new Promise<WsAttemptResult>((resolve) => {
    // HTTP-layer post-mortem for a failed socket. The WebSocket API hides the
    // upgrade's HTTP status, so a refused handshake is indistinguishable from a
    // dead container — unless we ask over plain HTTP from the same origin.
    // `/desktop/api/sessions` (Bearer) answers 200 iff the bearer is valid AND
    // the sidecar + dashboard containers are up; a bare GET on the matching
    // Desktop WebSocket path shows what the upgrade route returns to HTTP.
    const postmortem = async (): Promise<string | undefined> => {
      if (!token) return undefined;
      const grab = async (input: string, init?: RequestInit): Promise<string> => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5_000);
        try {
          const r = await fetch(input, { ...init, signal: ctl.signal });
          return String(r.status);
        } catch {
          return 'ERR';
        } finally {
          clearTimeout(t);
        }
      };
      const sessions = await grab(sessionsPath, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const wsGet = await grab(`${wsPath}?token=${encodeURIComponent(token)}`);
      return `sessions=${sessions} ws_get=${wsGet}`;
    };

    const finish = (r: Omit<WsAttemptResult, 'waited_ms' | 'log'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
      const done = (pm?: string): void =>
        resolve({ ...r, auth: r.auth ?? authKind ?? undefined, postmortem: pm, waited_ms: Date.now() - t0, log });
      if (!r.ok && (r.terminal === 'ws_error' || r.terminal === 'ws_closed')) {
        void postmortem().then(done, () => done());
        return;
      }
      done();
    };

    let settled = false;
    let sid: string | null = null;
    let deltas = '';
    let sawReady = false;
    let ws: WebSocket | undefined;
    let authKind: 'token' | 'ticket' | null = null;
    const CREATE_ID = 'audit-create';
    const PROMPT_ID = 'audit-prompt';

    const timer = setTimeout(
      () => finish({ ok: false, reason: 'reply_timeout', terminal: 'timeout' }),
      timeoutMs,
    );

    const send = (obj: unknown): void => ws?.send(JSON.stringify(obj));

    void (async () => {
      const gated =
        (window as { __HERMES_AUTH_REQUIRED__?: boolean }).__HERMES_AUTH_REQUIRED__ === true;

      // Resolve the WS auth query param. Primary: the iframe-shim's
      // ?token=<apiServerKey>. Fallback (gated OAuth box, no hash bearer): mint a
      // single-use ws-ticket via the authenticated REST endpoint.
      let authParam: [string, string] | null = null;
      if (token) {
        authParam = ['token', token];
        authKind = 'token';
        log.push('auth=token');
      } else if (gated) {
        try {
          const r = await fetch('/api/auth/ws-ticket', { method: 'POST', credentials: 'include' });
          log.push('ws_ticket_status=' + r.status);
          if (!r.ok) return finish({ ok: false, reason: `ws_ticket_http_${r.status}`, terminal: 'ticket_failed' });
          const j = (await r.json()) as { ticket?: string };
          if (!j.ticket) return finish({ ok: false, reason: 'ws_ticket_empty', terminal: 'ticket_failed' });
          authParam = ['ticket', j.ticket];
          authKind = 'ticket';
          log.push('auth=ticket');
        } catch (e) {
          return finish({ ok: false, reason: `ws_ticket_error:${String(e)}`.slice(0, 200), terminal: 'ticket_failed' });
        }
      }

      if (!authParam) {
        return finish({
          ok: false,
          reason: 'auth_missing (no apiServerKey in handoff and box is not OAuth-gated)',
          terminal: 'auth_missing',
        });
      }

      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${scheme}//${location.host}${wsPath}?${authParam[0]}=${encodeURIComponent(authParam[1])}`;
      log.push(`ws_path=${wsPath}`);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return finish({ ok: false, reason: `ws_ctor:${String(e)}`.slice(0, 200), terminal: 'ws_ctor' });
      }

      ws.onopen = () => log.push('ws_open');
      ws.onerror = () => finish({ ok: false, reason: 'ws_error', terminal: 'ws_error' });
      ws.onclose = (ev) =>
        finish({ ok: false, reason: `ws_closed_code_${(ev as CloseEvent).code}`, terminal: 'ws_closed' });

      ws.onmessage = (ev) => {
        let frame: {
          id?: unknown;
          method?: string;
          result?: { session_id?: string };
          error?: { message?: string };
          params?: { type?: string; session_id?: string; payload?: Record<string, unknown> };
        };
        try {
          frame = JSON.parse(String((ev as MessageEvent).data));
        } catch {
          return;
        }

        // Request replies (session.create / prompt.submit) carry our id.
        if (frame.id === CREATE_ID) {
          if (frame.error) {
            return finish({
              ok: false,
              reason: `session_create_error:${frame.error.message ?? ''}`.slice(0, 200),
              terminal: 'error',
            });
          }
          sid = frame.result?.session_id ?? null;
          if (!sid) return finish({ ok: false, reason: 'no_session_id', terminal: 'error' });
          log.push('session_created');
          send({ jsonrpc: '2.0', id: PROMPT_ID, method: 'prompt.submit', params: { session_id: sid, text: prompt } });
          return;
        }
        if (frame.id === PROMPT_ID && frame.error) {
          return finish({
            ok: false,
            reason: `prompt_submit_error:${frame.error.message ?? ''}`.slice(0, 200),
            terminal: 'error',
          });
        }

        // Events.
        if (frame.method !== 'event' || !frame.params || typeof frame.params.type !== 'string') return;
        const type = frame.params.type;
        const payload = (frame.params.payload ?? {}) as Record<string, unknown>;

        if (type === 'gateway.ready') {
          if (sawReady) return;
          sawReady = true;
          log.push('gateway_ready');
          send({ jsonrpc: '2.0', id: CREATE_ID, method: 'session.create', params: { source: 'first-run-audit' } });
          return;
        }
        if (type === 'message.delta' && typeof payload.text === 'string') {
          deltas += payload.text;
          return;
        }
        if (type === 'error') {
          const msg = String(payload.message ?? payload.text ?? 'agent error');
          return finish({ ok: false, reason: `agent_error:${msg}`.slice(0, 240), terminal: 'error' });
        }
        if (type === 'message.complete') {
          const raw = typeof payload.text === 'string' ? payload.text : deltas;
          const text = (raw || '').trim();
          const failed = payload.status === 'failed' || /^Error:/.test(text);
          if (!text) return finish({ ok: false, reason: 'empty_reply', terminal: 'message.complete', text: '' });
          if (failed) {
            return finish({
              ok: false,
              reason: `agent_reply_error:${text}`.slice(0, 240),
              terminal: 'message.complete',
              text: text.slice(0, 500),
            });
          }
          return finish({ ok: true, terminal: 'message.complete', text: text.slice(0, 500), chars: text.length });
        }
      };
    })();
  });
}
