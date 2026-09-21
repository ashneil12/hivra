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

## Rollback Notes

- Fastest rollback path if this misbehaves:
