# Native dashboard agent model-setup guidance

## Scope

Source `3d89002248c77b5d4d6d5549b4085b6a67185e4c`, PR #600,
`codex/hivra-core-experience-plan`. Canary only; no production, guest,
credential, billing-state or lifecycle mutation. Workflow-risk presentation fix.

## Diagnosis

The retained Agent Zero fixture `00000000-0000-4000-8000-000000001017`
has `managed_venice=false` and `status=running` (read-only linked database
query on September 6). Combined with the native model-picker observation in
`2026-09-06-agent-surface-recovery.md`, this is consistent with launching without
managed model setup. It does not establish a provisioning defect, nor prove
that no provider has ever been configured in its native settings.

From the logged-in root-path Hivra Mac app, followed Launch → Agent → established
catalogue → Agent Zero. Its launch form already says model access must be
configured before a task. However, the unchecked managed-credit option said
“On connect” and “your fork,” even though Agent Zero and OpenClaw have no
connect step. The current launch route and provisioner configure their optional
managed model at launch; Aeon defers configuration to GitHub connection.

## Change and local verification

The form now distinguishes launch-time setup for Agent Zero/OpenClaw from
Aeon's GitHub connection. It explains that leaving the option unchecked means
configuring a provider in the native dashboard before running a task. The
onboarding skill informed this explicit next step; no tour, synthetic progress,
tracking, credential collection or default opt-in was added.

- WelcomeFlow suite: 71 passed, 6 pre-existing skipped; three new cases cover
  Agent Zero, OpenClaw and Aeon, including the unchecked default.
- Scoped ESLint: zero errors; two existing warnings (unused Link and
  selectedPersonaId callback dependency), outside this edit.
- Full TypeScript check and `git diff --check`: passed.
- `verify:plan --risk normal`: focused checks plus Canary sanity check.

## Release and acceptance

Canary project verified as `prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`, root `dashboard`.
Clean source archive: `/tmp/hivra-canary-model-guidance.AMIcR4`.
WelcomeFlow SHA-256:
`2ef194c98ff49587a283883538a0bc85728e6bc2508adf17f71f1e0e3c3a806c`.
Deployment `dpl_ERAD1PFRkhaYRmBhwtVwvj6naPQM` created with the exact source SHA.
Build reached Ready; explicitly promoted that deployment and verified
`https://canary.hermesos.cloud` resolves to it. In the same logged-in root-path
Mac app, used native Refresh, then inspected Agent Zero, OpenClaw and Aeon via
their actual catalogue buttons. All three rendered the correct guidance and
unchecked billing option. Agent Zero and OpenClaw describe launch-time model
configuration; Aeon describes GitHub connection. No launch was submitted.
Returned the app to Computers. PASS for this presentation workflow only.
Rollback target: `dpl_5B6Mp9xMfwRUm4JnhybmSnyRNTyW`; not exercised.

## Preservation and limits

No launch submitted, checkbox enabled, key entered, model prompt sent, or
existing computer changed. Catalogue inspection changes the local welcome
selection to Aeon; no guest setting is affected. No additional Hetzner capacity or spend reservation;
campaign reservations remain GBP 5.90 of GBP 10, not invoice totals. This
guidance fix does not establish model inference, whole-catalog launch, Windows,
Omarchy or full-goal acceptance.
