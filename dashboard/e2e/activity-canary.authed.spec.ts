import { expect, test } from "@playwright/test";
import type { ActivitySnapshot } from "../src/lib/activity-observability/types";

// Real authenticated read-only acceptance. Missing credentials are a reported
// prerequisite, never evidence that a deployed revision passed.
test.describe("Activity observatory (deployed canary)", () => {
  test.beforeEach(() => {
    test.skip(
      !process.env.QA_USER_ID || !process.env.CLERK_SECRET_KEY,
      "requires QA_USER_ID + CLERK_SECRET_KEY for a real signed-in account",
    );
  });
  test("renders the authenticated snapshot, inspector, filters and coverage truthfully", async ({
    page,
  }) => {
    const loaded = page.waitForResponse(
      (response) =>
        response.url().includes("/api/activity?") &&
        response.request().method() === "GET",
    );
    await page.goto("/dashboard/activity", { waitUntil: "domcontentloaded" });
    const response = await loaded;
    expect(response.status()).toBe(200);
    const { data } = (await response.json()) as { data: ActivitySnapshot };
    expect(data.schemaVersion).toBe(1);
    expect(Array.isArray(data.events)).toBe(true);
    expect(Array.isArray(data.resources)).toBe(true);
    expect(Array.isArray(data.sources)).toBe(true);
    const activity = page.getByRole("region", {
      name: "Activity",
      exact: true,
    });
    await expect(
      activity.getByRole("heading", { name: "Activity", exact: true }),
    ).toBeVisible();
    await expect(
      activity.getByRole("button", { name: "History", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(activity).not.toContainText(
      /total tokens|percent complete|stop requested/i,
    );
    if (data.degraded)
      await expect(activity).toContainText(
        "This history may be incomplete",
      );
    if (data.truncated)
      await expect(activity).toContainText(
        "Search and filters only cover these records",
      );
    if (data.events.length) {
      const first = data.events[0];
      await activity
        .getByRole("region", { name: "Recorded events" })
        .getByRole("button")
        .first()
        .click();
      const inspector = activity.getByRole("complementary", {
        name: "Event inspector",
      });
      const technical = inspector.locator("details");
      await expect(technical).not.toHaveAttribute("open", "");
      await expect(inspector.getByText(first.id, { exact: true })).not.toBeVisible();
      if (first.kind === "desktop_session") {
        await expect(inspector.getByRole("heading", { name: "Desktop access allowed" })).toBeVisible();
        await expect(inspector).toContainText("does not confirm that anyone connected");
      }
      await inspector.getByText("Technical details", { exact: true }).click();
      await expect(inspector.getByText(first.id, { exact: true })).toBeVisible();
      await expect(inspector).toContainText(first.source.label);
      for (const evidence of first.evidence)
        await expect(inspector).toContainText(evidence.value);
      await activity
        .getByRole("searchbox")
        .fill("__no_activity_match_fixture__");
      await expect(activity).toContainText("No recorded events match");
      await expect(inspector).toHaveCount(0);
      await activity.getByRole("searchbox").fill("");
      await activity.getByLabel("Filter by agent").selectOption(first.agentId);
      await activity.getByLabel("Filter by kind").selectOption(first.kind);
      await expect(
        activity
          .getByRole("region", { name: "Recorded events" })
          .getByRole("button")
          .first(),
      ).toBeVisible();
    } else {
      await expect(activity).toContainText(
        data.degraded
          ? "No activity was returned by the available history"
          : "No activity was recorded in the last 30 days",
      );
    }
    await activity.getByLabel("Filter by agent").selectOption("all");
    await activity.getByLabel("Filter by kind").selectOption("all");
    await activity.getByRole("button", { name: /Needs attention/ }).click();
    await expect(
      activity
        .getByRole("region", { name: "Recorded events" })
        .getByRole("button"),
    ).toHaveCount(data.events.filter((event) => event.needsAttention).length);
    await activity
      .getByRole("button", { name: "What is monitored", exact: true })
      .click();
    const coverage = activity.getByRole("region", {
      name: "Monitoring coverage",
    });
    for (const source of data.sources) {
      await expect(coverage).toContainText(source.label);
      await expect(coverage).toContainText(source.detail);
    }
    if (data.sources.some((source) => source.state === "missing"))
      await expect(coverage.getByText("No records yet", { exact: true }).first()).toBeVisible();
    if (data.sources.some((source) => source.state === "degraded"))
      await expect(coverage.getByText("Unable to load", { exact: true }).first()).toBeVisible();
    for (const resource of data.resources)
      await expect(coverage).toContainText(resource.name);
    const refreshed = page.waitForResponse(
      (res) =>
        res.url().includes("/api/activity?") &&
        res.request().method() === "GET",
    );
    await activity
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    expect((await refreshed).status()).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(coverage).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
  test("rejects anonymous access to recorded evidence", async ({
    playwright,
    baseURL,
  }) => {
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      expect(
        (await anonymous.get("/api/activity", { maxRedirects: 0 })).status(),
      ).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });
});
