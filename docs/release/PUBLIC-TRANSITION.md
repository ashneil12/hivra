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

## History of the initial import

The first public commit (`250fd9d9`, 2026-09-21) carried internal working
documents: planning notes, rollout logs and agent skill text. A later commit the
same day (`7eca4e9c`) removed them from the tree. They remain in the reachable
history of every branch and in every clone made since. A history rewrite cannot
recall copies that already exist, and it would break every clone and pull request
reference.

A review on 2026-09-30 scanned that history with Gitleaks, a list of provider
credential formats and a private-key check, and reported only test fixtures. What
remains in it is operational detail without a credential attached: pseudonymised
plans, a few identifiers of disposable test infrastructure, and a database
project reference, which names a database and holds no credential. This page
records that finding and is not a new audit.

The review recommended keeping the history as it is, and the owner has not
decided otherwise. Open owner checks that no file in this repository can do:

- Confirm in the hosting provider's console that the disposable test server named
  in one of those early documents no longer exists.
- Confirm at each provider that every credential held in the retired private
  repositories was rotated. The [redacted reconciliation](VERIFICATION-STATUS.md)
  records only what was checked on 2026-08-30.

The public-tree hygiene gate runs in the "Current tree safety" check on every
pull request and every push to `canary` and `main`. It flags the same kinds of
material if they appear in the tree again.
