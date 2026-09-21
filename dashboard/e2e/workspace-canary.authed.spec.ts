import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";

const REQUIRED_MODE = process.env.REQUIRE_WORKSPACE_CANARY === "1";
const EXPECTED_GIT_SHA = process.env.EXPECTED_GIT_SHA ?? "";
const WORKSPACE_PATH = "/dashboard/workspace";
const SELECTION_KEY = "hivra.workspace.last-selection";
const FULL_SHA = /^[0-9a-f]{40}$/;
const AGENT_HANDOFF_SETTLE_MS = 12_000;
const HANDOFF_POLL_INTERVAL_MS = 250;

function authenticatedStorageExists(): boolean {
  try {
    const state = JSON.parse(readFileSync("e2e/.auth/qa-user.json", "utf8")) as {
      cookies?: unknown[];
    };
    return (state.cookies?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function requireReleaseInputs(): void {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY is required for the deployed canary smoke");
  }
  if (!process.env.QA_USER_ID) {
    throw new Error("QA_USER_ID is required for the deployed canary smoke");
  }
  if (!FULL_SHA.test(EXPECTED_GIT_SHA)) {
    throw new Error("EXPECTED_GIT_SHA must be the exact full lowercase Git SHA");
  }
  if (!authenticatedStorageExists()) {
    throw new Error("Required Clerk QA authentication state was not created");
  }
}

async function openWorkspace(page: Page): Promise<void> {
  const response = await page.goto(WORKSPACE_PATH, {
    waitUntil: "domcontentloaded",
  });
  expect(response, "workspace navigation must return a response").not.toBeNull();
  expect(response!.status(), "authenticated workspace must not redirect or error").toBeLessThan(400);
  await expect(page.getByTestId("unified-workspace")).toBeVisible();
  await expect(page.getByText("Loading your agents…")).toHaveCount(0, {
    timeout: 30_000,
  });
}

async function loadedAgentOptions(page: Page) {
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 30_000 });
  expect(await options.count(), "the QA account must contain loaded agents").toBeGreaterThan(0);
  return options;
}

async function selectOption(page: Page, index: number): Promise<string> {
  const options = await loadedAgentOptions(page);
  await options.nth(index).click();
  await expect(options.nth(index)).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("main").getByRole("heading", { level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Opening", { exact: false })).toHaveCount(0, {
    timeout: 30_000,
  });
  const uid = new URL(page.url()).searchParams.get("agent");
  expect(uid, "selected agent must be encoded in the workspace URL").toMatch(
    /^[hx]-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  );
  return uid!;
}

async function openGuide(page: Page) {
  await page.getByRole("button", { name: "Open test guide" }).click();
  const dialog = page.getByRole("dialog", { name: "Canary test guide" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Loading current agent evidence…")).toHaveCount(0, {
    timeout: 45_000,
  });
  return dialog;
}

type ComposerKind = "hivra_composer" | "hermes_iframe_composer";

type AgentWorkflowEvidence = {
  uid: string;
  outcome: string;
  detail?: string;
  elapsedMs: number;
};

type ComposerProbe =
  | {
      kind: "composer";
      outcome: ComposerKind;
      composer: Locator;
    }
  | {
      kind: "terminal";
      outcome: string;
      detail?: string;
    }
  | {
      kind: "waiting";
      detail: string;
    };

type RealWorkflow = {
  uid: string;
  surfaceLabel: string;
  composerKind: ComposerKind;
  composer: Locator;
  evidence: AgentWorkflowEvidence[];
  sendPrompt: (prompt: string) => Promise<string>;
};

type WorkflowDiscoveryOptions = {
  settleWindowMs?: number;
  pollIntervalMs?: number;
};

async function visible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

