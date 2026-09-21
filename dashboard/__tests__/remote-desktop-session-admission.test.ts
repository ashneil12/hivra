import { execFileSync } from "node:child_process";
import path from "node:path";

// Executes the real remote-desktop RPCs against PostgreSQL (PGlite), so
// transport admission is proven behaviorally rather than by asserting string
// fragments in the migration text. This guards the class of bug where a
// transport is admitted at session issue but rejected by a later RPC: the
// session is created, then the handoff fails on exchange or authorization.
it("admits selkies-websocket on Wayland through issue, exchange, authorize and renewal", () => {
  const output = execFileSync(process.execPath, [
    path.join(process.cwd(), "scripts/test-remote-desktop-sessions.cjs"),
  ], { encoding: "utf8", timeout: 60_000 });
  expect(output).toContain("remote-desktop-session checks passed:");
}, 70_000);
