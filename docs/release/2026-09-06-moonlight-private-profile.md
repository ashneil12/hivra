# Mac Moonlight private identity preparation

Status: PASS for private profile creation and pinned native-client settings
compatibility. This is not pairing, streaming, lease exchange or desktop acceptance.

## Implementation

`HivraMoonlightProfile.prepare()` creates one exclusive local profile per session,
using the OS `/usr/bin/openssl` with a fixed environment and bounded process wait.
The RSA identity is self-signed with explicit critical `CA:FALSE`, matching the
guest guardian policy. Only the public PEM/fingerprint and profile locations are
returned; the private key remains in the private portable settings file.

The parent must be owner-only, canonical and free of extended ACL entries.
Parent/session identities are retained across subprocesses and checked before
failure cleanup. Existing profiles, replaced directories and ACLs are never
adopted, regenerated, stripped or deleted. The current policy conservatively
refuses all extended ACL entries, including deny-only entries. Source creation
does not grant the future app a path/command bridge from web content.

No launch button, Moonlight process manager, executable installer, native lease
exchange or guest activation was added. The app still uses its existing web
surfaces. The profile is a prerequisite for the approved isolated native adapter,
not a standalone streaming shortcut.

## Failures found and corrected

- The first native run used the display-name settings folder. Actual macOS
  Moonlight instead created `moonlight-stream.com/Moonlight.ini`. The factory and
  regression now use that domain folder. Portable path selection and identity
  loading follow the pinned upstream
  [main entrypoint](https://github.com/moonlight-stream/moonlight-qt/blob/v6.1.0/app/main.cpp)
  and [identity manager](https://github.com/moonlight-stream/moonlight-qt/blob/v6.1.0/app/backend/identitymanager.cpp).
- Independent review reproduced deletion of a replacement profile during failed
  generation. Original parent/session checks now preserve the replacement.
- Independent review reproduced everyone-readable inherited ACLs despite 0700/
  0600 mode bits. The actual macOS ACL regression failed before correction and
  now refuses before generation without changing the parent. Descriptor-based
  ACL inspection follows [Darwin's ACL implementation](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_file.c).

## Checks

- Seven focused Swift tests passed; independent corrected review reran all seven
  in 1.149 seconds and found no remaining actionable P1/P2 in this component.
- Final full Mac suite: 24 tests passed in 1.097 seconds. `git diff --check` passed.
- Actual official Moonlight `6.1.0` macOS universal binary ran from a read-only
  temporary disk image. Deep/strict code-sign verification passed; Gatekeeper
  accepted its notarized Developer ID signature, team `45U78722YL`.
- Download: [official Moonlight 6.1.0 DMG](https://github.com/moonlight-stream/moonlight-qt/releases/download/v6.1.0/Moonlight-6.1.0.dmg).
  Observed DMG SHA256: `d494740eead8ad4e620cdc8feedb56083bc29cabbbeef34cb82585fd87725fa2`.
  The release API did not publish an asset digest; this is an observed checksum,
  not an independently published checksum.
- Observed executable SHA256:
  `95a3a1d0fe56f3e1fccea5f7fb9a2ab951ef3da970f3e1b486fbf42dae347a91`.
- The final native `list 127.0.0.1` check completed its normal missing-host timeout
  (exit 255). After initialization, the exact certificate, private-key and client
  ID values remained in the correct portable settings. The normal user preference
  file was unchanged. The key-bearing INI remained mode 0600.
- Moonlight added only its compatibility-cache field, observed as
  `latestsupportedversion-v1=10.252.99.99`, and normalized INI quoting. This is not a
  byte-identical-file claim. The cache write is implemented by upstream
  [CompatFetcher](https://github.com/moonlight-stream/moonlight-qt/blob/v6.1.0/app/settings/compatfetcher.cpp).
  The check required exact identity-value preservation and rejected any other
  added field; it did not ignore the whole settings file.
- The same final Mac-generated public certificate passed the Linux guardian's
  actual certificate admission function in the pinned isolated Sunshine image.
  DER SHA256: `f7281616ff68a446f08858905a8033c76b9bac8adc125326ad83eade5af59c67`.

The initial exploratory verifier incorrectly treated an empty log as no identity
regeneration; that result was rejected when the unexpected settings file appeared.
The next check incorrectly required the entire INI to remain byte-identical.
Neither is acceptance evidence. The final check uses actual settings values and
the specific source-confirmed cache change. Empty logs are not used as proof.

## Preservation, cleanup and limits

Only generated test profiles were used. No existing Moonlight installation or
profile was changed, no server was paired and no guest/provider/route/firewall or
Canary deployment changed. No additional Hetzner spend; cumulative conservative
reservation remains GBP 6.90/10. The native child exited and no matching test
process remained. The read-only disk image was ejected successfully; the exact
generated temporary directory, disk image, harness binaries and test profiles/
private keys were removed. Final checks confirmed the directory and owned Docker
certificate-check containers were absent. Nothing was installed in Applications.

System Keychain behavior during a TLS stream, full client-process isolation,
actual native input/media/audio, reconnect/revocation, systemd guest dispatch and
controller release remain unverified. Do not enable Omarchy from this checkpoint.
Source rollback is a branch/PR revert; no deployed runtime rollback is required.
