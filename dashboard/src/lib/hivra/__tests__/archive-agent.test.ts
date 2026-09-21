import {
  buildHivraArchiveScript,
  buildHivraRestoreIfMissingScript,
  HIVRA_ARCHIVE_REMOTE_DIR,
} from "../archive-agent";

const AGENT = "00000000-0000-4000-8000-000000001002";
const OTHER = "00000000-0000-4000-8000-000000001049";

describe("hivra archive paths", () => {
  // vmids are RECYCLED on this lane — fixturenodea has three hivra_agents rows claiming
  // vmid 2100. Keying archives by vmid alone would let a restore hand a new
  // agent the previous tenant's disk. Both a data-loss and a data-leak bug.
  it("keys the archive by agent UUID, not by vmid", () => {
    const a = buildHivraArchiveScript(2100, "fixturenode21", AGENT);
    const b = buildHivraArchiveScript(2100, "fixturenode21", OTHER);
    expect(a).toContain(`${HIVRA_ARCHIVE_REMOTE_DIR}/fixturenode21/${AGENT}`);
    expect(b).toContain(`${HIVRA_ARCHIVE_REMOTE_DIR}/fixturenode21/${OTHER}`);
    expect(a).not.toContain(OTHER);
  });

  it("restore reads from the same agent-scoped directory", () => {
    const r = buildHivraRestoreIfMissingScript(2100, "fixturenode21", AGENT);
    expect(r).toContain(`${HIVRA_ARCHIVE_REMOTE_DIR}/fixturenode21/${AGENT}/`);
  });

  it.each([
    ["not-a-uuid"],
    [""],
    ["../../etc/passwd"],
    ["00000000-0000-4000-8000-000000001002; rm -rf /"],
  ])("rejects a malformed agent id (%s)", (bad) => {
    expect(() => buildHivraArchiveScript(2100, "fixturenode21", bad)).toThrow();
    expect(() => buildHivraRestoreIfMissingScript(2100, "fixturenode21", bad)).toThrow();
  });

  it.each([["fixturenode21/../../etc"], ["pve 21"], [""], ["FIXTURENODE21"]])(
    "rejects a malformed host slug (%s)",
    (bad) => {
      expect(() => buildHivraArchiveScript(2100, bad, AGENT)).toThrow();
    }
  );

  it.each([[0], [-1], [1.5], [Number.NaN]])("rejects vmid %s", (bad) => {
    expect(() => buildHivraArchiveScript(bad, "fixturenode21", AGENT)).toThrow();
  });
});

describe("hivra archive safety", () => {
  it("refuses to archive anything that is not stopped", () => {
    const s = buildHivraArchiveScript(2100, "fixturenode21", AGENT);
    // aeon runs autonomously and is never parked — archiving a RUNNING guest
    // would pull the disk out from under a live agent.
    expect(s).toContain(`__st=$(qm status 2100`);
    expect(s).toContain(`if [ "$__st" != "stopped" ]`);
    // and the refusal must come BEFORE any vzdump/destroy
    expect(s.indexOf('!= "stopped"')).toBeLessThan(s.indexOf("vzdump"));
    expect(s.indexOf('!= "stopped"')).toBeLessThan(s.indexOf("qm destroy"));
  });

  it("verifies the UPLOADED copy before destroying the VM", () => {
    const s = buildHivraArchiveScript(2100, "fixturenode21", AGENT);
    expect(s).toContain("__rsha=");
    expect(s).toContain("remote sha mismatch — NOT destroying");
    // sha comparison must precede destroy
    expect(s.indexOf("__rsha=")).toBeLessThan(s.indexOf("qm destroy"));
  });

  it("is idempotent — skips vzdump when an archive already exists", () => {
    const s = buildHivraArchiveScript(2100, "fixturenode21", AGENT);
    expect(s).toContain("archive already present");
  });
});

describe("hivra self-healing start", () => {
  it("is a no-op when the VM is present", () => {
    const s = buildHivraRestoreIfMissingScript(2100, "fixturenode21", AGENT);
    expect(s.startsWith("if ! qm status 2100 >/dev/null 2>&1; then")).toBe(true);
  });

  it("verifies sha256 BEFORE qmrestore and fails closed", () => {
    const s = buildHivraRestoreIfMissingScript(2100, "fixturenode21", AGENT);
    expect(s.indexOf("SHA MISMATCH")).toBeLessThan(s.indexOf("qmrestore"));
    // every failure path must exit non-zero so the caller surfaces "Start failed"
    // rather than kicking a start against a VM that isn't there.
    expect((s.match(/exit 1/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(s).toContain("no archive found");
  });

  it("restores onto the SAME vmid so the row's ip/tunnel stay valid", () => {
    const s = buildHivraRestoreIfMissingScript(2100, "fixturenode21", AGENT);
    expect(s).toContain("qmrestore");
    expect(s).toMatch(/qmrestore "[^"]+" 2100/);
  });

  it("cleans up the downloaded dump on every path", () => {
    const s = buildHivraRestoreIfMissingScript(2100, "fixturenode21", AGENT);
    expect((s.match(/rm -f "\/var\/lib\/vz\/dump\/\$__base"/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
  });
});

/**
 * The Hetzner Storage Box runs a RESTRICTED shell. Two forms are accepted by the
 * ssh client but do nothing on the far side — and still exit 0:
 *   - `cat > file`            silently no-ops (echoes the input back)
 *   - `mkdir -p X && mv A B`  compound commands are rejected outright
 * Both were hit for real on 2026-07-25: a reorg reported "moved=27" having moved
 * nothing, and manifests written with `cat >` never landed. Anything generated
 * here must therefore use one command per invocation, and WRITE via rsync.
 */
describe("storage-box restricted-shell compatibility", () => {
  const AGENT_ID = "00000000-0000-4000-8000-000000001002";
  const executableLines = (s: string) =>
    s.split("\n").filter((l) => !l.trim().startsWith("#"));

  it.each([
    ["archive", () => buildHivraArchiveScript(2100, "fixturenode21", AGENT_ID)],
    ["restore", () => buildHivraRestoreIfMissingScript(2100, "fixturenode21", AGENT_ID)],
  ])("%s never writes to the storage box with `cat >`", (_n, build) => {
    for (const line of executableLines(build())) {
      if (line.includes("cold")) expect(line).not.toMatch(/cat\s+>/);
    }
  });

  it("writes the manifest via rsync and VERIFIES it landed before destroying", () => {
    const s = buildHivraArchiveScript(2100, "fixturenode21", AGENT_ID);
    expect(s).toMatch(/rsync[\s\S]*cold:hivra-parked\/fixturenode21\/[0-9a-f-]+\/manifest\.json/);
    expect(s).toContain("manifest did not land — NOT destroying");
    // the read-back check must gate the destroy
    expect(s.indexOf("manifest did not land")).toBeLessThan(s.indexOf("qm destroy"));
  });

  it("never chains remote commands with && inside an ssh cold invocation", () => {
    for (const s of [
      buildHivraArchiveScript(2100, "fixturenode21", AGENT_ID),
      buildHivraRestoreIfMissingScript(2100, "fixturenode21", AGENT_ID),
    ]) {
      const remoteCalls = s.match(/StrictHostKeyChecking=accept-new cold "[^"]*"/g) ?? [];
      for (const call of remoteCalls) expect(call).not.toContain("&&");
    }
  });
});
