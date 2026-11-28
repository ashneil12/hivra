# Prepared Ubuntu/QEMU Guest Agent disk candidate

This is a local image build. It does not select an image for launch, replace a host's stock disk, or activate anything. Use the [shared builder requirements](bake-official-hermes.md#build) on a disposable Linux amd64 builder without operator credentials.

```sh
mkdir -m 0700 ubuntu-qga-bake-output
bash dashboard/scripts/bake-runtime-image.sh ubuntu-qga ubuntu-qga-bake-output
```

The profile requests only `qemu-guest-agent` (and its apt dependencies), enables its service, and runs the same GPT-preserving expansion, identity cleanup, and standalone QCOW2 sealing as the other profiles. It does not install Node, an agent runtime, a Hivra service, or access credentials. The embedded marker `/etc/hivra/ubuntu-qga-bake.json` records the exact base SHA-256 and installed Debian package version. The producer emits `hivra-ubuntu-qga-<sha256>.qcow2` and a same-named manifest containing the same marker and exact output digest.

This profile starts from the archive pin in `ubuntu-qga-bake-pins.env`, separate from the base used by the runtime images. The public Canonical archive redirects its usual dated image URL to an HTTP-only website endpoint, so the pin uses the archive bucket's HTTPS object endpoint and verifies the exact SHA-256 against Canonical's published checksum. Compare the actual stock base SHA-256 before measuring; a different base cannot isolate the effect of removing first-boot package installation.

Before proposing a pilot, independently verify the output SHA, standalone format and image integrity, package version, blank machine-ID file, and absence of host keys, cloud-init state, accounts and owner configuration added by the builder. Boot two disposable network-isolated SeaBIOS clones; each must reach QGA with a distinct generated machine ID and SSH host key. A qualified artifact does not authorize host staging or selection.

## Scoped Canary comparison

After both offline boots pass, stage the exact digest for the named host and
standing QA owner using the [prepared disk checks](../../docs/release/DEEPSEEK-IMAGE-PILOT.md).
Use the filename `hivra-ubuntu-qga-<sha256>.qcow2` and set
`HIVRA_CANARY_UBUNTU_QGA_IMAGE_HOST`, `HIVRA_CANARY_UBUNTU_QGA_IMAGE_SHA256`,
and `HIVRA_CANARY_UBUNTU_QGA_IMAGE_USER_ID` together on Git Canary. This
affects only fresh stock Claude Code, Codex, OpenClaw, DeepSeek Harness and
Agent Zero launches for the selected host and owner on sealed bundle .4.
A launch with browser automation enabled, a move, or a designated
Canary holder launch is not eligible. Some profiles recommend browser
automation, so explicitly turn it off on the Review screen for both
the stock control and the QGA trial. Verify the actual source disk for
each launch; an eligible owner and host alone do not prove selection.
A matching prepared DeepSeek application disk takes precedence. Stock
launches stay unchanged when all three settings are unset.

Compare QEMU start to attested SSH and clean cloud-init on the same host,
agent profile and stock base digest. Take a separate reading for authenticated
composer and visible reply; the package-only image does not preinstall agents.
