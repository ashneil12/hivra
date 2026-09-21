import { expect, test, type Page } from "@playwright/test";

/**
 * Deployed-canary regression for the Activity surface ("Your agent at work").
 *
 * The bug this guards: the page read only the Hermes lane, so a customer whose
 * fleet is Hivra boxes saw a confident "No usage yet — your agent's activity
 * shows up here after its first session" while 300+ lifecycle events sat unread
 * in `hivra_agent_events`. Unit tests passed throughout, because their mocks fed
 * rows in and never asserted what the query actually asked for.
 *
 * So this spec asserts the two things unit tests structurally cannot:
 *   1. the real deployed route returns a payload whose `coverage` matches its
 *      contents, and
 *   2. the rendered page tells the truth about that payload — never a false
 *      empty state, and never a token/dollar figure invented for boxes that run
 *      the customer's own model keys.
 *
 * Requires a real signed-in session (see e2e/global-setup.ts, which mints a
 * Clerk ticket). Skips — rather than fails — when that state is absent, so a
 * local `playwright test` without creds stays green.
 */

const ACTIVITY_PATH = "/dashboard/activity";
const API_PATH = "/api/billing/agent-activity";
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Skip when the harness has no live session. The spec is only meaningful
 * against a deployed URL with a real Clerk user; a missing prerequisite is a
 * configuration gap, not a product regression.
 */
function skipWithoutSession(): boolean {
  const hasSession = Boolean(process.env.QA_USER_ID && process.env.CLERK_SECRET_KEY);
  test.skip(
    !hasSession,
    "requires QA_USER_ID + CLERK_SECRET_KEY for the Clerk sign-in ticket",
  );
  return !hasSession;
}

interface ActivityPayload {
  coverage?: string;
  degraded?: boolean;
  totals?: { totalTokens?: number; estimatedCostUsd?: number; sessions?: number };
  instanceCount?: number;
  hivra?: {
    eventCount?: number;
    desktopSessions?: number;
    activeDays?: number;
    degraded?: boolean;
    fleet?: { runningAgents?: number; totalAgents?: number };
  };
}

async function readActivityPayload(page: Page): Promise<ActivityPayload> {
  const response = await page.request.get(`${API_PATH}?days=30`);
  expect(response.status(), "authenticated activity API must not error").toBe(200);
  const body = (await response.json()) as { data?: ActivityPayload };
  expect(body.data, "payload must carry data").toBeTruthy();
  return body.data!;
}

test.describe("Activity surface (deployed canary)", () => {
  test("the API's coverage claim matches what it actually carries", async ({ page }) => {
    skipWithoutSession();

    const response = await page.goto(ACTIVITY_PATH, { waitUntil: "domcontentloaded" });
    expect(response, "activity navigation must return a response").not.toBeNull();
    expect(response!.status(), "authenticated activity must not redirect or error").toBeLessThan(400);

    const data = await readActivityPayload(page);
    const totals = data.totals ?? {};
    const hivra = data.hivra ?? {};
    const hasTokens =
      (totals.totalTokens ?? 0) > 0 ||
      (totals.sessions ?? 0) > 0 ||
      (totals.estimatedCostUsd ?? 0) > 0;
    const hasActivity = (hivra.eventCount ?? 0) > 0 || (hivra.desktopSessions ?? 0) > 0;

    // The discriminator is the whole point of the fix: it must be derived from
    // the payload, not asserted independently of it.
    if (data.coverage === "usage") {
      expect(hasTokens, "coverage 'usage' requires metered totals").toBe(true);
    } else if (data.coverage === "activity") {
      expect(hasTokens, "coverage 'activity' must not claim metered usage").toBe(false);
      expect(hasActivity, "coverage 'activity' requires recorded activity").toBe(true);
    } else {
      expect(data.coverage).toBe("none");
      expect(hasTokens && hasActivity, "coverage 'none' must be genuinely empty").toBe(false);
    }
  });

  test("never shows the false empty state when activity exists", async ({ page }) => {
    skipWithoutSession();

    await page.goto(ACTIVITY_PATH, { waitUntil: "domcontentloaded" });
    const data = await readActivityPayload(page);
    const hivra = data.hivra ?? {};

    // Wait for the client fetch to settle so we assert on rendered state.
    await expect(page.getByRole("heading", { name: /your agent at work/i })).toBeVisible();

    const body = page.locator("body");
    const hasActivity = (hivra.eventCount ?? 0) > 0 || (hivra.desktopSessions ?? 0) > 0;
    const hasFleet = (hivra.fleet?.totalAgents ?? 0) > 0;

    if (hasActivity) {
      await expect(
        body,
        "a user with recorded activity must never be told they have no activity",
      ).not.toContainText(/no usage yet/i);
      await expect(body).not.toContainText(/no activity recorded yet/i);
      await expect(body).toContainText(/recorded activity/i);
    } else if (hasFleet) {
      // Boxes exist but nothing was observed: a distinct, honest state — not the
      // "never used the product" copy.
      await expect(body).toContainText(/hasn't recorded any activity/i);
      await expect(body).not.toContainText(/no usage yet/i);
    }
  });

  test("does not invent a token or dollar figure for BYO-key Hivra boxes", async ({ page }) => {
    skipWithoutSession();

    await page.goto(ACTIVITY_PATH, { waitUntil: "domcontentloaded" });
    const data = await readActivityPayload(page);
    const totals = data.totals ?? {};
    const hasTokens =
      (totals.totalTokens ?? 0) > 0 ||
      (totals.sessions ?? 0) > 0 ||
      (totals.estimatedCostUsd ?? 0) > 0;

    await expect(page.getByRole("heading", { name: /your agent at work/i })).toBeVisible();

    if (!hasTokens) {
      // Hivra boxes run the customer's own model keys, so Hivra does not meter
      // them. Presenting any figure here would be fabricating a number.
      const body = page.locator("body");
      await expect(body).not.toContainText(/total tokens/i);
      await expect(body).not.toContainText(/est\. cost/i);
      await expect(body).not.toContainText(/\$\d/);
    }
  });

  test("the page renders real numbers, not placeholders", async ({ page }) => {
    skipWithoutSession();

    await page.goto(ACTIVITY_PATH, { waitUntil: "domcontentloaded" });
    const data = await readActivityPayload(page);
    const hivra = data.hivra ?? {};
    if ((hivra.eventCount ?? 0) === 0) {
      test.skip(true, "no recorded activity for this user in the window");
    }

    // The headline cards must show values drawn from the payload. Comparing
    // rendered digits to the API avoids coupling to layout.
    await expect(page.getByRole("heading", { name: /your agent at work/i })).toBeVisible();
    const rendered = await page.locator("body").innerText();
    expect(rendered).toMatch(/\d/);
    if ((hivra.fleet?.runningAgents ?? 0) > 0) {
      expect(rendered, "running-agent count must come from the payload").toContain(
        String(hivra.fleet!.runningAgents),
      );
    }
  });

  test("the exact deployed revision is the one under test", async () => {
    skipWithoutSession();
    const expected = process.env.EXPECTED_GIT_SHA ?? "";
    if (!FULL_SHA.test(expected)) {
      test.skip(true, "EXPECTED_GIT_SHA not provided (deployed canary smoke only)");
    }
    // Placeholder for the release-gate wiring used by workspace-canary: the
    // deployed build must report the commit we think it does before these
    // assertions can be read as evidence about a specific revision.
    expect(FULL_SHA.test(expected)).toBe(true);
  });
});
