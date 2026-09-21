# Ubuntu Hivra-folder recovery

This is an explicitly limited first computer-data recovery path, not a
whole-computer backup and not the controller's `.hivra` recovery format. It
implements part of approved Slice 4B. `UC-COMPUTER-RECOVERY-01` remains unaccepted
until a canary user performs the transfer and verifies bytes after reboot and
reconnect on the exact deployed revision.

## Supported boundary

- One enrolled Proxmox Ubuntu desktop's `/home/bux/Hivra` folder. The same folder
  appears inside its browser desktop at `/home/ubuntu/Hivra`.
- At most **2 MiB of file bytes and 512 files plus directories**. The encrypted
  `.hivra-folder` file must fit 3 MiB; extra path metadata can reach this limit
  before the user-byte limit. Limits fail the entire export, never truncate it.
- Regular files and directories only. No links, hardlinked files, devices,
  sockets or FIFOs. Files must belong to the desktop's `bux` account.
- A different, normally launched Ubuntu computer owned by the same controller
  account, with enforced provider binding, its own fresh gateway token, and an
  empty Hivra folder. Independently launched empty fixtures are eligible; there
  is no arbitrary creation-time window.
- Existing managed or owner-connected Proxmox targets use their persisted
  authority. Hetzner direct-provider guests, Windows, Omarchy and transfer
  between independent controllers are not supported by this first path.

Other folders, packages, browser profiles, machine credentials and whole disks
are not included. A user may put sensitive files in Hivra; those are included
as user data, not silently filtered. Copying credentials inside this folder does
not install them as the destination's machine identity.

## User flow

Open **Manage → Hivra folder recovery** on the original Ubuntu computer, or
`/dashboard/computers/recovery`.

1. Close apps writing to Hivra. With the original computer running, enter a new
   passphrase of at least 12 characters and download its encrypted folder file.
   Export does not stop or remove the original or revoke any sessions.
2. Launch a separate Ubuntu computer through the normal computer flow. Wait for
   it to be running; leave its Hivra folder empty and close destination apps,
   terminal and SSH sessions. No capacity is purchased by
   the recovery endpoint itself.
3. Select the file and the fresh destination, re-enter the passphrase, and check
   the explicit handoff consent. Restore verifies all files before installation,
   stops the destination desktop and broker, both ttyd units and files gateway, atomically
   installs only over an empty directory, and restarts these services so neither
   bind mounts nor terminal working directories retain the old inode. Then it
   verifies hashes. Independently daemonized user/root processes are not a
   supported activity on the fresh destination during transfer.
4. Only after successful verification, existing desktop sessions on the source
   are revoked. Its capability, gateway, data and provider resources remain, so
   the source can be opened under a new session. This does not claim revocation
   of every source access method or deleting/retiring the original computer.
5. Reboot the destination through its ordinary lifecycle controls, reconnect via
   the public desktop/files surfaces, and compare the expected user-file hashes.
   Both original and destination resources remain until the owner separately
   requests their removal.

## Encryption and failure behavior

The archive uses a distinct `HIVRA-FOLDER-1` binary envelope: random 16-byte salt,
scrypt-derived 256-bit key, random 12-byte IV, AES-256-GCM with a 16-byte
authentication tag and the complete header as authenticated associated data.
The encrypted payload includes exact source agent/binding identity, scope,
timestamp, paths, bytes and per-file SHA-256. The controller encrypts/decrypts in
memory; this is **not end-to-end encryption against the controller**. Requests
must use a trusted controller/connection. Passphrases never appear in URLs,
guest commands, operation records, local storage, or application logs. They are
not recoverable by Hivra.

The destination's normal `restore` lease is paired with a separate private
journal. It cannot be cleared by generic lifecycle updates while unverified.
No file bytes or passphrases are stored in the database. The guest uses a
root-owned per-operation receipt and protected staging directory; partial files
resume only when their existing bytes are an exact prefix of this same archive.
A prepared receipt must still match the staged inode and every hash before
installation. A lost response after installation verifies that exact inode and
does not overwrite it a second time. An already-completed replay changes no
files and does not revoke newer source sessions.

An uncertain request must be retried with the **same file and destination**.
Changed destination bytes, a substituted identity, or an unprovable receipt
remain blocked for owner/operator inspection; the system never clears the lease
or deletes data just to make the UI green. A service stop attempted by recovery
gets best-effort restart cleanup on failure, without treating that as successful
file recovery. Original and unrelated resources are not cleanup targets.

## Bounded local verification

From `dashboard/`:

```sh
node node_modules/jest/bin/jest.js --runInBand src/lib/hivra/__tests__/folder-recovery-artifact.test.ts src/lib/hivra/__tests__/folder-recovery-guest.test.ts src/lib/hivra/__tests__/folder-recovery-service.test.ts src/app/api/hivra/folder-recovery/__tests__/route.test.ts
node scripts/test-hivra-folder-recovery.cjs
npm run typecheck
```

The guest tests execute the actual Python on disposable directories, including
binary files, symlink/hardlink/FIFO rejection, staged interruption, lost response,
concurrent no-overwrite conflicts and service cleanup. The SQL harness executes
the real migration and dependencies in isolated PostgreSQL, including owner,
identity and consent checks, private-journal grants, lifecycle fencing, exact
completion, session revocation, and source/unrelated-row preservation. These are
not live or post-reboot acceptance evidence.
