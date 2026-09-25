/** @jest-environment node */
// T10: the attached agent writes into ~/Hivra, so the Files routes read what
// it planted there. The descriptor guard (guarded-files.cjs, Linux only: it
// walks /proc/self/fd) never follows a planted symlink to the computer's own
// token and never reads a FIFO, and the listing does not reveal either.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createGuardedFiles } = require("../../../../provisioner/hivra-chat/guarded-files.cjs") as {
  createGuardedFiles: (home: string) => {
    read: (relative: string, limit: number) => { content: string };
    write: (relative: string, content: string) => unknown;
    list: (relative: string) => { entries: Array<{ name: string }> };
  };
};

const linux = process.platform === "linux";
let temporary: string;
afterEach(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

(linux ? it : it.skip)("never follows an agent-planted symlink to ~/.hivra/api-token and never reads a FIFO (T10)", () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-workspace-guard-"));
  const home = path.join(temporary, "bux");
  fs.mkdirSync(path.join(home, ".hivra"), { recursive: true });
  fs.mkdirSync(path.join(home, "Hivra"));
  const token = path.join(home, ".hivra", "api-token");
  fs.writeFileSync(token, "a".repeat(64));
  fs.writeFileSync(path.join(home, "Hivra", "notes.md"), "the owner's notes");
  // What an agent with write access to ~/Hivra can plant, under innocent names.
  fs.symlinkSync(token, path.join(home, "Hivra", "readme.md"));
  fs.symlinkSync("../.hivra/api-token", path.join(home, "Hivra", "relative.md"));
  fs.symlinkSync(path.join(home, ".hivra"), path.join(home, "Hivra", "folder"));
  execFileSync("mkfifo", [path.join(home, "Hivra", "pipe.md")]);

  const guard = createGuardedFiles(home);
  expect(guard.read("Hivra/notes.md", 4096).content).toBe("the owner's notes");
  for (const name of ["Hivra/readme.md", "Hivra/relative.md", "Hivra/folder/api-token", "Hivra/pipe.md"]) {
    // A FIFO with no writer would block a plain open or read; this returns at once.
    expect(() => guard.read(name, 4096)).toThrow();
    expect(() => guard.write(name, "overwritten")).toThrow();
  }
  expect(() => guard.list("Hivra/folder")).toThrow();
  expect(guard.list("Hivra").entries.map((entry) => entry.name)).toEqual(["notes.md"]);
  expect(fs.readFileSync(token, "utf8")).toBe("a".repeat(64));
});
