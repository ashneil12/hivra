import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";

/**
 * A box on disk for running the generated update scripts for real: a fake
 * `docker` (state in one JSON file), a `curl` that plays the dashboard, and a
 * rewritten filesystem root so the scripts' /opt, /run, /var and /usr/local
 * paths land in a temp directory. Everything else (bash, awk, sed, python3,
 * sqlite3) is the real thing.
 */

export const FAKE_DOCKER_PY = String.raw`#!/usr/bin/env python3
import json, os, sys

STATE = os.environ["FAKE_DOCKER_STATE"]
state = json.load(open(STATE))
args = sys.argv[1:]
state.setdefault("calls", []).append(" ".join(args))

def save():
    json.dump(state, open(STATE, "w"), indent=1)

def resolve(ref):
    if ref in state["refs"]:
        return state["refs"][ref]
    if ref in state["images"]:
        return ref
    if "@sha256:" in ref:
        for image_id, meta in state["images"].items():
            if ref in meta.get("digests", []):
                return image_id
    return None

def fmt_value(args):
    for flag in ("-f", "--format"):
        if flag in args:
            return args[args.index(flag) + 1]
    for a in args:
        if a.startswith("--format="):
            return a[len("--format="):]
    return ""

def done(code=0):
    save()
    sys.exit(code)

def out(text):
    sys.stdout.write(text)

cmd = args[0] if args else ""
rest = args[1:]

def positional(args):
    skip = False
    for a in args:
        if skip:
            skip = False
            continue
        if a in ("-f", "--format"):
            skip = True
            continue
        if a.startswith("-"):
            continue
        return a
    return ""

if cmd == "inspect":
    name = positional(rest)
    c = state["containers"].get(name)
    if c is None:
        done(1)
    f = fmt_value(rest)
    if "running={{.State.Running}}" in f:
        out("running=%s health=%s\n" % (str(c.get("running", True)).lower(), c.get("health", "healthy")))
    elif "{{if .State.Running}}{{if .State.Health}}" in f:
        out((c.get("health", "healthy") if c.get("running", True) else "") + "\n")
    elif ".Mounts" in f:
        out("/home/hermes/.hermes " + state.get("sessions_volume", "") + "\n")
    elif ".State.Health" in f:
        out(c.get("health", "healthy") + "\n")
    elif ".Name" in f:
        out("/" + name + "\n")
    elif ".Image" in f:
        out(c["image"] + "\n")
    done(0)

elif cmd == "image" and rest[0] == "inspect":
    ref = rest[1]
    image_id = resolve(ref)
    if image_id is None:
        done(1)
    f = fmt_value(rest)
    if "RepoDigests" in f:
        for d in state["images"][image_id].get("digests", []):
            out(d + "\n")
    else:
        out(image_id + "\n")
    done(0)

elif cmd == "exec":
    if rest[1:3] == ["cat", state.get("source_stamp_path", "")]:
        stamp = state.get("source_stamp")
        if stamp is None:
            done(1)
        out(stamp + "\n")
    done(0)

elif cmd == "create":
    ref = positional(rest)
    image_id = resolve(ref)
    if image_id is None:
        done(1)
    cid = "cid%d" % (len(state.setdefault("created", {})) + 1)
    state["created"][cid] = image_id
    out(cid + "\n")
    done(0)

elif cmd == "commit":
    cid, tag = rest[-2], rest[-1]
    base = state.get("created", {}).get(cid)
    if base is None:
        done(1)
    new_id = "sha256:asm-" + base.replace("sha256:", "")
    state["images"][new_id] = dict(state["images"][base], digests=[])
    state["refs"][tag] = new_id
    done(0)

elif cmd == "cp":
    state.setdefault("copied", []).append(rest[0] + " -> " + rest[1])
    done(0)

elif cmd == "pull":
    ref = rest[-1]
    if state.get("pull_fail") or ref not in state["registry"]:
        sys.stderr.write("pull failed: " + ref + "\n")
        done(1)
    state["refs"][ref] = state["registry"][ref]
    done(0)

elif cmd == "tag":
    image_id = resolve(rest[0])
    if image_id is None:
        done(1)
    state["refs"][rest[1]] = image_id
    done(0)

elif cmd == "rmi":
    state["refs"].pop(rest[-1], None)
    done(0)

elif cmd == "ps":
    done(0)

elif cmd == "compose":
    sub = rest[0]
    alias = state["alias"]
    if sub == "config":
        if "--services" in rest:
            out("gateway\nofficial-dashboard\ncaddy\n")
            done(0)
        done(1 if state.get("compose_config_invalid") else 0)
    if sub == "pull":
        if alias in state["registry"]:
            state["refs"][alias] = state["registry"][alias]
        done(0)
    if sub == "stop":
        if state.get("stop_fail"):
            done(1)
        for c in state["containers"].values():
            c["running"] = False
        done(0)
    if sub == "up":
        if state.get("up_fail_for_image") and resolve(alias) == state["up_fail_for_image"]:
            done(1)
        image_id = resolve(alias)
        for name, c in state["containers"].items():
            c["image"] = image_id
            c["running"] = True
            c["health"] = state["images"][image_id].get("health", "healthy")
        state.setdefault("recreates", []).append(image_id)
        if state["images"][image_id].get("wipe_sessions"):
            import sqlite3
            conn = sqlite3.connect(os.path.join(state["sessions_volume"], "state.db"))
            conn.execute("delete from sessions")
            conn.commit()
        done(0)
    done(0)

elif cmd == "run":
    if "--entrypoint" in rest:
        i = rest.index("--entrypoint")
        ref = rest[i + 2]
        image_id = resolve(ref)
        if image_id is None or state["images"][image_id].get("reseed_fail"):
            sys.stderr.write("reseed failed for " + ref + "\n")
            done(1)
        state["source_stamp"] = image_id
    done(0)

else:
    done(0)
`;

