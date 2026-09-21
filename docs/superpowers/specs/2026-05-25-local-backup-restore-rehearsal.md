# Local Backup Restore Rehearsal

Date: 2026-05-25
Status: implemented and safe to run locally

## Purpose

This is the interim backup step while the real remote encrypted target is not provisioned yet.

It proves the backup/restore mechanics without requiring Ash to know the Hetzner Storage Box details yet.

## Script

```txt
scripts/backup-restore-rehearsal.sh
```

## Scope

The rehearsal backs up only a non-secret canary control-plane sample:

- `docs/superpowers/specs/` except secret/credential/key-named specs
- dashboard package manifests
- selected non-secret dashboard config/source files

It does not select:

- prod data
- customer data
- `.env` files
- private keys
- wallet secrets
- credential stores

## Safety behavior

The script fails if secret-looking file names enter the source sample:

```txt
.env*
*secret*
*key*
*.pem
*.p12
```

It writes local artifacts under:

```txt
/workspace/.hermesos-backup-rehearsals/<timestamp>/
```

## Verification

The script:

1. copies selected sample files into a staging source directory
2. creates a `.tar.gz` archive
3. writes archive `sha256`
4. restores into a fresh local directory
5. compares restored file checksums against source checksums
6. writes a report

## Remote backup still gated

A real remote encrypted backup remains blocked on:

1. Hetzner Storage Box target
2. age recipient or key escrow decision
3. canary restore drill window/scope approval
