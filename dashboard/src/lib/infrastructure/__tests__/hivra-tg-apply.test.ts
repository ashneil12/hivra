/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The root helper the chat gateway runs (via scoped sudo) when the owner
// connects Telegram. It is exercised for real with systemctl/install/chgrp
// stubbed on PATH and its fixed /etc/bux directory pointed at a temp dir.
const HELPER = readFileSync(path.join(process.cwd(), "provisioner/hivra-tg-apply"), "utf8");

describe("hivra-tg-apply", () => {
  let root: string;
  let envDir: string;
  let helper: string;
  let log: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "hivra-tg-apply-")));
    envDir = path.join(root, "etc-bux");
    log = path.join(root, "calls.log");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    // systemctl records each call; a restart also records the tg.env it would load.
    writeFileSync(path.join(bin, "systemctl"), `#!/usr/bin/env bash
if [ "$1" = restart ]; then
  printf 'systemctl restart %s with %s\\n' "$2" "$(tr '\\n' ' ' < "$TG_ENV_DIR_UNDER_TEST/tg.env")" >> "$CALLS"
else
  printf 'systemctl %s\\n' "$*" >> "$CALLS"
fi
`, { mode: 0o755 });
    writeFileSync(path.join(bin, "install"), "#!/usr/bin/env bash\nfor last; do :; done\nmkdir -p \"$last\"\n", { mode: 0o755 });
    writeFileSync(path.join(bin, "chgrp"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const pointed = HELPER.replace("TG_ENV_DIR=/etc/bux\n", `TG_ENV_DIR=${envDir}\n`);
    expect(pointed).not.toBe(HELPER);
    helper = path.join(root, "hivra-tg-apply");
    writeFileSync(helper, pointed, { mode: 0o755 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(action: string, input = "") {
    return spawnSync("bash", [helper, action], {
      input,
      encoding: "utf8",
      env: { PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, CALLS: log, TG_ENV_DIR_UNDER_TEST: envDir } as unknown as NodeJS.ProcessEnv,
    });
  }
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

  it("restarts the bot on every apply so a new token or pairing link takes effect", () => {
    const first = run("apply", "TG_BOT_TOKEN=111:first\nTG_SETUP_TOKEN=pair-one\n");
    expect(first.status).toBe(0);
    expect(readFileSync(path.join(envDir, "tg.env"), "utf8")).toBe("TG_BOT_TOKEN=111:first\nTG_SETUP_TOKEN=pair-one\n");
    expect(statSync(path.join(envDir, "tg.env")).mode & 0o777).toBe(0o640);

    // The bot is already running when the owner reconnects with a new token;
    // `enable --now` would leave it on the old one.
    const second = run("apply", "TG_BOT_TOKEN=222:second\nTG_SETUP_TOKEN=pair-two\n");
    expect(second.status).toBe(0);
    expect(calls()).toEqual([
      "systemctl enable bux-tg",
      "systemctl restart bux-tg with TG_BOT_TOKEN=111:first TG_SETUP_TOKEN=pair-one ",
      "systemctl enable bux-tg",
      "systemctl restart bux-tg with TG_BOT_TOKEN=222:second TG_SETUP_TOKEN=pair-two ",
    ]);
  });

  it("disables the bot and removes its token", () => {
    expect(run("apply", "TG_BOT_TOKEN=111:first\n").status).toBe(0);
    expect(run("disable").status).toBe(0);
    expect(existsSync(path.join(envDir, "tg.env"))).toBe(false);
    expect(calls().slice(-1)).toEqual(["systemctl disable --now bux-tg"]);
  });

  it("rejects an unknown action without touching the bot", () => {
    const result = run("start");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: hivra-tg-apply apply|disable");
    expect(calls()).toEqual([]);
  });
});
