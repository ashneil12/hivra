# Claude Code terminal image candidate

This is a source-only recipe, not an available Hivra launch target. It runs
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
a noexec tmpfs at `/tmp`. Mount the owned, quota-bound volume at `/workspace`,
writable by UID 65534 and without image contents copied into it. The agent
works in `/workspace/project`; its native state and credentials stay in
`/workspace/.agent-home`. Stop/start retains both on the same volume, not the
in-memory terminal process.

A trusted gateway must authorize the Hivra owner before proxying the fixed
`/terminal/` HTTP and WebSocket routes to `/tmp/hivra-claude-terminal.sock`.
Do not expose the socket or point a generic proxy at the sandbox. The health
probe checks ttyd's HTTP response on that socket. It does not establish a Claude
account, network access, an inference reply, or gateway readiness.
