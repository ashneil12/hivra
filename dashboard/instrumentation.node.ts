import { log } from "@/lib/logger";

let registered = false;

export function registerNodeInstrumentation(): void {
  if (registered) return;
  registered = true;

  log.info("server boot", {
    source: "instrumentation",
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    deploymentUrl: process.env.VERCEL_URL,
    gitSha: process.env.VERCEL_GIT_COMMIT_SHA,
    gitBranch: process.env.VERCEL_GIT_COMMIT_REF,
    region: process.env.VERCEL_REGION,
  });

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", reason, {
      source: "instrumentation",
      failureType: "unhandled_rejection",
    });
  });

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", err, {
      source: "instrumentation",
      failureType: "uncaught_exception",
    });
  });
}
