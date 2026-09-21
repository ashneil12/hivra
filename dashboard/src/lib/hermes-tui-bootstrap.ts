function resolveHermesTuiBuildFingerprint(): string {
    const raw =
        [
            process.env.VERCEL_DEPLOYMENT_ID,
            process.env.VERCEL_GIT_COMMIT_SHA,
            process.env.GIT_COMMIT_SHA,
            process.env.SOURCE_VERSION,
        ].find((value) => typeof value === "string" && value.trim().length > 0) ?? "local-dev";

    return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function buildHermesTuiBootstrapCommand(): string {
    const buildFingerprint = resolveHermesTuiBuildFingerprint();
    const tuiRepairNeeded =
        "[ ! -f /opt/hermes/ui-tui/node_modules/@hermes/ink/dist/ink-bundle.js ]";
    const tuiInstallNeeded =
        "[ ! -f /opt/hermes/ui-tui/node_modules/@hermes/ink/package.json ] || " +
        "[ ! -x /opt/hermes/ui-tui/node_modules/.bin/esbuild ]";
    const tuiRepair =
        "if [ -d /opt/hermes/ui-tui ] && [ -f /opt/hermes/ui-tui/package.json ]; then " +
        `if ${tuiRepairNeeded}; then ` +
        "cd /opt/hermes/ui-tui || exit 1; " +
        "echo '[~] Repairing Hermes TUI runtime...' >&2; " +
        `echo '[~] Hermes TUI repair build: ${buildFingerprint}' >&2; ` +
        "BUILD_STRATEGY='npm-install'; " +
        `if ${tuiInstallNeeded}; then ` +
        "echo '[~] Hermes TUI repair: toolchain missing, reinstalling dependencies...' >&2; " +
        "fi; " +
        "rm -rf node_modules || { " +
        "echo '[!] Hermes TUI repair: failed to reset node_modules' >&2; exit 1; }; " +
        "CI=1 npm install --include=dev --silent --no-fund --no-audit || { " +
        "echo '[!] Hermes TUI repair: npm install failed' >&2; exit 1; }; " +
        "[ -f node_modules/@hermes/ink/dist/ink-bundle.js ] || { " +
        "if [ -f packages/hermes-ink/package.json ]; then " +
        "if npm run build --prefix packages/hermes-ink; then " +
        "mkdir -p node_modules/@hermes/ink/dist || { " +
        "echo '[!] Hermes TUI repair: failed to create @hermes/ink dist directory' >&2; exit 1; }; " +
        "cp -r packages/hermes-ink/dist/. node_modules/@hermes/ink/dist/ || { " +
        "echo '[!] Hermes TUI repair: failed to copy hermes-ink dist into node_modules' >&2; exit 1; }; " +
        "BUILD_STRATEGY='hermes-ink'; " +
        "else echo '[~] Hermes TUI repair: hermes-ink build failed, trying ui-tui build...' >&2; fi; " +
        "fi; " +
        "[ -f node_modules/@hermes/ink/dist/ink-bundle.js ] || { " +
        "npm run build || { " +
        "echo '[!] Hermes TUI repair: ui-tui build failed' >&2; exit 1; }; " +
        "BUILD_STRATEGY='ui-tui'; " +
        "}; " +
        "[ -f node_modules/@hermes/ink/dist/ink-bundle.js ] || { " +
        "echo '[!] Hermes TUI repair: ink-bundle.js is still missing after repair' >&2; exit 1; }; " +
        "echo \"[~] Hermes TUI repair strategy: $BUILD_STRATEGY\" >&2; " +
        "}; " +
        "fi; " +
        "fi; ";

    return (
        "export TERM=xterm-256color; " +
        "stty cols \\${COLUMNS:-80} rows \\${LINES:-24} >/dev/null 2>&1 || true; " +
        tuiRepair +
        "if [ -x /opt/hermes/.venv/bin/hermes ]; then " +
        "exec /opt/hermes/.venv/bin/hermes --tui; " +
        "elif command -v hermes >/dev/null 2>&1; then " +
        "exec hermes --tui; " +
        "else echo '[!] Hermes CLI not found in container PATH' >&2; exit 127; fi"
    );
}
