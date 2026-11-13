'use strict';

// Every dashboard Playwright launch goes through these options.
//
// Local runs use the installed Google Chrome with its sandbox on. Playwright's
// bundled Chromium only moves when Playwright ships a release, so it lags
// Chrome's security fixes (1.64.1 bundled 156.0.8078.4 after the
// CVE-2026-118306 sandbox-escape fix shipped in 156.0.8078.73), and Playwright
// passes --no-sandbox unless chromiumSandbox is true.
//
// CI keeps the pinned build and Playwright's defaults: the ephemeral Linux
// runner installs it fresh (`playwright install --only-shell chromium`) and has
// no Google Chrome, and the Chromium sandbox has not been proven on it.
const LOCAL_LAUNCH_OPTIONS = Object.freeze({ channel: 'chrome', chromiumSandbox: true });

/**
 * @param {{ CI?: string }} [env]
 * @returns {{ channel?: string, chromiumSandbox?: boolean }}
 */
function browserLaunchOptions(env = process.env) {
  return env.CI ? {} : { ...LOCAL_LAUNCH_OPTIONS };
}

/**
 * @template {object} T
 * @param {T} [extra]
 * @param {{ CI?: string }} [env]
 * @returns {T & { channel?: string, chromiumSandbox?: boolean }}
 */
function launchOptions(extra = /** @type {T} */ ({}), env = process.env) {
  return { ...browserLaunchOptions(env), ...extra };
}

module.exports = { browserLaunchOptions, launchOptions };
