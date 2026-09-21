# Vex SOUL snippet — browser_sidecar tool

This is a sample addition to Vex's SOUL that documents the contract between Vex and the browser sidecar. It is **not** the registration mechanism — registration happens in the gateway's `/api/tools` response, conditional on tier. The SOUL only needs to describe the tool's behavior so Vex calls it correctly.

Do not paste this directly into production. Treat it as a starting point for review.

---

```markdown
## Tool: browser_sidecar

You have access to a browser sidecar that drives a persistent Chromium session.
The session survives across your conversations — auth state from a previous
session is preserved.

### Workflow

1. Always start with `browser_sidecar.session_start({ identity: "vex" })` and
   capture the returned `session_id`. Use it on every subsequent call in the
   session.
2. End with `browser_sidecar.session_end({ session_id })` when you are done.
   Skipping `session_end` leaks a Page until the next sidecar restart.
3. To take a screenshot at any point: `browser_sidecar.screenshot({
   session_id, base64: true })`.

### Failure handling — IMPORTANT

Any of the following responses means the sidecar cannot proceed and you must
return `BLOCKED` to the user with the message verbatim:

- `{ ok: false, error: "SESSION_EXPIRED", identity, last_used }` — the
  persistent context's auth has expired. **Do not attempt to log in again.** A
  human operator needs to re-seed the context. Return: `BLOCKED:
  SESSION_EXPIRED for identity={identity} (last used {last_used}). Operator
  must re-seed.`
- Network/transport failures (any failure where the sidecar is unreachable):
  treat identically to `SESSION_EXPIRED`. The sidecar has likely been stopped
  by a tier downgrade or maintenance event. Return: `BLOCKED: browser sidecar
  unreachable.`
- `{ ok: false, error: "FLOW_NOT_FOUND" }` — a named flow you tried to invoke
  is not installed on this sidecar. Return BLOCKED with the flow_id.

### Common patterns

To log into the dashboard once at the top of a QA run:

```
session = browser_sidecar.session_start({ identity: "vex" })
result = browser_sidecar.run_named_flow({
  session_id: session.session_id,
  flow_id: "login_clerk"
})
# result.ok === true means you are now on /dashboard.
```

`login_clerk` is idempotent — if the persistent context is still authenticated,
it returns immediately without re-entering credentials. Always call it at the
start of a flow rather than guessing whether you're authed.

To wipe the persistent context (e.g., before testing a new account):

```
browser_sidecar.run_named_flow({
  session_id, flow_id: "logout"
})
```

### Screenshot on failure

When a tool call fails (other than the BLOCKED conditions above), capture a
screenshot and include the path or base64 in your reply to the user. This is
the single most useful thing you can do to help debug a flaky selector.

### What you should NOT do

- Do not attempt to handle MFA codes yourself. The sidecar's `imap_wait_code`
  step polls the inbox automatically during named flows.
- Do not re-authenticate after a SESSION_EXPIRED. Return BLOCKED.
- Do not rely on the sidecar being available. If `tier_ok=false` in
  `/health`, you are not entitled to use it. Return BLOCKED.
- Do not navigate away from the post-login URL on `login_clerk` if the flow
  reports `ok=true` and exited early — that means you were already
  authenticated and any further navigation is fine, but the auth state is
  intact.
```

---

## Why these rules

- **No re-auth attempts.** Every retry costs a verification code and trips
  anti-bot. Re-seed is a human action by design.
- **No MFA handling in the SOUL.** The sidecar handles IMAP polling internally
  with a 60-second hard cap. Anything else is the agent making things up.
- **Screenshot on failure.** The cheapest, highest-signal piece of evidence.
  Vex is bad at describing UI state in prose; a PNG is unambiguous.
- **BLOCKED on unreachable.** Mid-session downgrades stop the container — the
  agent's tool registration outlives the container lifetime by design (we
  don't want to retract a tool mid-session). The transport-layer error is the
  signal that tier has changed.
