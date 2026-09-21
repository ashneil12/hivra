/**
 * Gateway auto-wake Phase 1: the per-box Caddy vhost's 502 fallback.
 *
 * When a scale-to-zero VM is parked, its vhost's reverse_proxy gets
 * connection-refused and Caddy emits a bare 502 — a dead end that bounces
 * users (and would sabotage any reactivation campaign pointing dormant users
 * at their box URL). This block turns that dead end into a wake path:
 *
 *   - Browser navigations (Accept: text/html…) are 302-redirected to the
 *     dashboard's /wake/<instanceId> page, which authenticates the owner,
 *     triggers the admission-guarded start, and returns them to the box.
 *   - Everything else (server-side probes, API clients, reconcilers) gets a
 *     503 + Retry-After. Deliberately NOT a redirect: fleet reconcilers and
 *     health probes are status-code-driven, and a 502→3xx rewrite would make
 *     a parked VM look "up".
 *
 * Emitted by BOTH vhost generators (initial provisioning in
 * proxmox-instance-service.ts and the cold-restore rebuild in
 * cold-storage-restore-routing.ts) so new and restored boxes agree. Existing
 * fleet vhosts are patched separately by scripts/rollout-wake-fallback.sh —
 * committed but not executed; rollout is a supervised step.
 *
 * NOTE for editors: this text is spliced into an UNQUOTED bash heredoc during
 * provisioning — never introduce backticks or unintended `${...}` sequences.
 * The `expression` matcher form (not `handle_errors 502 {}` status args) is
 * used on purpose: status arguments need newer Caddy than the expression
 * matcher, which works on every fleet Caddy version.
 */

export const WAKE_FALLBACK_MARKER = "hermes-auto-wake-fallback v1";

/** Canonical public dashboard origin used when a deployment-specific origin
 *  isn't configured. hivra.cloud IS live prod. */
export const DEFAULT_WAKE_ORIGIN = "https://hivra.cloud";

export function buildWakeRedirectUrl(dashboardOrigin: string | null | undefined, instanceId: string): string {
  const origin = (dashboardOrigin || DEFAULT_WAKE_ORIGIN).replace(/\/+$/, "");
  return `${origin}/wake/${instanceId}`;
}

/**
 * @param wakeUrl Either a literal URL (TS-side generators) or a bash variable
 *   reference like `${WAKE_REDIRECT_URL}` when spliced into the provisioning
 *   heredoc (bash expands it when writing the site file).
 */
export function buildWakeFallbackCaddyBlock(wakeUrl: string): string {
  return `  # ${WAKE_FALLBACK_MARKER}: parked-VM 502s become a wake path instead of a
  # dead end. Browser navigations are redirected to the dashboard wake page;
  # non-browser clients (probes, API callers, reconcilers) get 503 +
  # Retry-After so status-code-driven tooling still sees a failure, not a 3xx.
  handle_errors {
    @wake_upstream_down expression {http.error.status_code} in [502, 503, 504]
    handle @wake_upstream_down {
      @wake_browser header Accept text/html*
      handle @wake_browser {
        redir ${wakeUrl} 302
      }
      handle {
        header Retry-After "75"
        respond "Agent is parked. Wake it at ${wakeUrl}" 503
      }
    }
  }`;
}
