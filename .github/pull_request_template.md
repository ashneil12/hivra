## Summary

- What changed:
- Why it changed:

## Risk Surface

- [ ] Billing / checkout / usage
- [ ] Conversations / chat transport
- [ ] Provisioning / Hetzner / instance settings
- [ ] Gateway / probe / networking
- [ ] Other

## Regression Proof

- Regression test added or updated:
- If no automated test was added, explain why:
- Hot-path tests affected:

## Verification

- Risk level: tiny / normal / high
- Verification plan: `cd dashboard && npm run verify:plan -- --risk <tiny|normal|high>`
- Checks actually run:
- Manual checks performed:
- Post-deploy/canary check needed? yes / no

## Public text check

- [ ] The title and this description pass `node scripts/release/public-tree-hygiene.mjs --text-file -` (paste the text on stdin). It flags live host names, storage box addresses, wallet addresses, database project references and customer ids. Pull request text is public and its edit history stays visible, so run it before you open the pull request and after any edit.

## Rollback Notes

- Fastest rollback path if this misbehaves:

## Hosting impact

- Intended scope: shared core / optional self-hosting feature / managed operations
- New settings, providers, permissions, background work, or ongoing costs:
- Default behavior and how the feature stays disabled when not configured:
- Tenant isolation, billing, and authentication impact:
- Canary evidence for managed enablement (if applicable):

Merging this PR accepts code; it does not authorize production promotion or
managed-service enablement.
