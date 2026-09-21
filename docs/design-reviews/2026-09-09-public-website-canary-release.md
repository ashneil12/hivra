# Hivra public website and Litepaper Canary release

Status: PASS for the public homepage and Litepaper paths on Canary.

## Release

- Source: `9aeab12531eac66b67201c2494decf541151f0e9`
- Pull request: <https://github.com/ashneil12/hermesdeploy-canary/pull/612>
- Vercel project: `hermesos-canary` (`prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`)
- Deployment: `dpl_J8u6rvy6M585TfeHDRykX1c44jhe`
- Immutable URL: <https://hermesos-canary-45bxf3e77-ashneil12s-projects.vercel.app>
- Canary alias: <https://canary.hermesos.cloud>
- Rollback deployment: `dpl_4SS4zVsChhXoR6aWB2Cwu4CE87oR`

The deployment was promoted only inside the dedicated Canary project. The
separate `hermesos` production project and `hivra.cloud` remained on deployment
`dpl_UUeX3MCrEiEu8qkh9HBu8o4VFhvr`, created 4 September 2026.

Two earlier manual production-slot candidates failed before promotion because
the uploaded CLI package omitted Litepaper files above the project's configured
`dashboard` root. They did not move the Canary alias. The Git-built deployment
cloned the exact source revision, passed prebuild staging and was inspected
before promotion.

## Acceptance

- Vercel built the exact commit successfully. Prebuild staged all 20 allowlisted
  Litepaper files, and the final deployment reached Ready.
- The public homepage contains the revised founder wording, Ubuntu, Windows and
  Omarchy choices, and the Litepaper link.
- The live Litepaper contains the revised founder section and no longer contains
  “the rest of this page stands on its own.”
- The header logo, chapter index and footer provide links back to `/` on the
  Canary host. Browser accessibility output confirmed the header link resolves
  to `https://canary.hermesos.cloud/`.
- The linked `/THOUGHTS.md` document is available with the source references.
- Downloaded live `LITEPAPER.md` and `THOUGHTS.md` files match the local source
  byte for byte by SHA-256.

Local checks passed: 11 Litepaper content/link tests, 5 staging tests, 34 focused
landing-page tests, touched-file ESLint, TypeScript, and a complete Next.js
production build using webpack. The default local Turbopack build cannot follow
the worktree's external `node_modules` symlink; Vercel's normal dependency tree
built successfully with Turbopack.

No dashboard workflow, database, computer, agent, provider resource, billing
state or public production deployment was changed. The authenticated browser
redirects `/` to the existing dashboard, so public homepage acceptance used an
unauthenticated HTTP read and the public Litepaper was also inspected in the
browser. Physical phone acceptance was not repeated for this copy release.
