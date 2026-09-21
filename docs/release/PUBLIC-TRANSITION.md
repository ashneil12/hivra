# Public repository and installation boundaries

The canonical public repository is [ashneil12/hivra](https://github.com/ashneil12/hivra).
It contains the functional platform. Managed hosting and self-hosting use the same
source with separate credentials, databases, configuration, and capacity.

## Development and deployment

Contributions target `main`. The `canary` branch selects a revision for managed
testing. Production is an explicitly promoted deployment and can remain behind
both branches. A main merge does not automatically change live traffic. Follow
the [managed release process](MANAGED-HOSTING-RELEASES.md).

Keep hosted secrets, customer information, operational inventory, personal tooling,
internal business plans, and incident records outside public Git. Generic recovery
tools, self-hosting instructions, architecture, and useful platform capabilities
remain public. This boundary must not create a superior private functional core.

## Older private work

The original private repositories and their history are retained. Work made there
does not automatically transfer into this repository. Move selected changes by
reviewed patches and public PRs; never mirror private Git history into the public
remote. Check dependencies and active tasks before retiring a private checkout.

The initial public repository was created from a reviewed current-tree export.
Subsequent file removal cleans the current tree; it does not erase earlier public
commits or copies already downloaded. History rewriting is a separate coordinated
operation, not a side effect of documentation cleanup.