async function readWebuiDiagnosticCode(page: Page): Promise<string | null> {
  const diagnostics = page.getByTestId("webui-panel-diagnostics");
  if (!(await visible(diagnostics))) return null;

  const code = (await diagnostics.innerText().catch(() => ""))
    .split("\n", 1)[0]
    ?.split("·", 1)[0]
    ?.trim()
    .split(/\s+/, 1)[0];
  return code || null;
}

async function probeSelectedComposer(page: Page): Promise<ComposerProbe> {
  const hivraComposer = page.locator('textarea[placeholder^="Message "]');
  if (await visible(hivraComposer)) {
    return {
      kind: "composer",
      outcome: "hivra_composer",
      composer: hivraComposer,
    };
  }

  const iframe = page.locator('iframe[title="Workspace"]');
  if (await visible(iframe)) {
    const hermesComposer = page
      .frameLocator('iframe[title="Workspace"]')
      .getByRole("textbox", { name: "Message", exact: true });
    const composerCount = await hermesComposer.count().catch(() => 0);
    const contenteditable = composerCount
      ? await hermesComposer.getAttribute("contenteditable").catch(() => null)
      : null;
    if (
      (contenteditable === "" || contenteditable === "true") &&
      (await visible(hermesComposer))
    ) {
      return {
        kind: "composer",
        outcome: "hermes_iframe_composer",
        composer: hermesComposer,
      };
    }
  }

  const errorState = page.getByTestId("webui-error-state");
  if (await visible(errorState)) {
    return {
      kind: "terminal",
      outcome: (await readWebuiDiagnosticCode(page)) ?? "webui_error",
    };
  }

  const repairingState = page.getByTestId("webui-repairing-state");
  if (await visible(repairingState)) {
    return {
      kind: "terminal",
      outcome: (await readWebuiDiagnosticCode(page)) ?? "webui_repairing",
    };
  }

  const stoppedState = page.getByTestId("webui-stopped-state");
  if (await visible(stoppedState)) {
    return {
      kind: "terminal",
      outcome: "webui_stopped",
      detail: (await stoppedState.getAttribute("data-variant")) ?? "unknown",
    };
  }

  if (await visible(page.getByRole("status", { name: "Connecting" }))) {
    return { kind: "waiting", detail: "connecting" };
  }
  if (await visible(page.getByRole("status", { name: "Preparing your workspace" }))) {
    return { kind: "waiting", detail: "preparing" };
  }
  if (await visible(iframe)) {
    return { kind: "waiting", detail: "hermes_iframe_without_composer" };
  }
  return { kind: "waiting", detail: "no_composer_state" };
}

async function waitForSelectedComposer(
  page: Page,
  uid: string,
  settleWindowMs: number,
  pollIntervalMs: number,
): Promise<
  | {
      probe: Extract<ComposerProbe, { kind: "composer" }>;
      evidence: AgentWorkflowEvidence;
    }
  | {
      probe: null;
      evidence: AgentWorkflowEvidence;
    }
> {
  const startedAt = Date.now();
  let lastWaitingDetail = "no_composer_state";

  while (true) {
    const probe = await probeSelectedComposer(page);
    const elapsedMs = Date.now() - startedAt;
    if (probe.kind === "composer") {
      return {
        probe,
        evidence: { uid, outcome: probe.outcome, elapsedMs },
      };
    }
    if (probe.kind === "terminal") {
      return {
        probe: null,
        evidence: {
          uid,
          outcome: probe.outcome,
          detail: probe.detail,
          elapsedMs,
        },
      };
    }

    lastWaitingDetail = probe.detail;
    if (elapsedMs >= settleWindowMs) {
      return {
        probe: null,
        evidence: {
          uid,
          outcome: "timeout",
          detail: lastWaitingDetail,
          elapsedMs,
        },
      };
    }

    await page.waitForTimeout(
      Math.min(pollIntervalMs, Math.max(1, settleWindowMs - elapsedMs)),
    );
  }
}

