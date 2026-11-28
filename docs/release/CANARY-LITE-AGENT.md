# Canary Lite agent qualification

This is an operator-only, default-off QA lane. It is not a public Lite rollout
or holder qualification. Canonical Git Canary uses the single
`hivra_canary_lite_qa_settings` row, not public preview environment variables.
Other deployments keep the existing opt-in environment configuration.

1. Stage the separate `lite-agent-canary` Worker and set its
   `LITE_AGENT_SECRET` from 32 random bytes encoded as lowercase hex. Confirm
   its unsigned `/v1/me` returns 401. Don't turn on an unapproved provider.
2. Apply the reviewed schema migration only to the authorized Canary database.
   It creates no rows. Verify the Git version with the QA gate is serving
   before granting access.
3. On the private operator machine that holds the Worker HMAC key and the
   existing Canary dashboard `ENCRYPTION_KEY`, seal the same Worker HMAC key,
   without putting either plaintext value in a command argument or SQL. From
   `dashboard/`, with Node 24 and an owner-only output file:

   ```sh
   umask 077
   node --input-type=module -e '
     import { readFileSync } from "node:fs";
     import { encryptSecret } from "./src/lib/crypto.ts";
     const value = readFileSync(0, "utf8").trim();
     if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Expected the Canary Worker key");
     process.stdout.write(encryptSecret(value));
   ' < "$LOCAL_WORKER_KEY_FILE" > "$LOCAL_SEALED_KEY_FILE"
   ```

4. As the authorized Canary DB operator, stage an enabled singleton with the
   exact allowed standing Clerk `owner_id`, a finite `expires_at` no more than
   24 hours in the future, the exact HTTPS `lite-agent-canary` workers.dev
   origin without a path, and the sealed value in `signing_secret_enc`.
   Pass settings through bound SQL parameters. Don't print or commit either
   the plaintext or the sealed value. Read back only the enabled flag and
   expiry. The dashboard service role can read, but cannot change, the row.
5. Use the direct `/dashboard/free-agent` URL with the standing QA account.
   The API and page both check that account; unsigned, unrelated, disabled,
   expired, and unverifiable contexts stay hidden. Use only an already
   approved and bounded model for the signed reply/memory/allowance ladder.
   Delete the exact QA agent while the row is still enabled, then disable the
   row, clear the sealed value, and verify signed `/api/lite-agents/me` is
   hidden again. There is no public discovery-link change.
