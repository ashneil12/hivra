// The kit an agent gets for its linked computers, and the guest program that
// installs it on the agent's own computer. Pure (no server imports).
//
// The kit is:
//   /usr/local/bin/hivra-computers   the CLI (root-owned, 0755)
//   ~/.hivra/link.json               the agent's key and Hivra's address (0600)
//   ~/.hivra/COMPUTERS.md            which computers it can use, and how
//   <skills>/hivra-computers/SKILL.md for each runtime that reads skills
//                                     (~/.claude/skills, ~/.agents/skills,
//                                     ~/.openclaw/skills, when present)
// With no linked computer the same program removes all of it but the CLI,
// which then says the agent has no computers.
//
// Files in the agent's home are written by a child that has already dropped to
// that home's owner, so a link the agent planted can only point the write at
// a file the agent could change anyway. The request travels as base64 JSON on
// stdin; the program text is fixed.

import { linkLabel } from "./eligibility";

export const KIT_RESULT_PREFIX = "HIVRA_LINK_KIT ";
export const KIT_CLI_VERSION = "2026.10.19.1";

export interface KitComputer {
  id: string;
  name: string;
  kind: string;
}

export const HIVRA_COMPUTERS_CLI = String.raw`#!/usr/bin/env python3
# hivra-computers: use the other computers your owner linked to you in Hivra.
# Installed and kept up to date by Hivra. Version ${KIT_CLI_VERSION}.
import argparse, base64, json, os, shlex, sys, urllib.error, urllib.request

CONFIG = os.path.expanduser("~/.hivra/link.json")

def fail(message, code=2):
    sys.stderr.write("hivra-computers: " + message + "\n")
    sys.exit(code)

def config():
    try:
        with open(CONFIG) as stream:
            value = json.load(stream)
        return value["endpoint"], value["key"]
    except (OSError, ValueError, KeyError):
        fail("no computers are linked to this agent. The owner can link one in Hivra: Manage, then Computers.")

def call(method, body=None, timeout=60):
    endpoint, key = config()
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(endpoint, data=data, method=method, headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "hivra-computers/${KIT_CLI_VERSION}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.load(error)
        except ValueError:
            payload = {}
        fail(payload.get("error") or "Hivra answered %d." % error.code)
    except (urllib.error.URLError, OSError, ValueError) as error:
        fail("couldn't reach Hivra: %s" % error)
    if not payload.get("success"):
        fail(payload.get("error") or "Hivra refused the request.")
    return payload["data"]

def run(computer, command, stdin=b"", timeout=60):
    body = {"computer": computer, "command": command, "timeoutSeconds": timeout}
    if stdin:
        body["stdinBase64"] = base64.b64encode(stdin).decode()
    return call("POST", body, timeout=timeout + 60)

def emit(result):
    sys.stdout.buffer.write(base64.b64decode(result["stdoutBase64"]))
    sys.stdout.flush()
    sys.stderr.buffer.write(base64.b64decode(result["stderrBase64"]))
    if result.get("stdoutTruncated") or result.get("stderrTruncated"):
        sys.stderr.write("\nhivra-computers: output was cut short. Write long output to a file and pull it.\n")
    if result.get("timedOut"):
        sys.stderr.write("\nhivra-computers: the command ran out of time and was stopped. Use --timeout (up to 120) or run it in the background with nohup.\n")
    return int(result["exitCode"])

def main():
    parser = argparse.ArgumentParser(prog="hivra-computers", description="Use the computers linked to you in Hivra.")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("list", help="list the computers you can use")
    p_run = sub.add_parser("run", help="run a shell command on a computer")
    p_run.add_argument("computer")
    p_run.add_argument("--timeout", type=int, default=60)
    p_run.add_argument("--stdin-file", help="send this local file as the command's stdin")
    p_run.add_argument("command", nargs="*")
    p_push = sub.add_parser("push", help="copy a local file to a computer")
    p_push.add_argument("computer"); p_push.add_argument("local"); p_push.add_argument("remote")
    p_pull = sub.add_parser("pull", help="copy a file from a computer")
    p_pull.add_argument("computer"); p_pull.add_argument("remote"); p_pull.add_argument("local", nargs="?")
    p_shot = sub.add_parser("screenshot", help="save a screenshot of a computer's desktop")
    p_shot.add_argument("computer"); p_shot.add_argument("local", nargs="?", default="screenshot.png")
    argv = sys.argv[1:]
    # Everything after "--" is the remote command, flags and all.
    remote = None
    if argv[:1] == ["run"] and "--" in argv:
        cut = argv.index("--")
        argv, remote = argv[:cut], argv[cut + 1:]
    args = parser.parse_args(argv)
    if remote is not None:
        args.command = remote

    if args.action == "list":
        data = call("GET")
        computers = data.get("computers", [])
        if not computers:
            print("No computers are linked to you yet. Your owner can link one in Hivra.")
            return 0
        for computer in computers:
            state = "ready" if computer.get("ready") else computer.get("reason") or "not ready"
            print("%s\t%s\t%s\t%s" % (computer["name"], computer["kind"], computer["id"], state))
        return 0
    if args.action == "run":
        words = args.command
        if not words:
            fail("give a command, e.g. hivra-computers run %s -- uname -a" % args.computer)
        command = words[0] if len(words) == 1 else " ".join(words)
        stdin = b""
        if args.stdin_file:
            with open(args.stdin_file, "rb") as stream:
                stdin = stream.read()
        return emit(run(args.computer, command, stdin, args.timeout))
    if args.action == "push":
        with open(args.local, "rb") as stream:
            content = stream.read()
        target = shlex.quote(args.remote)
        result = run(args.computer, "mkdir -p -- \"$(dirname -- %s)\" && cat > %s" % (target, target), content, 120)
        return emit(result)
    if args.action == "pull":
        result = run(args.computer, "base64 -w0 -- %s" % shlex.quote(args.remote), b"", 120)
        if int(result["exitCode"]) != 0:
            return emit(result)
        if result.get("stdoutTruncated"):
            fail("the file is too large to pull this way (about 190 KB at most). Split it or compress it first.")
        content = base64.b64decode(base64.b64decode(result["stdoutBase64"]))
        local = args.local or os.path.basename(args.remote.rstrip("/")) or "pulled-file"
        with open(local, "wb") as stream:
            stream.write(content)
        print("saved %s (%d bytes)" % (local, len(content)))
        return 0
    if args.action == "screenshot":
        grab = ("set -e; f=$(mktemp --suffix=.png); "
                "if command -v grim >/dev/null && [ -n \"$WAYLAND_DISPLAY\" ]; then grim \"$f\"; "
                "elif command -v import >/dev/null && [ -n \"$DISPLAY\" ]; then import -window root \"$f\"; "
                "elif command -v scrot >/dev/null && [ -n \"$DISPLAY\" ]; then scrot -o \"$f\"; "
                "else echo 'no desktop screen this command can capture on this computer' >&2; exit 3; fi; "
                "base64 -w0 \"$f\"; rm -f \"$f\"")
        result = run(args.computer, grab, b"", 60)
        if int(result["exitCode"]) != 0 or result.get("stdoutTruncated"):
            if result.get("stdoutTruncated"):
                fail("the screenshot is too large to send.")
            return emit(result)
        with open(args.local, "wb") as stream:
            stream.write(base64.b64decode(base64.b64decode(result["stdoutBase64"])))
        print("saved %s" % args.local)
        return 0
    return 2

if __name__ == "__main__":
    sys.exit(main())
`;

