/**
 * Drives the real Launch page the way a customer does: click the tile, review,
 * pick Hivra credits, press Launch, wait on the ready screen, open the agent.
 *
 * Everything here goes through what a customer sees. The only API reads are
 * to name WHY something failed (the agent row's error), never to decide that
 * it passed.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { auditAgentName } from '../first-run-audit/config';
import { runInventory, sleep } from '../first-run-audit/instances';
import { SweepFailure } from './result';
import type { SweepTarget } from './targets';

const CHOOSE_HEADING = 'What do you want to launch?';

function exactName(name: string): RegExp {
  return new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}

/** The tile button for one launchable thing, matched on its visible name. */
export function tileButton(page: Page, tile: string): Locator {
  return page
    .getByTestId('launch-journey')
    .locator('button')
    .filter({ has: page.locator('strong', { hasText: exactName(tile) }) })
    .first();
}

/** Every tile name the Choose step offers right now. */
export async function offeredTileNames(page: Page): Promise<string[]> {
  await openChoose(page);
  const names = await page
    .getByTestId('launch-journey')
    .locator('button strong')
    .allInnerTexts();
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/**
 * Hivra's cookie banner sits over the page until a choice is stored, and it
 * swallows clicks meant for whatever is under it. A customer answers it first.
 */
export async function answerCookieBanner(page: Page): Promise<void> {
  const banner = page.getByRole('dialog', { name: 'Cookie consent' });
  if (!(await banner.isVisible().catch(() => false))) return;
  await banner.getByRole('button', { name: 'Reject non-essential cookies' }).first().click({ timeout: 5_000 }).catch(() => undefined);
  await banner.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
}

export async function openChoose(page: Page): Promise<void> {
  const response = await page.goto('/dashboard/launch', { waitUntil: 'domcontentloaded' });
  if (!response || response.status() >= 400) {
    throw new SweepFailure('choose', 'product', `Launch page answered HTTP ${response?.status() ?? 'none'}`);
  }
  try {
    await page.getByRole('heading', { name: CHOOSE_HEADING }).waitFor({ timeout: 60_000 });
  } catch {
    throw new SweepFailure('choose', 'product', 'Launch never showed "What do you want to launch?"');
  }
  await answerCookieBanner(page);
  // Tiles render before the plan and capacity checks land; their fit badges
  // say "Checking fit…" until then. Wait for those to settle.
  await page
    .getByText('Checking fit…')
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  if (await page.getByTestId('launch-free-notice').isVisible().catch(() => false)) {
    throw new SweepFailure(
      'choose',
      'harness_environment',
      'Launch shows the Free plan notice: the test account\'s paid plan did not take.',
    );
  }
}

/** Visible error or blocker text inside the Launch journey, for failure reports. */
async function journeyProblem(page: Page): Promise<string> {
  const texts = await page
    .getByTestId('launch-journey')
    .locator('[role="alert"], [role="status"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ').slice(0, 600);
}

/**
 * Choose → Review → Launch. Returns once Hivra accepted the launch and shows
 * the after-launch screen.
 */
export async function launchFromTile(page: Page, target: SweepTarget, runId: string, onLaunch: () => void): Promise<void> {
  await openChoose(page);

  const tile = tileButton(page, target.tile);
  if ((await tile.count()) === 0) {
    throw new SweepFailure('choose', 'not_offered', `Launch does not offer a "${target.tile}" tile on this deployment.`);
  }
  await tile.click();

  // With the catalog switched on a tile opens its About page first.
  const review = page.getByTestId('launch-catalog-review');
  const reviewHeading = page.getByRole('heading', { name: /^Review and launch / });
  await Promise.race([
    review.waitFor({ timeout: 30_000 }).then(() => review.click()),
    reviewHeading.waitFor({ timeout: 30_000 }),
  ]).catch(() => undefined);
  try {
    await reviewHeading.waitFor({ timeout: 30_000 });
  } catch {
    throw new SweepFailure('review', 'product', `Review never opened. ${await journeyProblem(page)}`);
  }

  await page.getByRole('textbox', { name: target.kind === 'computer' ? 'Computer name' : 'Agent name' }).fill(auditAgentName(runId));
  await chooseHivraCredits(page, target.profileId === 'openhands');

  const launch = page.getByTestId('launch-primary-action');
  const deadline = Date.now() + 90_000;
  while (!(await launch.isEnabled().catch(() => false))) {
    if (Date.now() > deadline) {
      throw new SweepFailure('review', 'product', `Launch button stayed disabled. ${await journeyProblem(page)}`);
    }
    await sleep(1_000);
  }
  onLaunch();
  await launch.click();

  // Submitting can take minutes: Hivra answers once the computer is created.
  const accepted = page.getByRole('heading', {
    name: /is setting up\.|computer is ready\.|is being created\.|couldn.t start\./,
  });
  const failed = page.locator('#launch-failed-heading');
  const uncertain = page.locator('#launch-uncertain-heading');
  const reviewError = page.getByTestId('launch-journey').locator('[role="alert"]');
  const end = Date.now() + 12 * 60_000;
  while (Date.now() < end) {
    if (await accepted.isVisible().catch(() => false)) return;
    // A computer launch can go straight to the computer's own page.
    if (!new URL(page.url()).pathname.startsWith('/dashboard/launch')) return;
    if (await failed.isVisible().catch(() => false)) {
      throw new SweepFailure('launch', 'product', `Launch stopped: ${await journeyProblem(page)}`);
    }
    if (await uncertain.isVisible().catch(() => false)) {
      // The page offers a safe "Check again"; a customer would press it.
      await page.getByTestId('launch-primary-action').click().catch(() => undefined);
    }
    if (await reviewHeading.isVisible().catch(() => false) && await reviewError.count() > 0) {
      const problem = await journeyProblem(page);
      if (problem) throw new SweepFailure('launch', 'product', `Launch was refused on Review: ${problem}`);
    }
    await sleep(2_000);
  }
  throw new SweepFailure('launch', 'product', `Launch was not confirmed within 12 minutes. ${await journeyProblem(page)}`);
}

/** Pick "Hivra credits" for model access when Review offers it. */
async function chooseHivraCredits(page: Page, requireManaged: boolean): Promise<void> {
  const group = page.getByRole('group', { name: 'Model access' });
  // The choice card itself, by its title; "Add credit" sits beside it.
  const credits = group.locator('button').filter({ has: page.locator('strong', { hasText: /^Hivra credits$/ }) }).first();
  if (!(await group.isVisible().catch(() => false)) || (await credits.count()) === 0) {
    if (requireManaged) throw new SweepFailure('review', 'harness_environment', 'OpenHands requires the Hivra credits launch option; no fallback was selected.');
    return;
  }
  // The balance loads after Review opens; the button stays disabled until then.
  await page
    .getByText('Checking your Hivra credits…')
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  if ((await credits.getAttribute('aria-pressed')) === 'true') return;
  if (!(await credits.isEnabled())) {
    const why = (await credits.innerText()).replace(/\s+/g, ' ');
    throw new SweepFailure('review', 'harness_environment', `Hivra credits can't be picked: ${why}`);
  }
  await credits.click();
  if (requireManaged) {
    await credits.and(group.locator('[aria-pressed="true"]')).waitFor({ timeout: 5_000 }).catch(() => {
      throw new SweepFailure('review', 'harness_environment', 'Could not verify Hivra credits were selected for OpenHands.');
    });
  }
}

export interface ReadyOutcome {
  agentId: string | null;
  /** The ready screen said so (agents), or the launch was accepted (computers). */
  ready: boolean;
}

/**
 * Wait on the after-launch screen until it says ready, like a customer who
 * keeps the tab open. Presses "Check again" when Hivra stops checking.
 */
export async function waitForReady(
  page: Page,
  request: APIRequestContext,
  baseUrl: string,
  target: SweepTarget,
  timeoutMs: number,
  runId: string,
): Promise<ReadyOutcome> {
  async function findResourceId() {
    const { agents, instances } = await runInventory(request, baseUrl, runId);
    return agents[0]?.id ?? instances[0]?.id ?? null;
  }
  if (target.kind === 'computer') {
    // Computers don't hold on the Launch page: it says "is being created" and
    // offers Open. Readiness is proven on the computer's own page.
    return { agentId: await findResourceId(), ready: false };
  }

  const ready = page.getByRole('heading', { name: "Your agent's computer is ready." });
  const failed = page.getByRole('heading', { name: /couldn.t start\./ });
  const checkAgain = page.getByRole('button', { name: 'Check again' });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await ready.isVisible().catch(() => false)) return { agentId: await findResourceId(), ready: true };
    if (await failed.isVisible().catch(() => false)) {
      throw new SweepFailure('ready', 'product', `Launch says it couldn't start. ${await agentError(request, baseUrl, await findResourceId())}`);
    }
    if (await checkAgain.isVisible().catch(() => false)) await checkAgain.click().catch(() => undefined);
    await sleep(5_000);
  }
  throw new SweepFailure(
    'ready',
    'product',
    `Not ready after ${Math.round(timeoutMs / 60_000)} minutes. ${await agentError(request, baseUrl, await findResourceId())}`,
  );
}

