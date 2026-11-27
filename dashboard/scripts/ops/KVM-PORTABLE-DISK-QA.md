# Cross-host KVM disk checkpoint QA

This is an operator-only experiment. It does not change product placement or
sleep. Two disposable tagged KVM fixtures run with one SeaBIOS Linux boot disk,
one read-only seed device and loopback-only SSH. No customer VM, full hosted
computer, Windows installation, TPM, EFI variables or saved RAM are supported.
The experiment deliberately retains the fenced source until proof and teardown.
See the [fixture driver](KVM-PORTABLE-FIXTURE.md) for its exact CLI and
receipt contract. Don't infer portability from a base image name.

## Compare whole and delta on owned hosts

1. Pick two compatible, explicitly authorized hosts and unused QA VMIDs in
   9300–9399 (never 9302). Check cluster allocation, Hivra bindings and
   provider intents, physical storage, memory and I/O pressure. Reserve time
   for cleanup; shared devices and a private volume aren't separate I/O
   failure domains. Use a fresh 32-hex run ID and a bounded UTC deadline.
2. Use `kvm-portable-fixture.sh prepare` on the exact source and destination
   with the same pair, run and deadline. The source boots a pinned base plus a
   writable QCOW2 overlay and writes a synthetic guest witness. The destination
   is reserved stopped and fenced and has the exact prepositioned base.
   Nothing creates a public route or changes shared forwarding.
3. Use `fence-source` to shut the source down, verify its Proxmox lock and
   pin the resulting disk and witness. Pass the fence receipt and temporary
   fixture-only SSH client key to the owned destination through an approved
   private operator path. Never log or archive the client key.
4. Create a new Storage Box directory `hivr43-kvm-qa-<run>` through the
   existing host-key-verified `cold` alias. Initialize only that new Restic
   repository with a new scoped password file on each host. The tool accepts
   only that repository and root-private local staging. Keep those files out
   of logs. With the fenced source and an empty private checkpoint directory,
   run:

   ```sh
   lease="/var/tmp/hivra-kvm-portable-${RUN}"
   python3 kvm-portable-disk.py pack --generation "$RUN" --directory "$lease/checkpoint" \
     --base "$lease/base.img" --base-sha256 "$BASE_SHA256" --source "$lease/guest.qcow2"
   python3 kvm-portable-disk.py publish --generation "$RUN" --directory "$lease/checkpoint"
   ```

   `pack` compares a standalone converted disk against the resolved source.
   The delta is the exact overlay, including explicit zeros, and only works
   with the independently verified base. `publish` records a single pinned
   authenticated snapshot and reads back both artifacts. Offload does not
   erase local disks. An incorrect base or digest cannot produce a boot
   receipt.
5. With the same repository environment on the destination, restore the
   selected lane from the pinned snapshot, then invoke `boot-target`:

   ```sh
   python3 kvm-portable-disk.py restore --generation "$RUN" --directory "$lease" \
     --base "$lease/base.img" --snapshot "$SNAPSHOT_ID" --lane "$LANE"
   ```

   The driver checks the staged disk, fence and pinned guest SSH identity.
   It requires the original guest witness to match and shuts the destination
   down again. There is one boot per target fixture. Use a fresh run per
   lane; never reopen the source to benchmark a destination retry.
6. Run `cleanup` on both hosts and read back absence of both exact VMIDs,
   their process, loopback port and owned scratch. Remove and independently
   verify absence of only the run's Storage Box directory. Clear the
   temporary key/password. Use the deadline cleanup if the operator path
   fails; verify the remote namespace separately.

Measure artifact bytes, base preparation time (outside cold wake), signed
read and disk verification, and start-to-original-witness. Compare both
lanes for the same declared workload class. Record sample counts and do not
call an operator SSH result a signed-in hosted-agent reply or use one run
to make a percentile claim. Do not stress shared hosts without a bounded
admission envelope and a clean stop check.
