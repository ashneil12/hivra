# Backup / Restore Gate Checklist

Date: 2026-05-25
Owner: Benedict
Reviewer: Augustine
Status: blocked on owner-provided storage/secret inputs

## Decision already made

Use Hetzner Storage Box as the v0 encrypted cold-storage target for HermesOS backup drills unless Ash explicitly overrides it.

Rationale:

- same vendor/account surface as current infra
- lower operational complexity than S3/R2/B2 for v0
- good fit for restic over SSH/SFTP
- keeps the first milestone focused on restore proof, not provider abstraction

## What is safe to do autonomously now

- maintain backup runbook/specs
- write scripts in dry-run/no-secret mode
- validate restic/age installation locally
- prepare restore-drill commands against a dummy local repo
- schedule reminders/watch items

## Real Ash gate

Execution needs these three inputs:

1. Hetzner Storage Box target
   - hostname
   - username
   - remote path/prefix
   - access method: SSH/SFTP/restic repo URL

2. Encryption recipient / escrow
   - age public recipient, or
   - explicit instruction to generate a new age keypair and where the private key should be escrowed

3. Canary restore drill window
   - approved time window
   - canary scope: dashboard config only, WebUI volume sample, or full selected VM/app backup

## First restore drill scope recommendation

Start with the smallest meaningful restore:

```txt
scope: canary control-plane config + selected non-secret metadata sample
target: fresh temp restore directory, not live prod
success: restic snapshot can be restored, checksummed, and inspected without touching production
```

Do not start with full VM backup. Prove restore mechanics first.

## Execution plan after gate clears

1. Create encrypted restic repo on Storage Box.
2. Run one canary backup from selected scope.
3. Restore into temp directory.
4. Verify checksums and file inventory.
5. Write restore evidence to `docs/superpowers/specs/`.
6. Only then propose recurring automation.

## Non-goals

- no prod backup automation before restore proof
- no secret upload without explicit escrow plan
- no customer data movement without separate approval
- no full VM backup until the small restore drill passes