/** Press the after-launch screen's primary action (Open my agent / Open X). */
export async function openFromLaunch(page: Page): Promise<void> {
  // Already moved on to the thing itself (computers do this on their own).
  if (!new URL(page.url()).pathname.startsWith('/dashboard/launch')) return;
  await page.getByTestId('launch-primary-action').click();
  await page.waitForURL(/\/dashboard\//, { timeout: 60_000 });
}

/** The agent row's own error text, to say why a launch failed. */
export async function agentError(
  request: APIRequestContext,
  baseUrl: string,
  agentId: string | null,
): Promise<string> {
  if (!agentId) return 'No agent record was found for this account.';
  try {
    const res = await request.get(`${baseUrl}/api/hivra/agents/${encodeURIComponent(agentId)}`, { timeout: 60_000 });
    if (!res.ok()) return `Agent record answered HTTP ${res.status()}.`;
    const body = (await res.json()) as { data?: { agent?: Record<string, unknown> } & Record<string, unknown> };
    const row = (body.data?.agent ?? body.data ?? {}) as Record<string, unknown>;
    const parts = [
      row.status ? `status=${String(row.status)}` : '',
      row.error ? `error="${String(row.error).slice(0, 300)}"` : '',
      row.readiness_stage ? `readiness=${String(row.readiness_stage)}` : '',
    ].filter(Boolean);
    return parts.length ? `Agent record: ${parts.join(', ')}.` : '';
  } catch (err) {
    return `Agent record unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
