# Dashboard PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hermes dashboard installable as a PWA and harden the dashboard shell/pages for mobile use without introducing risky offline caching for authenticated flows.

**Architecture:** Add App Router PWA metadata and generated icon endpoints, register a minimal service worker, surface a lightweight in-app install prompt in the dashboard shell, and centralize page-shell spacing so key dashboard routes share the same safe-area-aware mobile wrapper.

**Tech Stack:** Next.js 16 App Router, React 19, Jest, Testing Library, next/og ImageResponse, existing dashboard layout/components.

---

### Task 1: Lock in Regression Tests First

**Files:**
- Create: `dashboard/src/app/__tests__/manifest.test.ts`
- Create: `dashboard/src/components/pwa/__tests__/PwaInstallPrompt.test.tsx`
- Modify: `dashboard/src/app/dashboard/analytics/__tests__/page.test.tsx`

- [ ] **Step 1: Write the failing manifest test**
- [ ] **Step 2: Run the manifest test to verify it fails because the manifest route does not exist yet**
- [ ] **Step 3: Write the failing install prompt test**
- [ ] **Step 4: Run the install prompt test to verify it fails because the prompt component does not exist yet**
- [ ] **Step 5: Extend the analytics page test to require the shared page shell wrapper**
- [ ] **Step 6: Run the analytics test to verify it fails on the missing wrapper**

### Task 2: Add PWA Metadata and Safe Icon Routes

**Files:**
- Create: `dashboard/src/app/manifest.ts`
- Create: `dashboard/src/app/pwa-icon-192/route.tsx`
- Create: `dashboard/src/app/pwa-icon-512/route.tsx`
- Create: `dashboard/src/app/apple-touch-icon/route.tsx`
- Modify: `dashboard/src/app/layout.tsx`

- [ ] **Step 1: Implement the manifest route with Hermes branding, dashboard start URL, shortcuts, and install metadata**
- [ ] **Step 2: Implement generated icon routes with stable PNG outputs sized for install flows**
- [ ] **Step 3: Add Apple web app metadata to the root layout without changing existing SEO metadata**
- [ ] **Step 4: Run the manifest test to verify it passes**

### Task 3: Add Minimal Service Worker and In-App Install UX

**Files:**
- Create: `dashboard/public/sw.js`
- Create: `dashboard/src/components/pwa/PwaInstallPrompt.tsx`
- Create: `dashboard/src/components/pwa/ServiceWorkerRegistration.tsx`
- Modify: `dashboard/src/components/layout/ClientLayoutWrapper.tsx`
- Modify: `dashboard/next.config.ts`

- [ ] **Step 1: Implement a minimal service worker with install/activate handlers and no broad fetch caching**
- [ ] **Step 2: Register the service worker from a client component**
- [ ] **Step 3: Implement the install prompt component using `beforeinstallprompt`, `appinstalled`, and iOS fallback guidance**
- [ ] **Step 4: Mount the install components in the dashboard shell**
- [ ] **Step 5: Add explicit `/sw.js` response headers in Next config**
- [ ] **Step 6: Run the install prompt test to verify it passes**

### Task 4: Centralize Mobile Dashboard Spacing

**Files:**
- Create: `dashboard/src/components/layout/DashboardPageShell.tsx`
- Modify: `dashboard/src/app/dashboard/analytics/page.tsx`
- Modify: `dashboard/src/app/dashboard/skills/page.tsx`
- Modify: `dashboard/src/app/dashboard/settings/page.tsx`
- Modify: `dashboard/src/app/dashboard/scheduled-tasks/page.tsx`
- Modify: `dashboard/src/app/dashboard/library/page.tsx`
- Modify: `dashboard/src/app/dashboard/ops/page.tsx`

- [ ] **Step 1: Create a shared safe-area-aware dashboard page shell component**
- [ ] **Step 2: Switch the analytics page to the shared shell**
- [ ] **Step 3: Switch the skills page to the shared shell**
- [ ] **Step 4: Switch the settings page to the shared shell**
- [ ] **Step 5: Switch the remaining high-value dashboard pages with brittle outer padding to the shared shell**
- [ ] **Step 6: Run the analytics page test to verify it passes with the shared wrapper**

### Task 5: Full Verification and Release

**Files:**
- Verify only

- [ ] **Step 1: Run targeted Jest tests for the new/updated coverage**
- [ ] **Step 2: Run `npm run lint` in `dashboard/`**
- [ ] **Step 3: Run `npm run build` in `dashboard/`**
- [ ] **Step 4: Start the app and verify the dashboard in a mobile viewport, including install UI and key pages**
- [ ] **Step 5: Review the final diff for scope control and confirm the unrelated health route file is untouched**
- [ ] **Step 6: Commit only the relevant files and push the branch**