function computerLines(computers: KitComputer[]): string[] {
  return computers.map((computer) => `- ${linkLabel(computer.name)} (${computer.kind}), id \`${computer.id}\``);
}

/** ~/.hivra/COMPUTERS.md: what the agent can use, in its own words. */
export function renderComputersNote(agentName: string, computers: KitComputer[]): string {
  return [
    "# Computers you can use",
    "",
    `Your owner linked these computers to you (${linkLabel(agentName, "this agent")}) in Hivra. You can run commands and move files on them with the \`hivra-computers\` command. Hivra keeps this file current; it changes when your owner links or removes a computer.`,
    "",
    ...computerLines(computers),
    "",
    "## How",
    "",
    "- `hivra-computers list` shows them and whether each one is running.",
    "- `hivra-computers run <computer> -- <command>` runs a shell command there as that computer's own user, in its home folder, and prints its output. The computer can be named by its name or its id. Commands stop after 60 seconds unless you pass `--timeout` (at most 120); start longer work with `nohup … &` and check on it later.",
    "- `hivra-computers push <computer> <local file> <remote path>` and `hivra-computers pull <computer> <remote path> [local file]` copy files.",
    "- `hivra-computers screenshot <computer> [file.png]` saves a picture of its desktop, when the computer has a desktop session and a capture tool.",
    "",
    "These computers belong to your owner. Do there only what your owner asked, and say what you did.",
    "",
  ].join("\n");
}

