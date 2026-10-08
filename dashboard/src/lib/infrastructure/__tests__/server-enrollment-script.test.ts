/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadServerEnrollScriptBody,
  renderEnrollFinalLine,
  renderRefusalLine,
  SERVER_ENROLL_ACCEPTED_REPORT_VERSIONS,
  SERVER_ENROLL_SCRIPT_RELEASES,
  SERVER_ENROLL_SCRIPT_SHA256,
  SERVER_ENROLL_SCRIPT_VERSION,
  ServerEnrollScriptError,
  serverEnrollmentCommands,
  servedScript,
  serverUninstallCommand,
  UNINSTALL_FINAL_LINE,
  type ServerEnrollRefusal,
} from "../server-enrollment-script";

const SCRIPT = join(__dirname, "../../../../bootstrap/server-enroll.sh");
const FILE = readFileSync(SCRIPT);

/** Every released body, never edited. Adding a release means adding its pair
 * here too, so a version and its sha256 always change together (T6). */
const FROZEN_RELEASES = [
  { version: "2026.09.24.1", sha256: "e1ec492a165f21addfa515883b06bad3693e9234c99c63ea5191b9ed46689cfe" },
];

const VALID = {
  origin: "https://hivra.example",
  code: "hse1_" + "a".repeat(32),
  adminPublicKey: "ssh-ed25519 " + "AAAAC3NzaC1lZDI1NTE5AAAA" + "B".repeat(44),
  accountCode: "K7QM-2XRA",
};