function formatWorkflowEvidence(evidence: AgentWorkflowEvidence[]): string {
  return evidence
    .map(
      ({ uid, outcome, detail, elapsedMs }) =>
        `${uid}=${outcome}${detail ? `(${detail})` : ""} after ${elapsedMs}ms`,
    )
    .join("; ");
}

function createHivraWorkflow(
  page: Page,
  uid: string,
  surfaceLabel: string,
  composer: Locator,
  evidence: AgentWorkflowEvidence[],
): RealWorkflow {
  return {
    uid,
    surfaceLabel,
    composerKind: "hivra_composer",
    composer,
    evidence,
    sendPrompt: async (prompt) => {
      const messages = page.locator(".hivra-md");
      const beforeCount = await messages.count();

      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect(page.getByText(prompt, { exact: true })).toBeVisible();
      await expect
        .poll(() => messages.count(), {
          timeout: 90_000,
          message: "a real Hivra assistant response must be added after the user message",
        })
        .toBeGreaterThanOrEqual(beforeCount + 2);
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible({
        timeout: 90_000,
      });

      return messages.last().innerText();
    },
  };
}

function createHermesWorkflow(
  page: Page,
  uid: string,
  surfaceLabel: string,
  composer: Locator,
  evidence: AgentWorkflowEvidence[],
): RealWorkflow {
  return {
    uid,
    surfaceLabel,
    composerKind: "hermes_iframe_composer",
    composer,
    evidence,
    sendPrompt: async (prompt) => {
      const frame = page.frameLocator('iframe[title="Workspace"]');
      const userMessages = frame.locator('[data-role="user"]');
      const assistantMessages = frame.locator('[data-role="assistant"]');
      const beforeAssistantCount = await assistantMessages.count();

      await composer.fill(prompt);
      await composer.press("Enter");
      await expect(userMessages.filter({ hasText: prompt }).last()).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(() => assistantMessages.count(), {
          timeout: 90_000,
          message: "a real Hermes assistant response must be added after the user message",
        })
        .toBeGreaterThan(beforeAssistantCount);
      await expect(composer).toBeVisible({ timeout: 90_000 });

      return assistantMessages.last().innerText();
    },
  };
}