export function renderComputersSkill(computers: KitComputer[]): string {
  const names = computers.slice(0, 8).map((computer) => linkLabel(computer.name)).join(", ");
  const more = computers.length > 8 ? ` and ${computers.length - 8} more` : "";
  return [
    "---",
    "name: hivra-computers",
    `description: Run commands, copy files and take screenshots on the other computers your owner linked to you in Hivra (${names}${more}). Use when asked to do something on, check, set up or fix one of those computers.`,
    "---",
    "",
    renderComputersNote("you", computers).replace(/^# Computers you can use\n\n/, ""),
  ].join("\n");
}

export interface KitRequest {
  /** "install" writes the kit; "remove" takes it away (no linked computers). */
  mode: "install" | "remove";
  cli: string;
  link?: { endpoint: string; key: string; agentId: string };
  note?: string;
  skill?: string;
}

export const KIT_GUEST_PROGRAM = String.raw`
import base64, hashlib, json, os, pwd, stat, sys
PREFIX = "HIVRA_LINK_KIT "
def done(**fields):
    sys.stdout.write(PREFIX + json.dumps(fields, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    sys.exit(0)
try:
    request = json.loads(base64.b64decode(sys.stdin.read()))
    owner = pwd.getpwnam("bux")
except Exception:
    done(status="refused", reason="no_agent_user")
HOME = owner.pw_dir
SKILL_BASES = [(".claude", ".claude/skills"), (".agents", ".agents/skills"), (".codex", ".agents/skills"), (".openclaw", ".openclaw/skills")]
def write_root(path, text, mode):
    tmp = path + ".hivra-tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)
    os.chmod(tmp, mode)
    os.chown(tmp, 0, 0)
    os.replace(tmp, path)
CLI = "/usr/local/bin/hivra-computers"
try:
    os.makedirs("/usr/local/bin", exist_ok=True)
    write_root(CLI, request["cli"], 0o755)
except OSError:
    done(status="refused", reason="cli_write_failed")
pid = os.fork()
if pid == 0:
    code = 0
    try:
        os.setgid(owner.pw_gid)
        os.initgroups(owner.pw_name, owner.pw_gid)
        os.setuid(owner.pw_uid)
        os.umask(0o077)
        def put(rel, text, mode):
            path = os.path.join(HOME, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".hivra-tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, "w") as stream:
                stream.write(text)
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        def drop(rel):
            path = os.path.join(HOME, rel)
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            try:
                os.rmdir(os.path.dirname(path))
            except OSError:
                pass
        skill_paths = sorted({os.path.join(base, "hivra-computers", "SKILL.md")
                              for marker, base in SKILL_BASES if os.path.isdir(os.path.join(HOME, marker))})
        if request["mode"] == "install":
            put(".hivra/link.json", json.dumps(request["link"], indent=2) + "\n", 0o600)
            put(".hivra/COMPUTERS.md", request["note"], 0o644)
            # A runtime's skills folder the agent's user can't write is skipped;
            # the CLI and COMPUTERS.md still reach the agent.
            for rel in skill_paths:
                try:
                    put(rel, request["skill"], 0o644)
                except OSError:
                    pass
        else:
            for rel in [".hivra/link.json", ".hivra/COMPUTERS.md"]:
                try:
                    os.unlink(os.path.join(HOME, rel))
                except FileNotFoundError:
                    pass
            for rel in skill_paths:
                drop(rel)
    except Exception:
        code = 1
    os._exit(code)
_, status = os.waitpid(pid, 0)
if status != 0:
    done(status="refused", reason="home_write_failed")
done(status="delivered", mode=request["mode"])
`;

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** One script both seed lanes run as root: starts with `set -e`, request on stdin only. */
export function buildKitGuestScript(request: KitRequest): string {
  return `set -e
command -v python3 >/dev/null 2>&1 || { echo "python3 missing" >&2; exit 1; }
printf '%s' '${b64(JSON.stringify(request))}' | python3 -I -B -c "$(printf '%s' '${b64(KIT_GUEST_PROGRAM)}' | base64 -d)"
`;
}

export type KitOutcome = { status: "delivered"; mode: "install" | "remove" } | { status: "refused"; reason: string };

export function parseKitOutput(stdout: string): KitOutcome | null {
  const lines = stdout.split("\n").filter((line) => line.startsWith(KIT_RESULT_PREFIX));
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0].slice(KIT_RESULT_PREFIX.length)) as Record<string, unknown>;
    if (value.status === "delivered" && (value.mode === "install" || value.mode === "remove")) {
      return { status: "delivered", mode: value.mode };
    }
    if (value.status === "refused" && typeof value.reason === "string" && /^[a-z_]{1,40}$/.test(value.reason)) {
      return { status: "refused", reason: value.reason };
    }
  } catch { /* not an answer */ }
  return null;
}
