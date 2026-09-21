/**
 * ────────────────────────────────────────────────────────────────────────────
 *  FIRST-RUN AUDIT — the 19/20 gate
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Ash's bar, verbatim:
 *   "new signup → first agent deployed → first real outcome,
 *    working clean 19 out of 20 times, zero manual intervention."
 *
 * This spec is the only test in the repo that PROVISIONS REAL PAID INFRASTRUCTURE.
 * It is double-gated (FIRST_RUN_AUDIT=1 *and* a playwright project that only
 * exists when that env var is set) so it can never fire on an ordinary CI push.
 * See .github/workflows/first-run-audit.yml — workflow_dispatch / label only.
 *
 * ── WHAT "FIRST REAL OUTCOME" MEANS HERE, AND WHY ──────────────────────────
 *
 * A new free user has exactly two deploy paths on the welcome card:
 *
 *   1. Managed (Venice), the default: the deploy mints a Venice proxy key and
 *      seeds providerId+model, so the box boots able to answer.
 *   2. "Bring your own": deploys a CLEAN box — no provider, no model, no key.
 *      The card's own copy says "paste your key from the agent after it's live."
 *
 * WHEN THIS FILE WAS WRITTEN, lane 1 was closed to a virgin free account: an
 * unfunded user was early-returned into a wallet-funding screen, and the starter
 * credit that was supposed to cover them was capped — by a ledger unique index
 * carrying no user_id — at exactly ONE user for the entire system. So there was
 * no path where a brand-new free signup ended with an agent that could answer,
 * and `workspace_interactive` was the honest ceiling.
 *
 * Canary #490 (per-user starter credit), #491 (the minted key binds to the wallet
 * that actually holds the money, and the grant settles BEFORE wallet resolution)
 * and the always-rendered Deploy CTA opened lane 1.
 *
 * `agent_replied` is now REACHABLE. Its old transport (`/api/instances/[id]/send-stream`,
 * a proxy to an endpoint no agent image serves) was retired — there is no HTTP chat
 * surface on a box. Real chat runs over the agent's WebSocket gateway, and the probe
 * now drives the exact Hermes Desktop Web route: the signed handoff (whose
 * `#iframe_token` fragment carries the apiServerKey) → box origin →
 * `wss://<box>/desktop/api/ws?token=<apiServerKey>` →
 * `session.create`/`prompt.submit` → the terminal `message.complete`. Caddy strips
 * the `/desktop` namespace before forwarding to the gateway. See probeAgentReply +
 * agent-chat.ts.
 *
 * The default outcome remains `workspace_interactive` — the narrower, concrete
 * promise that **your agent exists, it booted, and you can sit down and type to it**:
 *
 *   the instance row goes `running`, observed through the PRODUCT's own poll
 *     AND the box's own gateway answers the app's `/health` probe
 *     AND `/api/instances/[id]/webui-login-url` mints a signed workspace handoff
 *     AND the workspace iframe's document loads from the box with a non-error status.
 *
 * That chain proves: Clerk → billing entitlement → abuse gate → placement →
 * Proxmox VM → cloud-init → gateway → sidecar auth bridge → agent process →
 * the chat surface rendering inside the dashboard. Every historical first-run
 * failure this codebase has recorded (gateway crash-loop, apiServerKey drift,
 * hardened-auth 403, grey-cloud probe flip, missing gateway finalization) lands
 * inside it.
 *
 * ── TWO RULES LEARNED FROM THE FIRST PROVING RUN (2026-07-08) ──────────────
 *
 * 1. NEVER GATE ON ANALYTICS. The first cut asserted the workspace loaded by
 *    waiting for the dashboard's own `webui_iframe_loaded` PostHog event. A full
 *    run recorded `posthog_captured: false, funnel: []` and failed at
 *    `workspace_interactive` — reported as a PRODUCT failure, on a box that was
 *    in fact healthy. A harness that blames the product for its own blind spot is
 *    worse than no harness. Telemetry is now captured, recorded, and used for
 *    diagnosis; it never gates. See iframe-watch.ts.
 *
 *    The cause was NOT a missing analytics key, as first believed. posthog-js
 *    silently drops every capture() from a browser it reads as a bot, and stock
 *    Playwright is one on three independent signals (browser-signals.ts). The
 *    funnel is captured again now — but the rule stands on its own merits: the
 *    iframe's own document response is a STRONGER proof than the event, because
 *    `onLoad` fires even when the box serves an error page, so the old gate
 *    would have passed a 502.
 *
 * 2. OBSERVE THE PRODUCT, DON'T PERTURB IT. Readiness is polled through
 *    `GET /api/instances/[id]` — the route the welcome flow polls — NOT through
 *    `/api/instances/[id]/health`. Both promote the row to `running`, but only
 *    the former fires the post-ready SOUL.md reconcile (soul-seed-reconcile.ts,
 *    canary #484). Polling `/health` won the race, flipped the row first, and
 *    deterministically robbed the box of its persona seed: the first proving run
 *    left a freshly-hired "Bea" box running the factory-default Hermes soul.
 *    That was the harness's doing, not the product's.
 *
 * We additionally RECORD `instance.inference_configured` on every run. For a
 * clean-slate deploy that is `false`, and the verdict says so out loud. If 20/20
 * boxes are interactive but 0/20 could answer without the user supplying a key,
 * that is the single most important number in the report — and it is a product
 * decision, not something the harness should paper over.
 *
 * The stricter `agent_replied` outcome requires a real answer from the agent. It
 * stays off by default (it costs a real inference call and only means anything on a
 * box that booted with inference), and is satisfied by driving the agent's
 * `/desktop/api/ws` WebSocket — the surface Hermes Desktop Web actually uses (see
 * probeAgentReply).
 *
 * 3. NEVER TRUST AN HTTP 200 FROM AN SSE PROXY. send-stream returned 200 and put
 *    failures inside the stream. The first `agent_replied` implementation asserted
 *    `body.trim().length > 0`, which an `event: error` frame satisfies — including
 *    the 402-from-an-empty-wallet frame that this outcome exists to catch. Decoding
 *    the frames fixed that; it then revealed that every frame was a 405 from a
 *    route the fleet never served. The lesson survives the route: a probe must
 *    assert on what the agent SAID, and it must run over a transport that exists.
 *
 * ── TEARDOWN IS NOT OPTIONAL ───────────────────────────────────────────────
 * A leaked audit VM is a paid VM and an orphan. Teardown runs in `finally`, then
 * again in afterAll, then again in scripts/first-run-audit-cleanup.ts. If the
 * instance cannot be destroyed, the Clerk user is deliberately KEPT so the reaper
 * can still authenticate as them — deleting the user first would strand the VM
 * outside the app's own destroy path.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

import {
  auditAgentName,
  auditEmail,
  loadAuditConfig,
  newRunId,
  type AuditConfig,
} from './first-run-audit/config';
import { probeAgentChatOverWs } from './first-run-audit/agent-chat';
import { createAuditUser, deleteAuditUser, mintSignInTicket } from './first-run-audit/clerk-admin';
import {
  destroyAllInstances,
  getInstance,
  isInferenceConfigured,
  listInstances,
  probeHealth,
  probeInstanceStatus,
  probeWorkspaceHandoff,
  sleep,
  type InstanceSummary,
} from './first-run-audit/instances';
import { IframeLoadWatcher } from './first-run-audit/iframe-watch';
import { PostHogCapture } from './first-run-audit/posthog-capture';
import { collectOpsEvents, preclearAbuseGate, removeRiskPreclear } from './first-run-audit/probes';
import { reapAuditAccounts } from './first-run-audit/reaper';
import { establishAuditSession } from './first-run-audit/session';
import {
  AUDIT_STAGES,
  RunRecorder,
  StageError,
  VERDICT_SCHEMA,
  writeVerdict,
  type AuditFailure,
  type AuditStage,
  type AuditVerdict,
  type TeardownRecord,
} from './first-run-audit/verdict';

const ENABLED = process.env.FIRST_RUN_AUDIT === '1';

/**
 * Set as soon as the run has an identity, so the afterAll net knows what to reap
 * even if the test body was aborted mid-flight.
 */
