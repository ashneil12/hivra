# GHCR token rotation

Owner: Ash (the only person who can create and revoke the token). No token value belongs in this file, in a PR, in chat or in a log.

## What the token is

`GHCR_TOKEN` is a GitHub personal access token for the `ashneil12` account. Platform code uses it to log in to `ghcr.io`. It is set in the server environment of the Vercel projects `hermesos` (prod) and `hermesos-canary` (canary), and wherever the release builder pushes images from (`builderbox-1`, `npm run ops:release:builder -- --push`). Which of these actually hold a copy is UNVERIFIED from this repository: check each one in step 1.

Every runtime image the boxes pull (`vanilla-hermes-agent`, `hermes-webui`, `operatoros-agent`, `hermes-browser-sidecar` and their `-canary` twins) is a public package, so a box does not need a token to pull. Verify that in step 2 before you revoke anything.

## Why rotate

Older provisioning scripts ran `docker login ghcr.io -u __token__` on tenant boxes and never logged out. The token therefore sits base64-encoded in `/root/.docker/config.json` on boxes, in old Hetzner `user_data`, and in VM backups. The code fix is in `dashboard/src/lib/services/registry-credential-scrub.ts`: it removes the stored platform login the next time a box is provisioned or updated. Existing copies stay valid until the token is revoked. See finding "Platform GHCR_TOKEN shipped into tenant VMs" in `PRE-LAUNCH-REVIEW-2026-09.md`.

## Order matters

Do not revoke before every box has run the scrub. GHCR answers "denied" to a stored credential that no longer works, even for a public image, and the on-box roll and refresh timers pull as root with root's Docker config. A box that still holds the old login when the token dies stops getting updates (the timers only log "pull failed") until a dashboard update, redeploy or recovery reaches it.

## Steps

1. Find every copy that is yours to change.
   - Vercel: `hermesos` and `hermesos-canary`, Settings, Environment Variables, look for `GHCR_TOKEN`. Any Vercel env change is Ash only; agents do not touch it.
   - `builderbox-1`: `docker logout ghcr.io` state and any env file used by `release-builder.ts`.
   - GitHub Actions secrets in `ashneil12/hivra` (Settings, Secrets and variables, Actions) that mention GHCR. The default `GITHUB_TOKEN` is not this token and needs no rotation.
2. Confirm images pull without a login. From a machine with no ghcr login (`docker logout ghcr.io` first), run `docker pull ghcr.io/ashneil12/hermes-webui:stable` and `docker pull ghcr.io/ashneil12/vanilla-hermes-agent:stable`. Both must succeed. Also check each package shows "Public" at https://github.com/users/ashneil12/packages. If one is private, make it public or keep a read-only token (below) and plan for it.
3. Confirm the scrub reached the fleet. For each running box, as root: `grep -c ghcr.io /root/.docker/config.json` must fail (file gone) or show no `ghcr.io` entry for `__token__`. Boxes that still have it need a dashboard update or redeploy first. This is a fleet roll, so it is Ash's call per box (see `hivra-vm-side-rollout`).
4. Create the replacement only if something still needs one.
   - Pushing images (builderbox): fine-grained or classic token, https://github.com/settings/tokens (classic: `write:packages`). Keep it on builderbox only, never in Vercel env, never on a tenant box.
   - Pulling private images (only if step 2 found one): a separate token with `read:packages` only.
   - If nothing needs a token, create none and delete `GHCR_TOKEN` from Vercel env.
5. Put the new value where it is needed, then revoke the old token at https://github.com/settings/tokens (Delete). Revoking also invalidates the copies in old `user_data` and backups.
6. Update the agent vault only if an agent profile needs it: `printf %s "$NEW" | python3 ~/.hermes/scripts/secrets.py set hivra-ops GHCR_TOKEN`, add the name to `MANIFEST.json` for the profile, then `python3 ~/.hermes/scripts/secrets.py sync`. `GHCR_TOKEN` is not in the vault today.
7. Verify after revoke: pull `:stable` with no login (must succeed), trigger one box update on canary and read its roll log (no "pull failed"), and run `release-builder` with `--push` against canary once if a push token was issued.

## Never

- Paste the token anywhere. A pasted token is burned: rotate it again.
- Give a tenant box a write-scope token. Write scope on `:stable` images is fleet-wide compromise.