export interface BoxImage {
  id: string;
  digests?: string[];
  health?: "healthy" | "unhealthy";
  reseed_fail?: boolean;
  /** A container recreated on this image comes up with every session gone. */
  wipe_sessions?: boolean;
}

export interface FakeBoxOptions {
  instanceId: string;
  repo: string;
  /** Images known to the box's docker, by id. */
  images: BoxImage[];
  /** Image id the gateway and dashboard containers run. */
  running: string;
  /** What `docker pull <ref>` can fetch: ref -> image id. */
  registry?: Record<string, string>;
  /** The release endpoint's answer (plain text key=value lines). */
  releaseReply?: string;
  /** Make the release endpoint unreachable. */
  releaseDown?: boolean;
  /** Sessions in the box's state.db before the roll (null = no database). */
  sessions?: number | null;
}

export interface FakeDockerState {
  images: Record<string, unknown>;
  refs: Record<string, string>;
  containers: Record<string, { image: string; health: string; running: boolean }>;
  registry: Record<string, string>;
  source_stamp: string | null;
  calls: string[];
  recreates?: string[];
  [key: string]: unknown;
}

export class FakeBox {
  readonly root: string;
  readonly bin: string;
  readonly stateFile: string;
  readonly curlLog: string;
  readonly script: string;
  readonly instanceDir: string;
  readonly logFile: string;
  readonly volume: string;
  private readonly opts: FakeBoxOptions;
  private pathOf: (original: string) => string;

  constructor(opts: FakeBoxOptions, rollScript: string) {
    this.opts = opts;
    this.root = mkdtempSync(join(tmpdir(), "fake-box-"));
    this.bin = join(this.root, "bin");
    this.stateFile = join(this.root, "docker.json");
    this.curlLog = join(this.root, "curl.log");
    this.instanceDir = join(this.root, "opt/hermes/instances", opts.instanceId);
    this.logFile = join(this.root, "var/log/hermes-roll.log");
    this.volume = join(this.root, "volume");
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(this.instanceDir, { recursive: true });
    mkdirSync(join(this.root, "run"), { recursive: true });
    mkdirSync(join(this.root, "var/lib"), { recursive: true });
    mkdirSync(join(this.root, "var/log"), { recursive: true });
    mkdirSync(join(this.root, "usr/local/bin"), { recursive: true });
    mkdirSync(this.volume, { recursive: true });
    this.pathOf = (original) => join(this.root, original);

    const rewritten = rollScript
      .replace(/\/opt\/hermes\/instances/g, `${this.root}/opt/hermes/instances`)
      .replace(/\/run\/hermes-/g, `${this.root}/run/hermes-`)
      .replace(/\/var\/lib\/hermes-/g, `${this.root}/var/lib/hermes-`)
      .replace(/\/var\/log\/hermes-roll\.log/g, this.logFile)
      .replace(/\/usr\/local\/bin\//g, `${this.root}/usr/local/bin/`);
    this.script = join(this.root, "roll.sh");
    writeFileSync(this.script, rewritten);

    // The pieces of the box the roll reads.
    writeFileSync(
      join(this.instanceDir, ".env"),
      "# Generated\nHERMES_DASHBOARD_URL=https://dash.example.test\nAPI_SERVER_KEY=box-secret\n"
    );
    writeFileSync(
      join(this.instanceDir, "docker-compose.yml"),
      [
        "services:",
        "  gateway:",
        `    image: ${opts.repo}:stable`,
        '    status_cmd = ["uv", "run", "--no-sync", "--extra", "messaging", "hermes", "gateway", "status"]',
        '    run_cmd = ["uv", "run", "--no-sync", "--extra", "messaging", "hermes", "gateway", "run", "--replace", "--accept-hooks"]',
        "",
      ].join("\n")
    );
    this.writeExecutable(join(this.root, "usr/local/bin", `hermes-idle-sampler-${opts.instanceId}`), "exit 0");
    this.writeExecutable(join(this.root, "usr/local/bin", `hermes-refresh-${opts.instanceId}`), `echo refresh >> "${this.root}/refresh.log"`);

    // A marker old enough that the box counts as idle.
    const mark = this.pathOf(`run/hermes-last-active-${opts.instanceId}`);
    writeFileSync(mark, "1\n");
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(mark, old, old);

    const images: Record<string, unknown> = {};
    for (const image of opts.images) {
      images[image.id] = { digests: image.digests ?? [], health: image.health ?? "healthy", reseed_fail: image.reseed_fail ?? false, wipe_sessions: image.wipe_sessions ?? false };
    }
    const alias = `${opts.repo}:stable`;
    const state = {
      images,
      refs: { [alias]: opts.running },
      containers: {
        [`agent-${opts.instanceId}-gateway`]: { image: opts.running, health: "healthy", running: true },
        [`agent-${opts.instanceId}-official-dashboard`]: { image: opts.running, health: "healthy", running: true },
      },
      registry: opts.registry ?? {},
      alias,
      source_stamp: opts.running,
      source_stamp_path: "/home/hermes/.hermes/hermes-agent/.hermes-image-id",
      sessions_volume: this.volume,
      calls: [] as string[],
    };
    writeFileSync(this.stateFile, JSON.stringify(state));

    this.writeExecutable(join(this.bin, "docker.py"), "", FAKE_DOCKER_PY);
    this.writeExecutable(join(this.bin, "docker"), `exec python3 "${join(this.bin, "docker.py")}" "$@"`);
    this.writeExecutable(
      join(this.bin, "curl"),
      [
        `printf '%s\\n' "$*" >> "${this.curlLog}"`,
        `case "$*" in`,
        // The chat-lane probe asks for the HTTP status; tests set it by writing chat.code.
        `  *http_code*) cat "${this.root}/chat.code" 2>/dev/null || printf 200 ;;`,
        `  */release*) ${opts.releaseDown ? "exit 22" : `printf '%s' '${(opts.releaseReply ?? "action=hold\\nreason=no_release\\n").replace(/'/g, "'\\''")}'`} ;;`,
        `esac`,
        `exit 0`,
      ].join("\n")
    );
    // The scripts target GNU userland; on macOS a thin stat shim keeps the run honest.
    if (process.platform === "darwin") {
      this.writeExecutable(
        join(this.bin, "stat"),
        `if [ "$1" = "-c" ] && [ "$2" = "%Y" ]; then exec /usr/bin/stat -f %m "$3"; fi\nexec /usr/bin/stat "$@"`
      );
    }
    this.writeExecutable(join(this.bin, "sleep"), "exit 0");
    // GNU timeout is not on macOS: run the command unbounded.
    this.writeExecutable(join(this.bin, "timeout"), 'shift\nexec "$@"');

