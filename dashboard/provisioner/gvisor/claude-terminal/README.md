# Claude Code terminal image candidate

This is a source-only recipe for the single-owner Canary pilot. It runs
Claude Code's own interactive interface in ttyd, Hivra's existing browser
terminal frontend. It does not replace Claude's native sign-in, expose a shell
as the default program, or publish a port. ttyd is MIT-licensed and its notice
is retained. Claude Code is proprietary and is installed unmodified.

Build on the authorized target, for Linux amd64:

```sh
docker build --platform linux/amd64 --iidfile claude-terminal.iid \
  -t hivra-claude-terminal:local dashboard/provisioner/gvisor/claude-terminal
docker image inspect --format '{{.Id}}' hivra-claude-terminal:local
```

The build fetches the exact upstream artifacts, verifies each checksum, and
installs just the executables and notices. Record and verify the local image
identity before admission; never trust the tag. Do not push, mirror or export
the resulting image. See [Runtime distribution](../../../../docs/release/RUNTIME-DISTRIBUTION.md)
and [Anthropic's hosted usage conditions](https://code.claude.com/docs/en/legal-and-compliance).

The existing sandbox envelope still applies: gVisor, UID 65534, read-only root,
no Linux capabilities, no Docker socket or public ports, bounded resources and
a noexec tmpfs at `/tmp`. Mount the owned volume at `/workspace`,
writable by UID 65534 and without image contents copied into it. The agent
works in `/workspace/project`; its native state and credentials stay in
`/workspace/.agent-home`. Stop/start retains both on the same volume, not the
in-memory terminal process.

The health probe checks ttyd's HTTP response on the internal Unix socket. It
does not establish a Claude account, inference, network access, or gateway
readiness.

## Canary pilot staging

1. Apply the pilot schema before the dashboard starts using it. Connect and
   qualify a dedicated Linux Sandbox host for the enrolled owner. Do not
   replace an adapter on an existing managed host to run this pilot.
2. Keep the pinned Python helper image staged. Write the verified local image
   ID as the only line in the host's root-owned, mode-`0600`
   `/opt/hivra/gvisor-adapter/claude-terminal-image`. Never enable image
   admission from a registry tag.
3. Use the existing dedicated guest HTTPS reverse proxy for one app-only
   origin, with the tunnel credentials outside runsc. Configure the
   dashboard's server-only `HIVRA_CLAUDE_SANDBOX_PILOT_*` settings for the
   exact owner, connected target, image ID, adapter SHA, origin and a unique
   32-byte hex grant key. The tile is absent unless production-slot Git
   Canary has all settings and `ENABLED=1`.
4. Launch from Hivra and use the exact launch receipt for the host-side
   [socket relay](../claude-terminal-relay/README.md) and [gateway](../claude-terminal-gateway/README.md).
   Bind both to that owner and sandbox. The gateway receives the grant key
   from a private host file; the container receives neither the key nor
   access to the host's Docker socket. Do not repoint either service to a
   different sandbox without tearing both down first and rotating the key.
5. Verify the owner can open the terminal and a different tenant cannot,
   then verify native model sign-in/first reply and project and agent-state
   retention across Stop and Start. Delete only the owned sandbox and
   remove the fixture's gateway, relay, access route and staging settings.

The pilot does not seed an inference key or share the VM lane's model
credentials. No part of this staging is production release approval.
