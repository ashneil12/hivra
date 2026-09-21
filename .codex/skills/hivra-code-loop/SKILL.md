---
name: hivra-code-loop
description: Orchestrate iterative code and product-surface work through a target contract, implementation worker, fresh reviewer, and bounded correction loop. Use when a change benefits from explicit delegation and repeated evidence-based review; not for routine one-pass edits or live operations.
---

# Hivra Code Loop

Use this as a code-focused adaptation of Dream Loop. The goal is not endless agent activity; it is measurable convergence on the requested behavior while preserving the repository's authorization, safety, and verification boundaries.

## Model routing

- **Orchestrator:** GPT-5.6 Luna. Own the task contract, delegation, evidence, prioritization, and exit decision. Do not implement the delegated change unless a small integration edit is required.
- **Implementation worker:** GPT-6 Astra at medium effort for architecture, difficult UI, or broad visual/product-surface changes; GPT-5.6 Sol at medium effort for normal implementation, integration, tests, and focused repairs.
- **Reviewer:** a fresh-context Luna reviewer at medium or high effort. It reviews evidence and the diff; it does not edit.
- Never replace these explicit roles with a silent “strongest available model” fallback. If a requested model is unavailable, stop and report the routing gap.

## Loop

1. **Lock the target contract.** State the requested outcome, in-scope files/surfaces, observable acceptance checks, non-goals, and authorization limits. For UI work, capture the current rendered state and define the desired state. For backend work, define request/response, persistence, lifecycle, and failure behavior.
2. **Capture a baseline.** Inspect the current implementation, git state, relevant tests, and the actual failing or existing behavior where safely available. Do not invent a baseline from assumptions or screenshots alone.
3. **Delegate one bounded implementation pass.** Give the worker the user request, target contract, baseline evidence, relevant file paths, and exact write scope. Use a fresh context. Tell it to implement and add the appropriate regression coverage; it must not invoke this skill or broaden the task.
4. **Validate locally.** Run the smallest relevant checks first, then the risk-appropriate tests, typecheck, lint, browser/device check, or performance check. Inspect the rendered/user-facing path when the change is user-facing.
5. **Run a fresh review.** Give the reviewer the target contract, current diff, changed-file list, check results, and before/after evidence. Ask for concrete gaps ranked by severity, including correctness, regressions, accessibility, security, performance, and product intent. The reviewer must distinguish observed failures from unverified claims.
6. **Correct only actionable gaps.** Send the prioritized findings to a new implementation pass with the same write boundary. Re-run validation and review. Preserve unrelated work and do not “fix” a disagreement by weakening a test or hiding an error.
7. **Exit deliberately.** Stop when acceptance checks pass, review finds no material gaps, and remaining uncertainty is recorded. Stop for a rethink when two rounds fail to improve the result or the same root gap repeats. Do not continue cosmetic iterations after the contract is satisfied.

## Evidence rules

- A green build or test is evidence for that check, not proof of deployment, public availability, fleet-wide correctness, or live acceptance.
- For runtime or user-facing changes, separate source checks, deployed revision, public-path behavior, and recovery/lifecycle checks. Use the live-environment-verification skill when live behavior is part of the request.
- Keep screenshots, logs, review notes, and generated loop state under `.dream-loop/` or another explicitly temporary location; do not commit credentials, customer content, or opaque agent claims.
- Do not deploy, publish, spend money, mutate production, merge, or send external messages unless the task explicitly authorizes that exact action.

## Prompt shape

Worker prompt:

> Implement the requested change against this target contract: [contract]. Baseline evidence: [evidence]. You may edit only: [write scope]. Add or update regression coverage. Validate only enough to catch obvious local errors; do not use the orchestration skill, delegate further, deploy, publish, or change unrelated files. Report changed files, checks run, and unresolved uncertainty.

Reviewer prompt:

> Review this implementation against the target contract. Evidence: [before/after, diff, checks]. Do not edit. Rank every actionable gap by severity, name the exact file/symbol or user-visible behavior involved, and distinguish observed failure, likely risk, and unverified path. Confirm which acceptance checks actually passed.
