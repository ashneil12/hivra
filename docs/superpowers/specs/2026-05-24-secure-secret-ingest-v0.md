# Secure Secret Ingest v0 — 2026-05-24

## Goal

Replace ad-hoc key sharing with a product-grade path for users and operators to provide secrets without exposing values in chat, logs, commits, Discord, or normal agent context.

This does not rotate existing bootstrap keys. It defines the safer next layer.

## Non-goals

- Do not build a full enterprise secrets manager in v0.
- Do not require users to adopt Bankr, Vault, 1Password, or Bitwarden before they can launch.
- Do not expose secret values back to the browser after initial submission.
- Do not let agents print, summarize, diff, or commit secret values.

## User stories

1. As Ash/operator, I can paste a provider key once, choose where it should land, and see verification by name only.
2. As a future HermesOS user, I can add keys for my instance without support staff seeing the plaintext.
3. As Augustine/AEON, I can verify that a required secret exists and was updated without reading its value.
4. As ops, I can audit who changed which secret name and destination without storing plaintext in logs.

## Destinations

V0 should support destination pickers:

- Local Hermes profile env: `~/.hermes/.env` or selected profile env.
- GitHub Actions secret: selected repo, selected secret name.
- Vercel env var: selected project/environment.
- Supabase secret/config where applicable.
- Instance runtime env: specific HermesOS instance or template.

Every destination needs a named adapter with:

- `validateName(name)`
- `writeSecret(name, value, scope)`
- `verifySecretExists(name, scope)`
- `redactedAuditEvent(name, scope, actor)`

## UI rules

- Secret input is masked by default.
- Optional reveal is local-only and time-limited.
- Submit button says exactly where the secret will be stored.
- Never echo the value in success/error output.
- Show only:
  - secret name
  - destination
  - updated timestamp
  - verifier status
- Provide copy for rotation reminder, but do not force rotation in bootstrap mode.

## API rules

- Request body can contain plaintext only on the direct ingest endpoint.
- The endpoint must not log request bodies.
- Validate and redact errors before returning to client.
- Store only through destination adapters.
- Return a redacted receipt:

```ts
type SecretIngestReceipt = {
  ok: boolean;
  name: string;
  destination: string;
  scope: string;
  updatedAt: string;
  verifier: 'exists' | 'write_only' | 'failed';
  errorCode?: string;
};
```

## Audit trail

Record metadata only:

```txt
actor_id
secret_name
destination_type
destination_scope
updated_at
verifier_status
request_id
```

Never record:

```txt
plaintext value
prefix/suffix
hash of value unless there is a specific rotation-detection need
provider account metadata returned by a validation call
```

## Agent/AEON rules

- Agents may request a missing secret by name and destination.
- Agents may verify existence by name.
- Agents may not ask the user to paste keys into normal chat once this path exists.
- AEON summaries must say `[REDACTED]` for values and list names only.

## Security controls

- Disable request-body logging on ingest routes.
- Add tests proving secret values do not appear in logs, responses, audit rows, or thrown errors.
- Apply strict destination permissions. A user can only write to their own instance/profile unless operator mode is explicitly enabled.
- Prefer write-only provider APIs where available.
- Keep optional rotation reminders separate from forced rotation policy.

## Initial implementation plan

1. Add domain types and adapter interface.
2. Implement GitHub Actions secret adapter using existing `gh`/REST patterns server-side only.
3. Implement local/profile env adapter for self-host/operator mode.
4. Add dashboard modal for operator secret ingest.
5. Add audit table with metadata-only rows.
6. Add tests for redaction and no-log behavior.
7. Add future adapters: Vercel, Supabase, instance runtime env.

## Open decisions

- Which users get operator mode in launch v0?
- Should future end users write directly to instance env or to a managed secret table rendered into env at deploy time?
- Do we want value hashing for duplicate detection, or avoid it entirely for v0?
- Do we expose validation calls, e.g. “test PostHog key,” or only existence checks in v0?

## Acceptance criteria

- Operator can set a secret without the value appearing in server logs, browser response, Git history, Discord, or AEON output.
- Receipt verifies by secret name only.
- Failed writes are safely classified without leaking plaintext.
- A test intentionally submits a fake key and asserts it is absent from all captured logs/responses.
