#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../config.js";
import { buildLogger } from "../logger.js";
import { SessionManager } from "../playwright/session-manager.js";
import { FlowRunner } from "../playwright/flow-runner.js";
import { mintSignedUrl } from "../auth/signed-url.js";
import { NOVNC_TTL_MS } from "../config.js";

// Seed CLI. Used once per identity to establish a persistent context that survives
// future sidecar restarts. After seeding, the named flows (login_clerk, etc.)
// run headless against the same userDataDir.
//
// Two seed modes:
//   --headed       Open headed Chromium; human handles MFA / Clerk verification
//                  loop interactively. Designed for SSH-tunneled X or local dev.
//   --novnc        Print a signed noVNC URL that exposes the headed browser
//                  through the websockify+caddy stack. 10-minute TTL (hard).

const program = new Command();
program
  .name("hermes-browser")
  .description("Browser sidecar admin CLI")
  .version("0.1.0");

program
  .command("seed")
  .description("Open a one-shot seeding session for a given identity. Saves the persistent context on exit.")
  .requiredOption("--identity <name>", "identity name (e.g. vex)")
  .option("--flow <id>", "flow to run after browser opens", "login_clerk")
  .option("--headed", "force headed mode (overrides PLAYWRIGHT_HEADLESS)", true)
  .option("--novnc", "do not run a flow; just print a signed noVNC URL and keep the browser open", false)
  .option("--public-base <url>", "public base URL for the noVNC URL (e.g. https://your-vm.example.com)", "")
  .action(async (opts) => {
    process.env.PLAYWRIGHT_HEADLESS = opts.headed === false ? "true" : "false";
    // Headed Playwright needs an X display. The container's entrypoint runs
    // Xvfb on :99 unconditionally and exports DISPLAY before exec-ing node, so
    // this is already set when the CLI is invoked via `docker exec`. Defensive
    // default for direct-host invocation (rare).
    if (process.env.PLAYWRIGHT_HEADLESS === "false" && !process.env.DISPLAY) {
      process.env.DISPLAY = ":99";
    }
    const config = loadConfig();
    const logger = buildLogger(config);
    const sessions = new SessionManager(config, logger);

    try {
      const { session_id } = await sessions.start(opts.identity);
      logger.info({ identity: opts.identity, session_id }, "seeding session started");

      if (opts.novnc) {
        if (!opts.publicBase) {
          throw new Error("--public-base required for --novnc mode");
        }
        const url = mintSignedUrl({
          baseUrl: opts.publicBase,
          path: `/browser-sidecar/novnc/vnc.html`,
          scope: `novnc:${opts.identity}` as const,
          secret: config.SIGNING_SECRET,
          ttlMs: NOVNC_TTL_MS,
        });
        // eslint-disable-next-line no-console
        console.log(`\nnoVNC URL (valid 10 min):\n  ${url}\n`);
        // eslint-disable-next-line no-console
        console.log("Press Ctrl+C when done; the persistent context will be saved on exit.\n");
        await new Promise((r) => process.on("SIGINT", r));
      } else {
        const runner = new FlowRunner(config, logger, sessions);
        const result = await runner.run({ session_id, flow_id: opts.flow });
        if (!result.ok) {
          logger.error({ result }, "flow failed; not saving context cleanly");
          process.exitCode = 1;
        } else {
          logger.info({ result }, "flow completed; context saved on shutdown");
        }
      }
    } finally {
      await sessions.shutdown();
    }
  });

program.parseAsync().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  process.exit(1);
});