let activeRunId: string | null = null;
let teardownCompleted = false;

test.describe.configure({ mode: 'serial' });

test.describe('FIRST-RUN AUDIT: new signup → deployed agent → first real outcome', () => {
  test.skip(!ENABLED, 'Set FIRST_RUN_AUDIT=1 — this test provisions real paid infrastructure.');

  /**
   * Last line of in-process defence.
   *
   * A Playwright TIMEOUT aborts the test body — its `finally` is not guaranteed
   * to run, so the primary teardown can be skipped entirely. afterAll gets its
   * own timeout budget, so it still executes. If the normal teardown already
   * completed this is a no-op scan.
   */
  test.afterAll(async () => {
    if (!ENABLED || teardownCompleted || !activeRunId) return;

    const cfg = loadAuditConfig();
    // eslint-disable-next-line no-console
    console.error(
      `[first-run-audit] primary teardown did not complete — reaping run ${activeRunId}`,
    );
    const report = await reapAuditAccounts({
      clerkSecretKey: cfg.clerkSecretKey,
      baseUrl: cfg.baseUrl,
      minAgeMs: 0,
      onlyRunId: activeRunId,
    });
    if (report.leaked) {
      throw new Error(
        `[first-run-audit] afterAll reaper could not clean run ${activeRunId}: ` +
          `${JSON.stringify(report.reaped)}. Run scripts/first-run-audit-cleanup.ts.`,
      );
    }
  });

  test('a virgin account reaches its working agent with zero manual intervention', async ({
    browser,
  }, testInfo) => {
    const cfg = loadAuditConfig();
    test.setTimeout(cfg.testTimeoutMs);

    const runId = newRunId();
    activeRunId = runId;
    const email = auditEmail(runId, cfg.emailDomain);
    const agentName = auditAgentName(runId);
    const startedAt = new Date().toISOString();
    const recorder = new RunRecorder(runId);
    const posthog = new PostHogCapture();
    const iframes = new IframeLoadWatcher();
    /**
     * The abuse gate answers the deploy POST with 402 before any VM exists. Seen
     * on the wire, not in analytics — canary ingests no PostHog events, so the
     * telemetry-only detection this replaces could never have fired there.
     */
    const deployGate: { cardRequired: boolean; status: number | null } = {
      cardRequired: false,
      status: null,
    };

    let context: BrowserContext | null = null;
    let clerkUserId: string | null = null;
    let instanceId: string | null = null;
    let instanceRow: Record<string, unknown> | null = null;
    let failure: AuditFailure | null = null;
    let agentReply: AuditVerdict['agent_reply'] = null;
    let workspace: AuditVerdict['workspace'] = null;

    // eslint-disable-next-line no-console
    console.log(`[first-run-audit] run=${runId} target=${cfg.baseUrl} agent=${agentName}`);

    try {
      // ── 1. Signup ────────────────────────────────────────────────────────
      const user = await createAuditUser(cfg.clerkSecretKey, email);
      clerkUserId = user.id;
      recorder.pass('clerk_user_created', user.id);

      if (cfg.preclearRisk && cfg.supabaseUrl && cfg.supabaseServiceRoleKey) {
        await preclearAbuseGate(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, user.id);
        // eslint-disable-next-line no-console
        console.log('[first-run-audit] abuse gate pre-cleared (datacenter-egress runner)');
      }

      // ── 2. Land authed, exactly as a real signup does ────────────────────
      const ticket = await mintSignInTicket(cfg.clerkSecretKey, user.id);
      context = await establishAuditSession(browser, {
        baseUrl: cfg.baseUrl,
        ticket,
        onContext: (ctx) => {
          posthog.attach(ctx);
          iframes.attach(ctx);
          ctx.on('response', (res) => {
            const url = res.url();
            if (res.request().method() !== 'POST') return;
            if (!/\/api\/instances\/?(?:\?|$)/.test(url)) return;
            deployGate.status = res.status();
            if (res.status() === 402) deployGate.cardRequired = true;
          });
        },
      });
      recorder.pass('session_established');

      const page = await context.newPage();

      // ── 3. Welcome flow ──────────────────────────────────────────────────
      // Enter through the same default catalog surface a new user sees. Keep
      // this audit on Hermes Agent because the later assertions exercise the
      // mature managed-instance API, workspace connection, reply, and teardown
      // path rather than a catalog-only preview.
      await page.goto('/dashboard/welcome', { waitUntil: 'domcontentloaded' });

      const agentTypeHeading = page.getByRole('heading', { name: /Choose Your Agent/i });
      await expect(agentTypeHeading, 'welcome flow should reach the agent-type step').toBeVisible({
        timeout: 60_000,
      });
      recorder.pass('welcome_loaded');

      const agentsTab = page.getByRole('tab', { name: /^Agents$/i });
      await expect(agentsTab, 'the default onboarding catalog should open on Agents').toHaveAttribute(
        'aria-selected',
        'true',
      );
      const hermesAgent = page.locator(
        '[data-testid="welcome-agent-card"][data-agent-type="general"]',
      );
      await expect(hermesAgent, 'Hermes Agent should be directly launchable from the catalog').toBeVisible();
      await hermesAgent.click();
      recorder.pass('agent_type_selected');

      // ── 4. Free plan ─────────────────────────────────────────────────────
      // A user with no subscription row lands on the plan step. `Start free tier`
      // POSTs /api/billing/subscribe {plan:'free'} and advances to the deploy card.
      const startFree = page.getByRole('button', { name: 'Start free tier' });
      const deployHeading = page.getByRole('heading', { name: /^Deploy / });

      await expect
        .poll(
          async () =>
            (await startFree.isVisible().catch(() => false)) ||
            (await deployHeading.isVisible().catch(() => false)),
          { timeout: 60_000, message: 'expected either the plan step or the deploy card' },
        )
        .toBe(true);

      if (await startFree.isVisible().catch(() => false)) {
        await startFree.click();
        recorder.pass('plan_activated', 'free tier activated via plan step');
      } else {
        recorder.pass('plan_activated', 'already entitled — plan step skipped');
      }

      await expect(deployHeading, 'should reach the deploy card').toBeVisible({ timeout: 90_000 });
      recorder.pass('deploy_card_reached');

      // ── 5. The real deploy click ─────────────────────────────────────────
      await page.getByPlaceholder('MY_FIRST_AGENT').fill(agentName);

      // ── THE LANE ─────────────────────────────────────────────────────────
      // Two lanes on this card, and the choice decides whether `agent_replied`
      // is even reachable. The managed happy path is intentionally collapsed:
      // its lane control lives behind Advanced setup, while the simple summary
      // is the user-visible source of truth for what the default deploy includes.
      //
      //   Managed Venice (the DEFAULT on a clean browser) — the deploy mints a
      //     Venice proxy key and seeds providerId+model, so the box boots able to
      //     answer. Since canary #490/#491 a virgin free account can complete it:
      //     the per-user starter credit settles BEFORE wallet resolution and the
      //     key binds to whichever wallet actually holds money. The Deploy button
      //     is always rendered — a zero-credit managed deploy is allowed through.
      //
      //   Bring your own — a clean-slate box: no provider, no model, no key. The
      //     card's own copy says "paste your key from the agent after it's live",
      //     so `agent_replied` is unreachable on this lane BY CONSTRUCTION.
      //
      // Gate the lane on the outcome we're certifying, so the harness can never
      // assert a reply against a box that was never given the means to produce one.
      if (cfg.requireAgentReply) {
        await expect(
          page.getByTestId('deploy-simple-summary'),
          'the collapsed default lane should include managed AI',
        ).toContainText(
          /private computer with AI included/i,
          { timeout: 10_000 },
        );
      } else {
        const advanced = page.getByTestId('deploy-advanced-toggle');
        await advanced.click();
        await expect(advanced, 'advanced setup should expose the lane controls').toHaveAttribute(
          'aria-expanded',
          'true',
          { timeout: 10_000 },
        );
        const bringYourOwn = page.getByRole('button', { name: /Bring your own/ });
        await bringYourOwn.click();
        await expect(bringYourOwn, 'clean-slate toggle should be pressed').toHaveAttribute(
          'aria-pressed',
          'true',
          { timeout: 10_000 },
        );
      }

      const deployButton = page.getByRole('button', { name: /^Deploy (Hermes Agent|Agent)$/ });
      await expect(deployButton).toBeEnabled();
      await deployButton.click();
      recorder.pass('deploy_clicked');

      // ── 6. An instance row appears ───────────────────────────────────────
      // Provisioning is synchronous server-side (maxDuration 300s) but the row is
      // written early in Phase 1, so it shows up well before the POST returns.
      instanceId = await waitForInstance(context, cfg, agentName, posthog, deployGate);
      recorder.pass('instance_created', instanceId);

      // ── 7. The box comes up ──────────────────────────────────────────────
      await waitForReady(context, cfg, instanceId, recorder);
      recorder.pass('instance_ready');

      // ── 8. FIRST REAL OUTCOME: the user can type to their agent ──────────
      workspace = await waitForWorkspace(context, cfg, instanceId, page, posthog, iframes);
      recorder.pass('workspace_interactive', `iframe HTTP ${workspace.iframe_document_status}`);

      instanceRow = await getInstance(context.request, cfg.baseUrl, instanceId);

      // ── 9. Optional: does it actually answer? ────────────────────────────
      if (cfg.probeAgentReply) {
        agentReply = await probeAgentReply(context, cfg, instanceId, instanceRow);
        if (agentReply.ok) {
          recorder.pass('agent_replied', `${agentReply.chars} chars`);
        } else if (cfg.requireAgentReply) {
          throw new StageError(
            'agent_replied',
            agentReply.reason ?? 'no_reply',
            `agent did not answer: ${agentReply.reason}`,
          );
        } else {
          recorder.fail('agent_replied', `not asserted: ${agentReply.reason}`);
        }
      }
    } catch (err) {
      failure = toFailure(err, recorder);
      // eslint-disable-next-line no-console
      console.error(`[first-run-audit] FAILED at ${failure.stage}: ${failure.message}`);
    } finally {
      // ── Telemetry BEFORE teardown (the instance row is about to go away) ──
      const opsEvents = await collectOpsEvents(cfg.baseUrl, cfg.cronSecret, startedAt, instanceId);

      if (context && instanceId && !instanceRow) {
        instanceRow = await getInstance(context.request, cfg.baseUrl, instanceId).catch(() => null);
      }

      // ── Let the box finish what promotion started ────────────────────────
      // Only once it actually came up — a box that never promoted has no
      // deferred work pending, and a failed run should die fast.
      if (instanceId && reachedAtLeast(recorder.reached, 'instance_ready') && cfg.postReadySettleMs > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[first-run-audit] settling ${Math.round(cfg.postReadySettleMs / 1000)}s so deferred ` +
            'post-ready work (SOUL.md reconcile) completes before teardown',
        );
        await sleep(cfg.postReadySettleMs);
      }

      const teardown = await runTeardown({
        cfg,
        context,
        clerkUserId,
        runId,
      });
      // Tell afterAll it has nothing to do — but only if teardown truly finished.
      teardownCompleted = teardown.instances_survived.length === 0 && teardown.errors.length === 0;

      const verdict: AuditVerdict = {
        schema: VERDICT_SCHEMA,
        run_id: runId,
        verdict: failure ? 'fail' : 'pass',
        outcome_level: cfg.requireAgentReply ? 'agent_replied' : 'workspace_interactive',
        stage_reached: recorder.reached,
        failure,
        target: cfg.baseUrl,
        git_sha: process.env.GITHUB_SHA ?? null,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - recorder.startedAtMs,
        clerk_user_id: clerkUserId,
        email,
        agent_name: agentName,
        instance: {
          id: instanceId,
          status: typeof instanceRow?.status === 'string' ? instanceRow.status : null,
          provider: typeof instanceRow?.provider === 'string' ? instanceRow.provider : null,
          host_id: typeof instanceRow?.host_id === 'string' ? instanceRow.host_id : null,
          inference_configured: isInferenceConfigured(instanceRow),
        },
        stages: recorder.snapshot(),
        timings_ms: recorder.timings(),
        workspace,
        telemetry: {
          // "did posthog ingest", not "could we read the bodies" — compressed
          // batches are undecodable but still ingested. See posthog-capture.ts.
          posthog_captured: posthog.sawIngest(),
          funnel: posthog.funnelTimeline(),
          activation_failures: posthog.activationFailures(),
          ops_events: opsEvents,
        },
        agent_reply: agentReply,
        teardown,
      };

      const path = writeVerdict(cfg.outDir, verdict);
      await testInfo.attach('first-run-audit-verdict.json', {
        path,
        contentType: 'application/json',
      });

      await context?.close().catch(() => undefined);

      // Surface a leak as a loud, separate failure — it must never hide behind a
      // green run.
      if (teardown.instances_survived.length > 0) {
        throw new Error(
          `[first-run-audit] LEAKED INFRASTRUCTURE: ${teardown.instances_survived
            .map((s) => `${s.id} (HTTP ${s.httpStatus})`)
            .join(', ')} — run scripts/first-run-audit-cleanup.ts NOW. ` +
            `Clerk user ${clerkUserId} was retained so the reaper can authenticate.`,
        );
      }
      if (failure) {
        throw new Error(`[first-run-audit] ${failure.stage}/${failure.reason}: ${failure.message}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Poll the app's own instance list until this run's agent appears. */
async function waitForInstance(
  context: BrowserContext,
  cfg: AuditConfig,
  agentName: string,
  posthog: PostHogCapture,
  deployGate: { cardRequired: boolean; status: number | null },
): Promise<string> {
  const deadline = Date.now() + 8 * 60_000;

  while (Date.now() < deadline) {
    // The abuse gate answers 402 before any VM is created — a runner-network
    // problem, not a product failure. Detect it immediately rather than timing
    // out. Read off the deploy POST's own status code: the `activation_card_required`
    // analytics event cannot be relied on (canary ingests no PostHog events).
    if (deployGate.cardRequired || posthog.named('activation_card_required').length > 0) {
      throw new StageError(
        'instance_created',
        'card_required',
        'the free-tier abuse gate demanded a card on file before provisioning. ' +
          'This is almost certainly the runner egressing from a datacenter ASN (+30 → require_card). ' +
          'Set FIRST_RUN_AUDIT_PRECLEAR_RISK=1 (with canary Supabase creds) or run from a residential egress.',
        'harness_environment',
      );
    }

    const failures = posthog.activationFailures();
    if (failures.length > 0) {
      const first = failures[0];
      throw new StageError(
        'instance_created',
        String(first.failureType ?? 'activation_failed'),
        `activation_failed at stage=${String(first.stage)} category=${String(
          first.errorCategory,
        )}: ${String(first.errorMessage ?? '')}`,
      );
    }

    const rows = await listInstances(context.request, cfg.baseUrl).catch(
      () => [] as InstanceSummary[],
    );
    const match = rows.find((r) => r.name === agentName);
    if (match) return match.id;

    await sleep(10_000);
  }

  throw new StageError(
    'instance_created',
    'no_instance_row',
    `no instance named "${agentName}" appeared within 8 minutes of the deploy click`,
  );
}

/**
 * Wait for the box to come up, observing readiness EXACTLY where the product
 * observes it: `GET /api/instances/[id]`, the route the welcome flow polls.
 *
 * Do not be tempted back to `/api/instances/[id]/health`. Both routes promote the
 * DB row `provisioning → running` when the gateway answers, but only this one
 * schedules the post-ready SOUL.md reconcile (canary #484). A harness that polls
 * `/health` promotes the row first, so when the product's own poll arrives the
 * transition has already happened, `promotedToRunning` is false, and the persona
 * seed never fires. The first proving run did exactly that and left a freshly
 * hired "Bea" box wearing the factory-default Hermes soul.
 *
 * Once the row says `running`, `/health` is called ONCE as confirmation that the
 * gateway really answers — a promoted row with a dead gateway is a lie we want to
 * catch, and by then there is no transition left to steal.
 */
async function waitForReady(
  context: BrowserContext,
  cfg: AuditConfig,
  instanceId: string,
  recorder: RunRecorder,
): Promise<void> {
  const deadline = Date.now() + cfg.readyTimeoutMs;
  let last = 'never probed';

  while (Date.now() < deadline) {
    const row = await probeInstanceStatus(context.request, cfg.baseUrl, instanceId);
    last = `status=${row.status ?? '?'} http=${row.httpStatus}`;

    if (row.status === 'running') {
      const health = await probeHealth(context.request, cfg.baseUrl, instanceId);
      if (health.isReady) return;
      last = `row=running but health says error=${health.error ?? 'none'}`;
    }

    // A terminal status will never become ready — fail fast rather than burn
    // 15 minutes of wall clock on a box that is already dead.
    if (row.status === 'error' || row.status === 'failed') {
      throw new StageError(
        'instance_ready',
        `instance_${row.status}`,
        `box reached terminal ${row.status}: ${last}`,
      );
    }

    await sleep(15_000);
  }

  recorder.fail('instance_ready', last);
  throw new StageError(
    'instance_ready',
    'ready_timeout',
    `box never became healthy within ${Math.round(cfg.readyTimeoutMs / 60_000)}m — last probe: ${last}`,
  );
}

/**
 * The first real outcome: a signed workspace handoff, and the chat surface
 * actually loading — proven from the PRODUCT's surfaces alone.
 *
 * The proof is deliberately not the app's `webui_iframe_loaded` analytics event.
 * Canary ingests no PostHog events (iframe-watch.ts explains, at length, how that
 * was established), so a telemetry gate here can never pass and — far worse —
 * fails as a product bug on a box that is perfectly healthy.
 *
 * Instead we watch the same navigation whose completion FIRES that event: the
 * workspace iframe's own document response, straight off the browser's network
 * stack. That is strictly stronger. `onLoad` fires even when the box serves an
 * error page, so a 502 would have counted as "loaded"; here we can insist on a
 * non-error status.
 *
 * Telemetry still corroborates: if it IS flowing and reports `webui_iframe_error`
 * for this instance, that is a real failure and we say so.
 */
async function waitForWorkspace(
  context: BrowserContext,
  cfg: AuditConfig,
  instanceId: string,
  page: import('@playwright/test').Page,
  posthog: PostHogCapture,
  iframes: IframeLoadWatcher,
): Promise<NonNullable<AuditVerdict['workspace']>> {
  const deadline = Date.now() + cfg.workspaceTimeoutMs;
  let last = 'never probed';

  while (Date.now() < deadline) {
    const handoff = await probeWorkspaceHandoff(context.request, cfg.baseUrl, instanceId);
    if (handoff.ready) break;
    last = `HTTP ${handoff.httpStatus} reason=${handoff.pendingReason ?? 'none'} status=${
      handoff.instanceStatus ?? '?'
    }`;
    await sleep(10_000);
  }

  const finalHandoff = await probeWorkspaceHandoff(context.request, cfg.baseUrl, instanceId);
  if (!finalHandoff.ready || !finalHandoff.origin) {
    throw new StageError(
      'workspace_interactive',
      'handoff_never_minted',
      `webui-login-url never returned a signed handoff — last: ${last}`,
    );
  }
  const origin = finalHandoff.origin;

  // Open the workspace the way the user does.
  await page.goto(`/dashboard/instances/${instanceId}?surface=chat&welcome=1`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(
    page.locator('iframe[title="Workspace"]'),
    'the chat workspace iframe should render',
  ).toBeVisible({ timeout: 90_000 });

  // The iframe's document must actually come back from the BOX (its gateway
  // origin), not merely be requested. Redirect hops don't count — we wait for the
  // response that settles the navigation.
  await expect
    .poll(() => iframes.workspaceDocument(origin)?.status ?? null, {
      timeout: 120_000,
      message: `the workspace iframe never settled a document from ${origin} (chain: ${iframes
        .chain(origin)
        .map((d) => d.status)
        .join('→')})`,
    })
    .not.toBeNull();

  const doc = iframes.workspaceDocument(origin)!;
  const redirectChain = iframes.chain(origin).map((d) => d.status);
  if (doc.status >= 400) {
    throw new StageError(
      'workspace_interactive',
      'iframe_http_error',
      `the box served the workspace iframe HTTP ${doc.status} (chain: ${redirectChain.join(
        '→',
      )}) — the surface renders an error, not a chat`,
    );
  }

  // Corroboration, when analytics is actually flowing.
  const telemetryAlive = posthog.all().length > 0;
  if (telemetryAlive && posthog.firedFor('webui_iframe_error', instanceId)) {
    const detail = posthog
      .named('webui_iframe_error')
      .map((e) => `${String(e.properties.reason)}/${String(e.properties.pending_reason ?? '')}`)
      .join(', ');
    throw new StageError(
      'workspace_interactive',
      'iframe_error',
      `the workspace reported an error after loading: ${detail}`,
    );
  }

  return {
    handoff_minted: true,
    handoff_origin: origin,
    iframe_document_status: doc.status,
    iframe_redirect_chain: redirectChain,
    iframe_loaded_event: telemetryAlive && posthog.firedFor('webui_iframe_loaded', instanceId),
  };
}

/**
 * Require the AGENT to have actually answered. Only meaningful on a box that
 * booted with inference.
 *
 * ── THE REAL SURFACE, NOT A RETIRED PROXY ──────────────────────────────────
 * The earlier version of this probe POSTed `/api/instances/[id]/send-stream`, a
 * dashboard proxy to hermes-webui's `POST /api/chat/start`. No agent image has
 * served that endpoint since the webui-free cutover — every box answered
 * `405 Allow: GET` — so the route was retired and this probe was stubbed
 * `transport_retired`. There is no HTTP chat surface on a box at all: the gateway
 * `api_server` that owns `POST /v1/responses` + `POST /api/sessions/{id}/chat/stream`
 * binds :8642 on the compose network only, and the VM publishes just 80/443.
 *
 * Real chat runs over the agent's TUI-gateway JSON-RPC protocol through Hivra's
 * `/desktop/api/ws` remote-gateway route — the exact socket Hermes Desktop Web
 * opens. `probeAgentChatOverWs` reproduces that path end-to-end: mint the
 * signed handoff (the iframe's own entry URL) and pull the apiServerKey out of its
 * `#iframe_token` fragment → land on the box origin → open
 * `wss://<box>/desktop/api/ws?token=<apiServerKey>`. The box Caddy strips the
 * `/desktop` prefix and routes the upgrade through the sidecar. This is NOT the
 * gated `/api/auth/ws-ticket` path: that is
 * the OAuth-cookie endpoint these webfree boxes don't use, and it 401s — which is
 * exactly what sank the first proving run. Then `session.create` → `prompt.submit`
 * → read the terminal `message.complete`. A backend failure the agent renders as
 * `"Error: …"` text or an `error` event is recorded as a FAILURE with the reason
 * verbatim, so `FIRST_RUN_AUDIT_REQUIRE_AGENT_REPLY=1` gates on a genuine answer.
 * See agent-chat.ts for the WS auth mechanism, wire protocol, and retry semantics.
 */
async function probeAgentReply(
  context: BrowserContext,
  cfg: AuditConfig,
  instanceId: string,
  instanceRow: Record<string, unknown> | null,
): Promise<NonNullable<AuditVerdict['agent_reply']>> {
  // Keep the inference gate FIRST: on a clean-slate box the reply could never
  // be attempted anyway, and that reason is the more actionable of the two.
  if (!isInferenceConfigured(instanceRow)) {
    return {
      attempted: false,
      ok: false,
      reason: 'unconfigured_provider — clean-slate box has no provider/model/key',
    };
  }

  return probeAgentChatOverWs(context, cfg, instanceId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Teardown — runs on every path, success or failure
// ─────────────────────────────────────────────────────────────────────────────

async function runTeardown(args: {
  cfg: AuditConfig;
  context: BrowserContext | null;
  clerkUserId: string | null;
  runId: string;
}): Promise<TeardownRecord> {
  const { cfg, context, clerkUserId, runId } = args;
  const record: TeardownRecord = {
    attempted: true,
    instances_destroyed: [],
    instances_survived: [],
    clerk_user_deleted: false,
    clerk_user_retained_for_reaper: false,
    errors: [],
  };

  // 1. Destroy every instance the audit user owns, through the app's own route.
  if (context) {
    try {
      const result = await destroyAllInstances(
        context.request,
        cfg.baseUrl,
        `first-run audit ${runId}`,
      );
      record.instances_destroyed = result.destroyed;
      record.instances_survived = result.survived.map((s) => ({
        id: s.id,
        httpStatus: s.httpStatus,
        error: s.error,
      }));
    } catch (err) {
      record.errors.push(`destroy: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (clerkUserId) {
    record.errors.push('no browser context — could not authenticate to destroy instances');
  }

  // 2. Delete the Clerk user — but ONLY if nothing survived. An orphaned VM whose
  //    owner no longer exists cannot be reaped through the app's own destroy flow.
  if (clerkUserId) {
    if (record.instances_survived.length > 0 || record.errors.length > 0) {
      record.clerk_user_retained_for_reaper = true;
      // eslint-disable-next-line no-console
      console.error(
        `[first-run-audit] retaining Clerk user ${clerkUserId} — instances survived teardown`,
      );
    } else {
      try {
        record.clerk_user_deleted = await deleteAuditUser(cfg.clerkSecretKey, clerkUserId);
      } catch (err) {
        record.errors.push(`clerk delete: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 3. Remove the synthetic risk row, if we planted one.
  if (cfg.preclearRisk && cfg.supabaseUrl && cfg.supabaseServiceRoleKey && clerkUserId) {
    await removeRiskPreclear(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, clerkUserId);
  }

  return record;
}

function toFailure(err: unknown, recorder: RunRecorder): AuditFailure {
  if (err instanceof StageError) {
    recorder.fail(err.stage, err.message);
    return {
      stage: err.stage,
      category: err.category,
      reason: err.reason,
      message: err.message,
    };
  }

  // An assertion or an unexpected throw. Attribute it to the stage after the last
  // one that passed — that is where the run actually was.
  const reached = recorder.reached;
  const stage = nextStage(reached);
  const message = err instanceof Error ? err.message : String(err);
  recorder.fail(stage, message);
  return {
    stage,
    category: 'product',
    reason: 'assertion_failed',
    message: message.slice(0, 1500),
  };
}

function nextStage(reached: AuditStage | null): AuditStage {
  if (!reached) return AUDIT_STAGES[0];
  const index = AUDIT_STAGES.indexOf(reached);
  return AUDIT_STAGES[Math.min(index + 1, AUDIT_STAGES.length - 1)];
}

/** Did the run get at least as far as `stage`? */
function reachedAtLeast(reached: AuditStage | null, stage: AuditStage): boolean {
  if (!reached) return false;
  return AUDIT_STAGES.indexOf(reached) >= AUDIT_STAGES.indexOf(stage);
}