async function selectAgentWithRealWorkflow(
  page: Page,
  options: WorkflowDiscoveryOptions = {},
): Promise<RealWorkflow> {
  const settleWindowMs = options.settleWindowMs ?? AGENT_HANDOFF_SETTLE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? HANDOFF_POLL_INTERVAL_MS;
  const loadedOptions = await loadedAgentOptions(page);
  const count = await loadedOptions.count();
  const evidence: AgentWorkflowEvidence[] = [];

  for (let index = 0; index < count; index += 1) {
    const uid = await selectOption(page, index);
    const surfaces = page.locator(
      '[role="tab"]:not([aria-label="Conversation"]):not([aria-disabled="true"])',
    );
    const settled = await waitForSelectedComposer(
      page,
      uid,
      settleWindowMs,
      pollIntervalMs,
    );
    evidence.push(settled.evidence);
    if (!settled.probe) continue;

    const surfaceLabel = await surfaces.first().getAttribute("aria-label");
    if (!surfaceLabel) {
      evidence[evidence.length - 1] = {
        uid,
        outcome: `${settled.probe.outcome}_without_advertised_surface`,
        elapsedMs: settled.evidence.elapsedMs,
      };
      continue;
    }

    return settled.probe.outcome === "hivra_composer"
      ? createHivraWorkflow(page, uid, surfaceLabel, settled.probe.composer, evidence)
      : createHermesWorkflow(page, uid, surfaceLabel, settled.probe.composer, evidence);
  }

  throw new Error(
    `Required QA account has no agent with a real conversation composer and advertised surface. Terminal evidence: ${formatWorkflowEvidence(evidence)}`,
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
}

async function invalidateSelectedDetail(route: Route, uid: string): Promise<void> {
  const response = await route.fetch();
  const body = (await response.json()) as Record<string, unknown>;
  if (uid.startsWith("h-")) {
    const data = body.data as Record<string, unknown> | undefined;
    if (!data) throw new Error("Hermes detail response did not contain data");
    data.status = "deleted";
  } else {
    const agent = body.agent as Record<string, unknown> | undefined;
    if (!agent) throw new Error("Hivra detail response did not contain agent");
    agent.status = "deleted";
  }
  await route.fulfill({ response, json: body });
}

test.describe("workspace composer discovery driver", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("recognizes a ready top-level Hivra composer", async ({ page }) => {
    await page.route("https://driver.test/workspace*", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `
          <main>
            <h1>Hivra fixture</h1>
            <div role="listbox">
              <button role="option" aria-selected="true">Hivra fixture</button>
            </div>
            <button role="tab" aria-label="Files">Files</button>
            <textarea placeholder="Message Hivra fixture"></textarea>
          </main>
        `,
      });
    });
    await page.goto("https://driver.test/workspace?agent=x-fixture");

    await expect(selectAgentWithRealWorkflow(page)).resolves.toMatchObject({
      uid: "x-fixture",
      composerKind: "hivra_composer",
      evidence: [expect.objectContaining({ outcome: "hivra_composer" })],
    });
  });

  test("recognizes a ready Hermes contenteditable composer inside the workspace iframe", async ({
    page,
  }) => {
    await page.route("https://driver.test/workspace*", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `
          <main>
            <h1>Hermes fixture</h1>
            <div role="listbox">
              <button role="option" aria-selected="true">Hermes fixture</button>
            </div>
            <button role="tab" aria-label="Files">Files</button>
            <iframe
              title="Workspace"
              srcdoc='<div role="textbox" aria-label="Message" contenteditable="true"></div>'
            ></iframe>
          </main>
        `,
      });
    });
    await page.goto("https://driver.test/workspace?agent=h-fixture");

    await expect(selectAgentWithRealWorkflow(page)).resolves.toMatchObject({
      uid: "h-fixture",
      composerKind: "hermes_iframe_composer",
      evidence: [expect.objectContaining({ outcome: "hermes_iframe_composer" })],
    });
  });

  test("waits per agent and reports timeout plus exact WebUI terminal diagnostics", async ({
    page,
  }) => {
    await page.route("https://driver.test/workspace*", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `
          <main>
            <h1>Hermes fixtures</h1>
            <div role="listbox">
              <button role="option" data-uid="h-connecting">Connecting fixture</button>
              <button role="option" data-uid="h-broken">Broken fixture</button>
            </div>
            <button role="tab" aria-label="Files">Files</button>
            <div id="conversation"></div>
          </main>
          <script>
            const options = [...document.querySelectorAll('[role="option"]')];
            const conversation = document.querySelector('#conversation');
            for (const option of options) {
              option.addEventListener('click', () => {
                for (const candidate of options) {
                  candidate.setAttribute('aria-selected', String(candidate === option));
                }
                history.replaceState(null, '', '?agent=' + option.dataset.uid);
                conversation.innerHTML = option.dataset.uid === 'h-connecting'
                  ? '<div role="status" aria-label="Connecting">Connecting…</div>'
                  : '<div data-testid="webui-error-state"><div data-testid="webui-panel-diagnostics">http_400\\n<button>Copy details</button></div><button>Retry</button></div>';
              });
            }
          </script>
        `,
      });
    });
    await page.goto("https://driver.test/workspace?agent=h-connecting");
    const startedAt = Date.now();

    await expect(
      selectAgentWithRealWorkflow(page, {
        settleWindowMs: 120,
        pollIntervalMs: 20,
      }),
    ).rejects.toThrow(
      /h-connecting=timeout\(connecting\) after \d+ms; h-broken=http_400 after \d+ms/,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });
});

const deployed = REQUIRED_MODE ? test.describe : test.describe.skip;

