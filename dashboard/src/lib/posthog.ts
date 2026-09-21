import { PostHog } from 'posthog-node'

// Server-side PostHog (posthog-node) client used for activation/billing events
// like `box_created`.
//
// PROJECT TOKEN COMES FROM THE ENVIRONMENT ONLY. This module used to fall back
// to a baked-in literal (`phc_zNoQ…`, the PRODUCTION project, id 368999). Since
// no Vercel project set NEXT_PUBLIC_POSTHOG_KEY, that fallback meant EVERY
// runtime that reached this module — canary, preview builds, and any local
// `next start` — emitted server-side events straight into production analytics.
// Canary's `box_created`/billing events were landing in the prod funnel.
//
// It also bit jest: suites that transitively run a `posthogClient.capture()`
// path (e.g. the `box_created` emit inside instance-service's createInstance,
// reached by many route/cron/sweep tests) fired REAL events into prod PostHog
// with fixture instance ids (inst_123, inst_orphan, inst_dblfail, …), corrupting
// the activation funnel and polluting error/event samples. CI re-ran daily, so
// the fixtures re-fired dozens of times a day.
//
// Guard at the source. The client is disabled when ANY of:
//   - no project token is configured (a missing key means analytics OFF — it
//     must never mean "analytics into whichever project the fallback named"),
//   - running under test (jest sets NODE_ENV=test),
//   - a job explicitly opts out via POSTHOG_DISABLED=true.
// `disabled: true` is a first-class posthog-node option that makes
// capture()/flush() no-ops without touching any call site.
//
// DEPLOY REQUIREMENT: every environment that should report analytics must now
// set NEXT_PUBLIC_POSTHOG_KEY. Prod and canary carry DIFFERENT project tokens so
// canary traffic can never pollute the prod project.
const POSTHOG_KEY =
  process.env.NEXT_PUBLIC_POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN || ''

const disabled =
  !POSTHOG_KEY ||
  process.env.NODE_ENV === 'test' ||
  process.env.POSTHOG_DISABLED === 'true'

if (!POSTHOG_KEY && process.env.NODE_ENV === 'production') {
  // Loud, once, at import. A production runtime with no project token is a deploy
  // misconfiguration; the whole point of dropping the fallback is that it must
  // not fail silently (it used to "succeed" — into the prod project).
  // eslint-disable-next-line no-console
  console.warn(
    '[posthog] NEXT_PUBLIC_POSTHOG_KEY is not set — server-side analytics are disabled.'
  )
}

// posthog-node throws ("You must pass your PostHog project's api key") on an
// empty key even when `disabled: true`, so hand it an inert, obviously-fake
// placeholder. Nothing is ever sent: `disabled` is true whenever we use it.
const INERT_KEY = 'phc_disabled_no_project_token_configured'

export const posthogClient = new PostHog(POSTHOG_KEY || INERT_KEY, {
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
  disabled,
})
