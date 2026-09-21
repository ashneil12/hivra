/**
 * Next.js instrumentation hook — runs once when the server process starts.
 *
 * We use it for two things:
 *   1. Log a boot line so Vercel Logs always shows which deployment is live.
 *   2. Wire process-level error handlers so uncaught exceptions and unhandled
 *      promise rejections don't disappear silently.
 *
 * Edge runtime is skipped — process listeners aren't supported there.
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register(): Promise<void> {
  // Only attach the Node hooks once, in the Node runtime (not Edge). Keep the
  // process-level listeners in a separate file so Vercel's Edge bundle analyzer
  // never sees unsupported Node APIs while tracing this shared hook.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNodeInstrumentation } = await import("./instrumentation.node");
  registerNodeInstrumentation();
}