deployed("required exact-revision Hivra workspace canary", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    requireReleaseInputs();
  });

  test("proves exact revision, all-agent matrix, and mixed-agent isolation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page);
    const options = await loadedAgentOptions(page);
    const loadedCount = await options.count();
    expect(loadedCount, "mixed-agent isolation requires two loaded agents").toBeGreaterThanOrEqual(2);

    const firstUid = await selectOption(page, 0);
    const dialog = await openGuide(page);
    await expect(dialog.getByText(EXPECTED_GIT_SHA, { exact: true })).toBeVisible();
    await expect(dialog.getByText("production", { exact: true })).toBeVisible();

    const rows = dialog.locator('[data-testid^="release-capability-"]');
    await expect(rows).toHaveCount(loadedCount);
    expect(
      await rows.locator("td", { hasText: "Ready" }).count(),
      "the safe matrix must contain at least one real advertised surface",
    ).toBeGreaterThan(0);

    for (let index = 0; index < loadedCount; index += 1) {
      const row = rows.nth(index);
      const detailText = await row.locator("th").innerText();
      if (/Detail unknown/i.test(detailText)) {
        const cells = await row.locator("td").allInnerTexts();
        expect(cells.length).toBeGreaterThan(0);
        expect(cells.every((cell) => /Unknown/i.test(cell))).toBe(true);
        expect(cells.some((cell) => /Ready/i.test(cell))).toBe(false);
      }
    }
    await dialog.getByRole("button", { name: "Close test guide" }).click();

    const secondUid = await selectOption(page, 1);
    expect(secondUid).not.toBe(firstUid);
    expect(
      await page.locator("[data-agent-boundary]").getAttribute("data-agent-boundary"),
    ).not.toBe(firstUid);
    await selectOption(page, 0);
    expect(new URL(page.url()).searchParams.get("agent")).toBe(firstUid);
    expect(
      await page.locator("[data-agent-boundary]").getAttribute("data-agent-boundary"),
    ).not.toBe(secondUid);

    await expect(page.getByTestId("agent-rail")).toBeVisible();
    await expect(page.getByTestId("workspace-conversation")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("sends one real message, opens a real surface, and restores it on refresh", async ({
    page,
  }) => {
    test.setTimeout(210_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page);
    const workflow = await selectAgentWithRealWorkflow(page);
    const { uid, surfaceLabel } = workflow;
    const prompt = "Reply with the single word CANARY.";

    const responseText = await workflow.sendPrompt(prompt);
    expect(responseText.trim()).not.toBe("");
    expect(responseText).not.toMatch(/^thinking…$/i);

    const surface = page.getByRole("tab", { name: surfaceLabel, exact: true });
    await surface.click();
    await expect(page.getByTestId("surface-frame")).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get("agent")).toBe(uid);
    expect(new URL(page.url()).searchParams.get("surface")).not.toBe("conversation");
    await page.getByRole("button", { name: "Back to conversation" }).click();
    await expect(page.getByTestId("surface-frame")).toHaveCount(0);

    await surface.click();
    const selectedSurface = new URL(page.url()).searchParams.get("surface");
    expect(selectedSurface).not.toBe("conversation");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("surface-frame")).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get("agent")).toBe(uid);
    expect(new URL(page.url()).searchParams.get("surface")).toBe(selectedSurface);
    await page.getByRole("button", { name: "Back to conversation" }).click();
  });

  test("proves narrow layout, manifest/service worker/install guidance, and fresh standalone revalidation", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openWorkspace(page);
    const workflow = await selectAgentWithRealWorkflow(page);
    const { uid, surfaceLabel } = workflow;

    await expect(page.getByRole("button", { name: "Choose agent" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Agent surfaces" })).toBeVisible();
    await expect(workflow.composer).toBeVisible();
    const firstTabBox = await page.getByRole("tab").first().boundingBox();
    expect(firstTabBox).not.toBeNull();
    expect(firstTabBox!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);

    const transitionDuration = await page.getByRole("tab").first().evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    );
    expect(transitionDuration).toBe("0s");

    const manifestResponse = await page.request.get("/manifest.webmanifest");
    expect(manifestResponse.status()).toBe(200);
    const manifest = (await manifestResponse.json()) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      scope?: string;
      display?: string;
      orientation?: string;
      shortcuts?: Array<{ name?: string; url?: string }>;
    };
    expect(manifest).toMatchObject({
      name: "Hivra",
      short_name: "Hivra",
      start_url: WORKSPACE_PATH,
      scope: "/dashboard/",
      display: "standalone",
    });
    expect(manifest).not.toHaveProperty("orientation");
    expect(manifest.shortcuts).toContainEqual(
      expect.objectContaining({ name: "Workspace", url: WORKSPACE_PATH }),
    );

    const workerResponse = await page.request.get("/sw.js");
    expect(workerResponse.status()).toBe(200);
    const worker = await workerResponse.text();
    expect(worker).toContain('const PRECACHE_URLS = [OFFLINE_URL]');
    expect(worker).toContain('"/dashboard"');
    expect(worker).toContain('"/api"');
    expect(worker).not.toMatch(/PRECACHE_URLS\s*=\s*\[[^\]]*dashboard/s);
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const registrations = await navigator.serviceWorker.getRegistrations();
            return registrations.some((registration) =>
              registration.active?.scriptURL.endsWith("/sw.js"),
            );
          }),
        { timeout: 30_000 },
      )
      .toBe(true);

    const guide = await openGuide(page);
    await expect(guide.getByRole("heading", { name: "Install Hivra on Mac" })).toBeVisible();
    await expect(guide.getByText(/Safari on Mac:.*Add to Dock/i)).toBeVisible();
    await expect(guide.getByText(/Chrome or Edge on Mac:.*Install Hivra/i)).toBeVisible();
    await guide.getByRole("button", { name: "Close test guide" }).click();

    const surface = page.getByRole("tab", { name: surfaceLabel, exact: true });
    await surface.click();
    const selectedSurface = new URL(page.url()).searchParams.get("surface");
    expect(selectedSurface).toMatch(/^(?:workspace|files|git|terminal|browser|desktop|native)$/);
    await page.evaluate(
      ({ key, selectedUid, selectedSurfaceValue }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 1,
            uid: selectedUid,
            surface: selectedSurfaceValue,
          }),
        );
      },
      { key: SELECTION_KEY, selectedUid: uid, selectedSurfaceValue: selectedSurface! },
    );

    const fresh = await page.context().newPage();
    await fresh.addInitScript(() => {
      const originalMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        if (query !== "(display-mode: standalone)") return originalMatchMedia(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => true,
        } as MediaQueryList;
      };
    });
    await fresh.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const rawId = encodeURIComponent(uid.slice(2));
      const hermesDetail = `/api/instances/${rawId}`;
      const hivraDetail = `/api/hivra/agents/${rawId}`;
      if (url.pathname === hermesDetail || url.pathname === hivraDetail) {
        await invalidateSelectedDetail(route, uid);
        return;
      }
      await route.continue();
    });

    const freshResponse = await fresh.goto(manifest.start_url!, {
      waitUntil: "domcontentloaded",
    });
    expect(freshResponse?.status()).toBeLessThan(400);
    await expect(fresh.getByTestId("unified-workspace")).toBeVisible();
    await expect(
      fresh.getByText(
        "Your saved workspace could not be verified. Conversation opened instead when available.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 45_000 });
    expect(new URL(fresh.url()).searchParams.get("agent")).toBe(uid);
    expect(new URL(fresh.url()).searchParams.get("surface")).toBe("conversation");
    expect(await fresh.evaluate((key) => localStorage.getItem(key), SELECTION_KEY)).toBeNull();
    await fresh.close();
  });
});
