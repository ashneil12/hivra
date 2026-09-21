# Self-Service Agent Zero Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Power customer safely reduce an existing Hermes instance's allocation and launch Agent Zero from the same Advanced Console flow.

**Architecture:** Add an owner-scoped orchestration API that reads the authoritative subscription and existing allocation, validates a requested target size, performs the instance resize through the existing resize path, and creates the Agent Zero agent through the existing Hivra route/service. The console gets a Resources tab that renders the pool and calls the orchestration API only after clear confirmation.

**Tech Stack:** Next.js route handlers, Supabase, Proxmox instance service, React, Jest.

---

### Task 1: Backend orchestration

- [ ] Add focused owner, entitlement, resize failure, and successful launch tests.
- [ ] Implement minimal server-only orchestration using existing resize and Hivra provisioning paths.
- [ ] Run focused tests and commit.

### Task 2: Advanced Console Resources UI

- [ ] Add a Resources tab and confirmation flow test.
- [ ] Implement the pool display, explicit Pike resize notice, confirmation, and Agent Zero launch result.
- [ ] Run focused UI tests and commit.

### Task 3: Verification and release

- [ ] Run focused API/UI tests and normal-risk dashboard verification.
- [ ] Commit, push canary, deploy production, and verify health.
