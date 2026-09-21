# PWA Core Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed Hermes OS PWA feel like a polished daily-use app for chat/workspace access, navigation, status/recovery, and Hermes WebUI handoff without trying to force perfect mobile parity across every dense desktop admin page.

**Architecture:** Keep the existing minimal service worker and no-auth-cache posture. Update manifest/start metadata so installed launches prioritize the active workspace, add a small app-style mobile/PWA navigation component in the dashboard shell, and harden WebUI iframe fallback/navigation affordances for constrained screens. Avoid changing billing/wallet/console business logic in this pass.

**Tech Stack:** Next.js 16 App Router, React 19, Jest, Testing Library, existing dashboard shell/components, minimal vanilla CSS/media queries.

---

### Task 1: Regression Tests for PWA App Shell

**Files:**
- Modify: `dashboard/src/app/__tests__/manifest.test.ts`
- Modify: `dashboard/src/components/layout/__tests__/ClientLayoutWrapper.test.tsx`
- Create: `dashboard/src/components/pwa/__tests__/PwaBottomNavigation.test.tsx`

- [x] **Step 1: Write failing manifest assertions**
  - Assert `start_url` points at the workspace/chat resolver.
  - Assert manifest shortcuts expose Chat, Command Center, Wallet, and Billing.

- [x] **Step 2: Write failing app-shell assertions**
  - Assert dashboard layout renders the service worker registration.
  - Assert mobile/PWA bottom navigation renders core destinations on normal dashboard pages.
  - Assert bottom navigation is suppressed on full-screen instance surfaces that already own their navigation.

- [x] **Step 3: Run targeted tests and confirm failure**
  - Run: `cd dashboard && npm test -- --runTestsByPath src/app/__tests__/manifest.test.ts src/components/layout/__tests__/ClientLayoutWrapper.test.tsx src/components/pwa/__tests__/PwaBottomNavigation.test.tsx --runInBand`

### Task 2: Implement PWA Navigation and Launch Behavior

**Files:**
- Modify: `dashboard/src/app/manifest.ts`
- Create: `dashboard/src/components/pwa/PwaBottomNavigation.tsx`
- Modify: `dashboard/src/components/layout/ClientLayoutWrapper.tsx`

- [x] **Step 1: Update manifest**
  - Set installed start URL to `/dashboard/chat`.
  - Add shortcuts for Command Center, Wallet, Billing, and Chat.

- [x] **Step 2: Add bottom navigation component**
  - Use existing lucide icons and dashboard routes.
  - Keep it fixed, safe-area-aware, mobile-first, and hidden on desktop.
  - Use active route state so navigation feels predictable.

- [x] **Step 3: Mount navigation in shell**
  - Render it for normal dashboard pages.
  - Keep it visible on the default instance WebUI route so installed-app users can still move around the product.
  - Hide it on the dedicated full-screen TUI surface where it would obstruct the terminal workspace.
  - Add bottom padding to the scroll container only when the navigation is visible.

- [x] **Step 4: Run targeted tests and confirm pass**

### Task 3: Harden Hermes WebUI Mobile/PWA Surface

**Files:**
- Modify: `dashboard/src/components/webui/WebuiIframe.tsx`
- Modify: `dashboard/src/components/webui/__tests__/WebuiIframe.test.tsx`

- [x] **Step 1: Write failing WebUI navigation test**
  - Assert loading/error/pending shells include a stable action to open the workspace in a new tab.
  - Assert ready iframes expose mobile-friendly sizing and title/accessibility affordances.

- [x] **Step 2: Implement WebUI action surface**
  - Preserve the current secure login URL flow.
  - Keep inline iframe as the primary path.
  - Ensure loading, pending, and error states expose a reliable "open workspace" action once a URL is available or can be retried.

- [x] **Step 3: Run targeted WebUI tests and confirm pass**

### Task 4: Verification

**Files:**
- Verify only

- [x] **Step 1: Run targeted Jest tests**
- [x] **Step 2: Run focused lint/type/build checks as needed**
- [x] **Step 3: Start local dashboard dev server**
- [x] **Step 4: Use the in-app browser to verify mobile dashboard navigation and Hermes WebUI shell**
  - Local browser access reached the app, but authenticated dashboard routes redirected to sign-in without a logged-in browser session.
  - Verified the public manifest output through the local server; authenticated PWA shell behavior is covered by focused component tests and production build.
- [x] **Step 5: Review final diff for unrelated-file safety**
- [x] **Step 6: Commit only the PWA changes**
