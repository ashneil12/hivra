# Security policy

Hivra treats containment, credential custody, access revocation, provider
authority, and recovery as product requirements. Security claims must match
verified behavior; see [the security model](docs/SECURITY-MODEL.md).

## Supported versions

Until the first tagged public release, security fixes are applied to the latest
commit on `main` and verified on Canary. Historical commits, old provisioner
bundles, and independently modified deployments are not maintained branches.
After tagged releases begin, this section will list the supported release line
and end-of-support dates explicitly.

## Report a vulnerability privately

Do not open a public issue for an unpatched vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/ashneil12/hivra/security/advisories/new),
or email info@hivra.cloud with the subject `[Hivra security]`. Include:

- the affected revision, release, URL, component, or provisioner version;
- a minimal reproduction and the expected versus observed boundary;
- the likely impact and whether exploitation has been attempted;
- relevant logs with credentials, customer data, host addresses, and reusable
  access material removed; and
- a safe way to contact you for follow-up.

Do not send live private keys or reusable credentials. Revoke exposed material
first when safe, then send only its identifier or cryptographic fingerprint.
Please avoid accessing other users' data, changing paid infrastructure, or
degrading a shared service while researching.

Hivra will acknowledge a report through the same channel, coordinate a scoped
fix and verification plan, and publish credit when requested after affected
users can be protected. No response-time promise is made until a staffed public
security-response rotation is documented.

GitHub private vulnerability reporting is enabled for this repository. The email
contact remains available if you cannot use GitHub.