    if (opts.sessions !== undefined && opts.sessions !== null) this.seedSessions(opts.sessions);
  }

  private writeExecutable(path: string, body: string, raw?: string) {
    writeFileSync(path, raw ?? `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }

  seedSessions(count: number) {
    const py = spawnSync(
      "python3",
      [
        "-c",
        `import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute("create table if not exists sessions(id integer primary key)")\nc.execute("delete from sessions")\nc.executemany("insert into sessions(id) values (?)",[(i,) for i in range(${count})]);c.commit()`,
        join(this.volume, "state.db"),
      ],
      { encoding: "utf8" }
    );
    if (py.status !== 0) throw new Error(py.stderr);
  }

  /** Change docker state before a run (e.g. flag a failing pull). */
  patchState(patch: Record<string, unknown>) {
    const state = JSON.parse(readFileSync(this.stateFile, "utf8"));
    Object.assign(state, patch);
    writeFileSync(this.stateFile, JSON.stringify(state));
  }

  /** Run an arbitrary script in the box's environment (paths are not rewritten). */
  runScript(body: string): { status: number | null; stdout: string; stderr: string } {
    const path = join(this.root, "adhoc.sh");
    writeFileSync(path, body);
    const result = spawnSync("bash", [path], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${this.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: this.stateFile, TZ: "UTC" },
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** Run the script once, as systemd would. */
  run(): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("bash", [this.script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${this.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: this.stateFile, TZ: "UTC" },
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  get state(): FakeDockerState {
    return JSON.parse(readFileSync(this.stateFile, "utf8"));
  }

  get log(): string {
    return existsSync(this.logFile) ? readFileSync(this.logFile, "utf8") : "";
  }

  /** Dashboard calls the box made, one query string per line. */
  get dashboardCalls(): string[] {
    return existsSync(this.curlLog) ? readFileSync(this.curlLog, "utf8").split("\n").filter(Boolean) : [];
  }

  get reports(): string[] {
    return this.dashboardCalls.filter((line) => !line.includes("/release"));
  }

  get pauseFile(): string {
    return this.pathOf(`var/lib/hermes-roll-paused-${this.opts.instanceId}`);
  }

  exists(relative: string): boolean {
    return existsSync(this.pathOf(relative));
  }

  destroy() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Decode the embedded script bodies of a buildIdleGatedUpdateProvisioningScript output. */
export function decodeEmbeddedScripts(script: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /printf '%s' '([^']+)' \| (base64 -d \| gunzip|base64 -d) > (\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const [, encoded, pipeline, stagedPath] = m;
    const raw = Buffer.from(encoded, "base64");
    out[stagedPath.replace(/\.hermes-new$/, "")] = pipeline === "base64 -d | gunzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  }
  return out;
}