describe("pinned setup script (T6)", () => {
  it("serves exactly the file whose sha256 is pinned, as the newest frozen release", () => {
    expect(SERVER_ENROLL_SCRIPT_RELEASES).toEqual(FROZEN_RELEASES);
    expect(SERVER_ENROLL_SCRIPT_VERSION).toBe(FROZEN_RELEASES[FROZEN_RELEASES.length - 1].version);
    expect(SERVER_ENROLL_SCRIPT_SHA256).toBe(createHash("sha256").update(FILE).digest("hex"));
    expect(SERVER_ENROLL_ACCEPTED_REPORT_VERSIONS).toEqual(FROZEN_RELEASES.slice(-2).map(release => release.version));
    expect(FILE.toString("ascii")).toContain(`hse_version() {\n  printf '%s' '${SERVER_ENROLL_SCRIPT_VERSION}'\n}`);
  });

  it("loads the body only when it is the pinned bytes", async () => {
    await expect(loadServerEnrollScriptBody(async () => FILE)).resolves.toBe(FILE.toString("ascii"));
    const changed = Buffer.from(FILE);
    changed[10] = changed[10] === 0x61 ? 0x62 : 0x61;
    for (const read of [
      async () => changed,
      async () => Buffer.concat([FILE, Buffer.from("echo extra\n")]),
      async () => FILE.subarray(0, FILE.length - 1),
      async () => Buffer.alloc(0),
      async () => { throw new Error("ENOENT"); },
    ]) {
      await expect(loadServerEnrollScriptBody(read)).rejects.toEqual(new ServerEnrollScriptError("script_unavailable"));
    }
  });

  it("is plain ASCII, ends in a newline and holds only function definitions and constants", () => {
    const text = FILE.toString("latin1");
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(text)).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    // No top-level command runs when the body alone is read by bash: every
    // top-level line is a comment, blank, a function header, a readonly
    // constant, inside a function body, or the shebang.
    let depth = 0;
    for (const line of text.split("\n")) {
      if (depth === 0 && line.trim() && !line.startsWith("#")) {
        expect(line).toMatch(/^(hse_[a-z0-9_]+|hivra_(enroll_entry|uninstall_entry|refuse))\(\) \{$|^readonly HSE_[A-Z0-9_]+=|^HSE_[A-Z0-9_]+=/);
      }
      if (/^[a-z_0-9]+\(\) \{$/.test(line)) depth += 1;
      if (line === "}") depth -= 1;
    }
    expect(depth).toBe(0);
  });

  it("names no body function by a proper prefix of an entry function (T7)", () => {
    const names = [...FILE.toString("ascii").matchAll(/^([a-z_0-9]+)\(\) \{$/gm)].map(match => match[1]);
    const entries = ["hivra_enroll_entry", "hivra_uninstall_entry", "hivra_refuse"];
    for (const entry of entries) expect(names).toContain(entry);
    for (const name of names) {
      for (const entry of entries) {
        if (name !== entry) expect(entry.startsWith(name)).toBe(false);
      }
    }
  });
});

describe("final lines (T7, T8, T20)", () => {
  it("renders one brace group with the caller's arguments first and both sentinels", () => {
    const line = renderEnrollFinalLine(VALID);
    expect(line).toBe(
      `{ hivra_enroll_entry "$@" HIVRA_ARGS_V1 'https://hivra.example' '${VALID.code}' '${VALID.adminPublicKey}' 'K7QM-2XRA' HIVRA_END_V1; }`,
    );
    expect(line).not.toContain("\n");
    expect(line.startsWith('{ hivra_enroll_entry "$@" HIVRA_ARGS_V1 ')).toBe(true);
    expect(line.endsWith(" HIVRA_END_V1; }")).toBe(true);
    expect(servedScript("body\n", line)).toBe("body\n" + line + "\n");
  });

  it.each(["missing_code", "expired_or_used", "fetch_limit"] as const)("renders the %s refusal as one brace group", reason => {
    expect(renderRefusalLine(reason)).toBe(`{ hivra_refuse '${reason}'; }`);
  });

  it("refuses a refusal reason it doesn't know", () => {
    expect(() => renderRefusalLine("x'; rm -rf /" as ServerEnrollRefusal)).toThrow(ServerEnrollScriptError);
  });

  it("renders the uninstall line with no values of its own", () => {
    expect(UNINSTALL_FINAL_LINE).toBe('{ hivra_uninstall_entry "$@" HIVRA_END_V1; }');
  });

  const HOSTILE = ["'", "$(", "`", "}", ";", "\n", "\r", "\u0000", "\\", "{", "é", "\u202e", " ", "$"];
  it.each(Object.keys(VALID) as Array<keyof typeof VALID>)("refuses hostile characters in %s", field => {
    for (const hostile of HOSTILE) {
      for (const value of [VALID[field] + hostile, hostile + VALID[field], VALID[field].slice(0, 6) + hostile + VALID[field].slice(7)]) {
        expect(() => renderEnrollFinalLine({ ...VALID, [field]: value })).toThrow(ServerEnrollScriptError);
      }
    }
  });

  it("refuses every value that is not exactly its pattern (property test)", () => {
    const alphabet = "abcAZ09+/=-_.:'\"$`(){};\\\n\r\t \u0000\u00e9";
    const randomString = (max: number) => {
      const length = randomBytes(1)[0] % max;
      return [...randomBytes(length)].map(byte => alphabet[byte % alphabet.length]).join("");
    };
    for (let index = 0; index < 3_000; index += 1) {
      for (const field of Object.keys(VALID) as Array<keyof typeof VALID>) {
        const value = randomString(96);
        let line: string | null = null;
        try {
          line = renderEnrollFinalLine({ ...VALID, [field]: value });
        } catch (error) {
          expect(error).toBeInstanceOf(ServerEnrollScriptError);
        }
        if (line !== null) {
          // Accepted only if it is a well-formed value, and then it can't
          // leave its single quotes.
          expect(value).not.toMatch(/['\\$`{};\n\r\0]/);
          expect(line.split("'").length).toBe(9);
        }
      }
    }
  });

  it.each([
    "http://hivra.example", "https://hivra.example:8443", "https://user@hivra.example", "https://hivra.example/path",
    "https://hivra.example?x=1", "https://HIVRA.example", "https://hivra.example/", "https:// hivra.example",
  ])("refuses an unusable origin %p", origin => {
    if (origin === "https://hivra.example/" || origin === "https://HIVRA.example") {
      // URL normalisation gives a bare lowercase origin; the rendered value is that.
      expect(renderEnrollFinalLine({ ...VALID, origin })).toContain("'https://hivra.example'");
      return;
    }
    expect(() => renderEnrollFinalLine({ ...VALID, origin })).toThrow(ServerEnrollScriptError);
  });
});

describe("commands the panel shows (T25)", () => {
  it("puts the code only in the Authorization header, never in the URL, and never follows redirects", () => {
    const commands = serverEnrollmentCommands("https://hivra.example", VALID.code);
    const fetch = `curl -fsS --proto '=https' -H 'Authorization: Bearer ${VALID.code}' https://hivra.example/enroll`;
    expect(commands).toEqual({
      command: fetch + " | sudo bash",
      dryRunCommand: fetch + " | bash -s -- --dry-run",
      downloadCommand: fetch + " -o hivra-enroll.sh",
      uninstallCommand: "curl -fsS --proto '=https' https://hivra.example/enroll/uninstall | sudo bash",
    });
    for (const command of Object.values(commands)) {
      expect(command).not.toMatch(/ -L\b|--location/);
      expect(command).not.toMatch(/https:\/\/\S*hse1_/);
    }
    expect(serverUninstallCommand("https://hivra.example")).toBe(commands.uninstallCommand);
  });

  it("refuses a malformed code", () => {
    expect(() => serverEnrollmentCommands("https://hivra.example", "hse1_x'; id")).toThrow(ServerEnrollScriptError);
  });
});

// The script's own offline harness (bootstrap/test_server_enroll.py): the
// body piped into real bash with stub commands and a real pseudo-terminal
// (T5, T7, T9 to T14, T28, T30, T35, T38 to T40, T42, dry-run, re-enrollment,
// uninstall). About a minute on Linux, two on macOS.
describe("the script's offline harness", () => {
  it("passes", () => {
    const result = spawnSync("python3", ["-B", "bootstrap/test_server_enroll.py"], { encoding: "utf8", timeout: 400_000 });
    expect(result.stderr).toMatch(/\nOK\s*$/);
    expect(result.status).toBe(0);
  }, 420_000);
});
