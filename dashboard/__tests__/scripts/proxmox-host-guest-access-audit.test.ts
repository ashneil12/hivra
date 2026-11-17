import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const scriptPath = path.join(__dirname, "../../scripts/proxmox-host-guest-access-audit.sh");
const rawFixture = path.join(__dirname, "fixtures/guest-access-audit.raw.txt");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "guest-access-"));
  const qemu = path.join(root, "qemu-server");
  const lxc = path.join(root, "lxc");
  mkdirSync(qemu);
  mkdirSync(lxc);
  writeFileSync(path.join(qemu, "2104.conf"), "name: a\nipconfig0: ip=10.250.20.51/24,gw=10.250.20.1\n");
  writeFileSync(path.join(lxc, "1010.conf"), "hostname: c\nnet0: name=eth0,bridge=vmbr1,hwaddr=BC:24:11:AA:BB:04,ip=10.250.20.70/24,type=veth\n");
  const actors = path.join(root, "actors.conf");
  writeFileSync(actors, [
    "# comments are ignored",
    "key SHA256:SYSKEY system Hivra's systems (automatic)",
    "addr 100.101.102.103/32 staff Hivra staff (Ash)",
    "addr not-an-address staff ignored",
  ].join("\n"));
  const sessions = path.join(root, "sessions.json");
  writeFileSync(sessions, JSON.stringify({
    "12": { addr: "203.0.113.9", fp: "SHA256:SYSKEY" },
    "13": { addr: "100.101.102.103", fp: "SHA256:OTHER" },
    "14": { addr: "198.51.100.1", fp: null },
  }));
  return { root, qemu, lxc, actors, sessions };
}

function parse() {
  const f = fixture();
  const out = execFileSync("bash", [scriptPath, "--parse-raw", rawFixture], {
    encoding: "utf8",
    env: { ...process.env, QEMU_CONF_DIR: f.qemu, LXC_CONF_DIR: f.lxc, ACCESS_ACTORS_CONF: f.actors, ACCESS_SESSIONS_FIXTURE: f.sessions },
  });
  return out.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("proxmox-host-guest-access-audit --parse-raw", () => {
  const events = parse();

  it("records a guest-agent command with only the program's name, by the session's key", () => {
    expect(events[0]).toEqual({
      actor_class: "system", actor_label: "Hivra's systems (automatic)", at: 1763400000,
      channel: "command", kind: "qemu", program: "bash", source: "qm", vmid: 2104,
    });
  });

  it("maps an SSH session to the guest by its address, and its actor by source address", () => {
    expect(events[1]).toMatchObject({ actor_class: "staff", actor_label: "Hivra staff (Ash)", channel: "ssh", program: "sudo", vmid: 2104 });
    expect(JSON.stringify(events)).not.toContain("cat /x");
  });

  it("counts read-only guest-agent calls as status, from the host's own services", () => {
    expect(events[2]).toMatchObject({ actor_class: "system", actor_label: "Hivra's services on the server", channel: "status", program: "get-fsinfo" });
  });

  it("treats an scp session as a file copy, and an unknown login as staff", () => {
    expect(events[3]).toMatchObject({ actor_class: "staff", actor_label: "Unrecognised login", channel: "files", kind: "lxc", program: "scp", vmid: 1010 });
  });

  it("records consoles and screens, and ignores power operations and SSH to anything that is not a guest", () => {
    expect(events[4]).toMatchObject({ channel: "console", source: "qm", vmid: 2104 });
    expect(events[5]).toMatchObject({ channel: "screen", source: "pvesh", vmid: 2104 });
    expect(events).toHaveLength(6);
  });
});

describe("proxmox-host-guest-access-audit --drain", () => {
  it("drops what Hivra stored and prints the next batch", () => {
    if (process.getuid?.() !== 0) return; // --drain refuses to run without root
    const f = fixture();
    const state = path.join(f.root, "state");
    mkdirSync(state);
    writeFileSync(path.join(state, "spool.jsonl"), [1, 2, 3].map((seq) => JSON.stringify({ seq, at: seq, vmid: 2104 })).join("\n") + "\n");
    writeFileSync(path.join(state, "seq"), "3");
    const run = spawnSync("bash", [scriptPath, "--drain", "1", "1"], {
      encoding: "utf8",
      env: { ...process.env, ACCESS_STATE_DIR: state, QEMU_CONF_DIR: f.qemu, LXC_CONF_DIR: f.lxc, PATH: "/usr/bin:/bin" },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('HIVRA_ACCESS_V1 {"seq":2,"at":2,"vmid":2104}');
    expect(run.stdout).toContain('HIVRA_ACCESS_END {"installed":true,"last_seq":2,"more":true,"head_seq":3}');
    expect(readFileSync(path.join(state, "spool.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("refuses a malformed cursor", () => {
    const run = spawnSync("bash", [scriptPath, "--drain", "x"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
  });
});
