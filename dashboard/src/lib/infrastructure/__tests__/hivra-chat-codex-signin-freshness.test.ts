import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// A Codex re-sign-in must not be reported as finished while the computer still
// holds the previous credential. The gateway's freshness helpers are lifted out
// of the real provisioner/hivra-chat/server.js and run against a real auth file.
const SOURCE = fs.readFileSync(path.join(process.cwd(), "provisioner/hivra-chat/server.js"), "utf8");
const block = SOURCE.slice(
  SOURCE.indexOf("// ---- BEGIN codex-sign-in-freshness ----"),
  SOURCE.indexOf("// ---- END codex-sign-in-freshness ----"),
);

function load(home: string) {
  const sandbox = {
    path, fs, crypto: require("crypto"), HOME: home, AGENT_ENV: { CODEX_HOME: home }, process: { env: {} },
    loginState: null as unknown,
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  const fingerprint = () => vm.runInContext("codexAuthFingerprint()", sandbox) as string | null;
  const fresh = () => vm.runInContext("codexSignInFresh()", sandbox) as boolean | null;
  const setLogin = (state: object | null) => { sandbox.loginState = state; };
  return { fingerprint, fresh, setLogin };
}

describe("codex sign-in freshness", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-")); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const auth = () => path.join(home, "auth.json");

  it("is unknown when no sign-in was started", () => {
    expect(block).toContain("function codexSignInFresh");
    expect(load(home).fresh()).toBeNull();
  });

  it("stays not-fresh while the old credential is untouched", () => {
    fs.writeFileSync(auth(), "old");
    const s = load(home);
    s.setLogin({ baseline: s.fingerprint(), done: false, ok: false, exit: null });
    expect(s.fresh()).toBe(false);
  });

  it("is fresh once the auth file changes", () => {
    fs.writeFileSync(auth(), "old");
    const s = load(home);
    s.setLogin({ baseline: s.fingerprint(), done: false, ok: false, exit: null });
    fs.writeFileSync(auth(), "new");
    expect(s.fresh()).toBe(true);
  });

  it("is fresh on a first sign-in (no previous file)", () => {
    const s = load(home);
    s.setLogin({ baseline: s.fingerprint(), done: false, ok: false, exit: null });
    expect(s.fresh()).toBe(false);
    fs.writeFileSync(auth(), "new");
    expect(s.fresh()).toBe(true);
  });

  it("is fresh when the CLI itself reports success", () => {
    fs.writeFileSync(auth(), "same");
    const s = load(home);
    s.setLogin({ baseline: s.fingerprint(), done: true, ok: false, exit: 0 });
    expect(s.fresh()).toBe(true);
  });
});

describe("gateway wiring", () => {
  it("snapshots the credential at start, reports fresh in status, and gates complete on it", () => {
    expect(SOURCE).toContain("baseline: codexAuthFingerprint()");
    expect(SOURCE).toContain("fresh: codexSignInFresh()");
    expect(SOURCE).toContain("codexSignInFresh() !== false");
  });
});
