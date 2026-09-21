# Hermes release builder ops

`builderbox-1` is dedicated release infrastructure for HermesOS image builds. It is not a public registry and not a tenant/prod VM.

## Normal safe flow

1. Merge source through the usual canary/prod PR gates.
2. Keep GitHub-hosted PR tests as the untrusted-code gate.
3. After merge, use builderbox as the primary trusted image publisher.
4. Push built images to GHCR.
5. Roll the target fleet and verify exact Docker image IDs.

Default no-push prod smoke:

```bash
npm run ops:release:builder -- --channel prod
```

Default no-push canary smoke:

```bash
npm run ops:release:builder -- --channel canary
```

Publish prod images to GHCR:

```bash
npm run ops:release:builder -- --channel prod --push
```

Publish canary images to GHCR:

```bash
npm run ops:release:builder -- --channel canary --push
```

Specific exact refs, preferred after source merges:

```bash
npm run ops:release:builder -- \
  --channel prod \
  --agent-ref <agent-merge-sha> \
  --webui-ref <webui-merge-sha> \
  --push
```

Dry run:

```bash
npm run ops:release:builder -- --channel prod --dry-run
```

## Channels

`prod` builds from and publishes to:

```txt
ashneil12/vanilla-hermes-agent      -> ghcr.io/ashneil12/vanilla-hermes-agent
ashneil12/hermes-webui              -> ghcr.io/ashneil12/hermes-webui
```

`canary` builds from and publishes to:

```txt
ashneil12/vanilla-hermes-agent-canary -> ghcr.io/ashneil12/vanilla-hermes-agent-canary
ashneil12/hermes-webui-canary         -> ghcr.io/ashneil12/hermes-webui-canary
```

The builder publishes immutable `sha-<12>` tags and then `stable`, but only after both agent and WebUI have built and smoked successfully.

## Why not GitHub self-hosted runner by default

Do not register builderbox as a general self-hosted runner for public PR workflows. These repos can receive untrusted PR code, and self-hosted runners with GHCR credentials are a credential-exfiltration surface.

Allowed future version:

- a locked-down, repo-specific runner group,
- only trusted `push`/`workflow_dispatch` jobs,
- no PR-from-fork execution,
- short-lived tokens,
- no customer/provider secrets.

Until then, use builderbox as a trusted post-merge/manual release builder.

## Registry/cache note

GHCR remains the registry of record. Builderbox can run a local GHCR pull-through cache for tests, but existing fleet VMs pull `ghcr.io/...` directly. Cache acceleration requires a separate canary-first cache VM/image-ref project.
