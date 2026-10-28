/**
 * @jest-environment node
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildConfigSnapshotStagingScript,
  buildMetadataFile,
  gitBlobSha,
  parseStagedFiles,
  pushSnapshotToGitHub,
  redactConfigYaml,
  redactStagedFiles,
  scanForSecrets,
  SNAPSHOT_FILES_BEGIN,
  SNAPSHOT_FILES_END,
  type StagedFile,
} from "../config-snapshot";

function file(path: string, content: string): StagedFile {
  return { path, content: Buffer.from(content, "utf8") };
}

function framed(lines: Array<[string, string]>, count = lines.length): string {
  const body = lines
    .map(([p, c]) => `FILE\t${p}\t${Buffer.from(c, "utf8").toString("base64")}`)
    .join("\n");
  return `noise\n${SNAPSHOT_FILES_BEGIN}\n${body}\n${SNAPSHOT_FILES_END} count=${count}\ntrailing`;
}

describe("parseStagedFiles", () => {
  it("parses framed FILE lines and decodes base64", () => {
    const out = framed([
      ["hermes/config.yaml", "model: x\n"],
      ["hermes/SOUL.md", "# soul"],
    ]);
    const files = parseStagedFiles(out);
    expect(files.map((f) => f.path)).toEqual(["hermes/config.yaml", "hermes/SOUL.md"]);
    expect(files[1].content.toString("utf8")).toBe("# soul");
  });

  it("throws on a count mismatch (truncated stream must fail closed)", () => {
    const out = framed([["hermes/config.yaml", "model: x"]], 5);
    expect(() => parseStagedFiles(out)).toThrow(/count mismatch/);
  });

  it("throws when the END marker is missing", () => {
    const out = `${SNAPSHOT_FILES_BEGIN}\nFILE\ta\t${Buffer.from("x").toString("base64")}`;
    expect(() => parseStagedFiles(out)).toThrow(/END marker/);
  });

  it("throws when the BEGIN marker is missing", () => {
    expect(() => parseStagedFiles("just some host noise")).toThrow(/BEGIN marker/);
  });

  it("rejects path traversal in a staged path", () => {
    const out = `${SNAPSHOT_FILES_BEGIN}\nFILE\t../escape\t${Buffer.from("x").toString(
      "base64"
    )}\n${SNAPSHOT_FILES_END} count=1`;
    expect(() => parseStagedFiles(out)).toThrow(/unsafe staged path/);
  });
});

describe("redactConfigYaml", () => {
  it("masks secret-bearing fields and leaves the rest intact", () => {
    const input = [
      "model: hermes-4",
      "api_key: sk-secretvalue",
      "openrouter_token: abc123",
      "client_secret: hunter2",
      "password: letmein",
      "temperature: 0.7",
    ].join("\n");
    const out = redactConfigYaml(input);
    expect(out).toContain("model: hermes-4");
    expect(out).toContain("temperature: 0.7");
    expect(out).not.toContain("sk-secretvalue");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("letmein");
    expect((out.match(/\[REDACTED\]/g) || []).length).toBe(4);
  });
});

describe("scanForSecrets (fail-closed)", () => {
  it("passes a clean, redacted snapshot", () => {
    const files = [
      file("hermes/config.yaml", "model: x\napi_key: \"[REDACTED]\"\n"),
      file("hermes/SOUL.md", "I am an agent."),
      file("EXPORT_METADATA.json", '{"instance_id":"abc"}'),
    ];
    expect(scanForSecrets(files)).toEqual([]);
  });

  it("flags an unredacted config secret field", () => {
    const files = [file("hermes/config.yaml", "api_key: sk-live-not-redacted-1234567890")];
    const hits = scanForSecrets(files);
    // Caught by the raw openai_key pattern OR the config-field check — either is a hit.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("hermes/config.yaml");
  });

  it("flags an sk-style key leaked into free text", () => {
    // The openai `sk-` pattern is checked before `sk-ant-` and short-circuits, so an
    // Anthropic key lands under kind=openai_key — faithful to the original scanner's
    // ordering. What matters is the fail-closed property: it IS blocked.
    const files = [file("hermes/SOUL.md", "remember sk-ant-api03-" + "a".repeat(40))];
    const hits = scanForSecrets(files);
    expect(hits.some((h) => h.kind === "openai_key" || h.kind === "anthropic_key")).toBe(true);
  });

  it("flags a private key block", () => {
    const files = [
      file("hermes/skills/x/key.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"),
    ];
    expect(scanForSecrets(files).some((h) => h.kind === "private_key_block")).toBe(true);
  });

  it("flags a forbidden path even with innocuous content", () => {
    const files = [file("hermes/.env", "FOO=bar")];
    expect(scanForSecrets(files).some((h) => h.kind === "forbidden_path")).toBe(true);
  });

  it("flags a github PAT", () => {
    const files = [file("hermes/orgs/notes.md", "token ghp_" + "A1b2".repeat(10))];
    expect(scanForSecrets(files).some((h) => h.kind === "github_pat")).toBe(true);
  });
});

describe("redactStagedFiles", () => {
  it("redacts config.yaml in place and leaves other files untouched", () => {
    const files = [
      file("hermes/config.yaml", "api_key: leak\nmodel: x"),
      file("hermes/profiles/p/config.yaml", "token: leak2"),
      file("hermes/SOUL.md", "token: this-is-prose-not-config"),
    ];
    const out = redactStagedFiles(files);
    expect(out[0].content.toString()).toContain("[REDACTED]");
    expect(out[1].content.toString()).toContain("[REDACTED]");
    // SOUL.md is not a config.yaml — left verbatim (it's prose, scanner handles real secrets).
    expect(out[2].content.toString()).toBe("token: this-is-prose-not-config");
  });
});

describe("buildConfigSnapshotStagingScript", () => {
  it("shell-quotes inputs and embeds the allowlist + markers", () => {
    const script = buildConfigSnapshotStagingScript({
      instanceId: "00000000-0000-4000-8000-000000001056",
      vmid: 200,
      guestIp: "10.250.20.50",
    });
    expect(script).toContain("'00000000-0000-4000-8000-000000001056'");
    expect(script).toContain("'200'");
    expect(script).toContain("'10.250.20.50'");
    expect(script).toContain("/etc/hivra/keys/vm-orchestrator");
    expect(script).toContain("agent-${INSTANCE_ID}_webui-state");
    expect(script).toContain("--exclude=.env");
    expect(script).toContain("--exclude=secrets");
    expect(script).toContain(SNAPSHOT_FILES_BEGIN);
    expect(script).toContain(SNAPSHOT_FILES_END);
  });

  it("defends against injection in the instance id at build time", () => {
    const script = buildConfigSnapshotStagingScript({
      instanceId: "x'; rm -rf /; '",
      vmid: 1,
      guestIp: null,
    });
    // The single quote is escaped via the '"'"' idiom; the raw `; rm -rf /` is never
    // an unquoted token. The runtime regex guard then rejects the non-uuid id.
    expect(script).toContain(`'"'"'`);
    expect(script).toContain('[[ "$INSTANCE_ID" =~ ^[0-9a-f-]{36}$ ]]');
  });

  it("guards per-profile names with a strict allowlist before interpolating them (SEC-05)", () => {
    const script = buildConfigSnapshotStagingScript({
      instanceId: "00000000-0000-4000-8000-000000001056",
      vmid: 200,
      guestIp: "10.250.20.50",
    });
    expect(script).toContain('[[ "$p" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || continue');
    // The guard must sit inside the profiles loop, BEFORE $p reaches mkdir or any
    // g "sudo ..." string that a guest shell will re-parse.
    const loopIdx = script.indexOf('for p in $(g "sudo ls $V/profiles');
    const guardIdx = script.indexOf('[[ "$p" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]');
    const mkdirIdx = script.indexOf('mkdir -p "$STAGE/hermes/profiles/$p"');
    expect(loopIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(loopIdx);
    expect(mkdirIdx).toBeGreaterThan(guardIdx);
  });

  it("skips hostile profile names end-to-end: they never reach a guest command or host path (SEC-05)", () => {
    const script = buildConfigSnapshotStagingScript({
      instanceId: "00000000-0000-4000-8000-000000001056",
      vmid: 200,
      guestIp: "10.250.20.50",
    });
    // Pull the real `if g "sudo test -d $V/profiles" ... fi` block out of the generated
    // script and run it under bash with a stubbed `g` (the guest-ssh helper). The stub
    // logs every remote-command arg and answers the `ls` with tenant-controlled names.
    const block = script.match(/if g "sudo test -d \$V\/profiles"[\s\S]*?\nfi\n/);
    expect(block).not.toBeNull();

    const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
    const hostileNames = [
      "..",
      "../escape",
      "evil;touch",
      "$(id)",
      "`id`",
      "a/b",
      "'quoted'",
      'x"quote',
      "name$(touch${IFS}x)",
      "*",
    ];
    const tmp = mkdtempSync(join(tmpdir(), "sec05-profiles-"));
    try {
      const callsPath = join(tmp, "calls.log");
      const runDir = join(tmp, "rundir");
      mkdirSync(runDir); // empty cwd: a bare `*` cannot glob into real filenames
      const harness = [
        "set -u",
        `STAGE=${sq(join(tmp, "stage"))}`,
        "V=/fake/vol",
        `CALLS=${sq(callsPath)}`,
        `cd ${sq(runDir)}`,
        `g() { printf 'G\\t%s\\n' "$*" >> "$CALLS"; case "$*" in *"ls $V/profiles"*) printf '%s\\n' ${["good-name", "legit_123", ...hostileNames].map(sq).join(" ")} ;; *" cat "*) printf 'x\\n' ;; esac; return 0; }`,
        block![0],
      ].join("\n");
      execFileSync("bash", ["-c", harness], { stdio: "pipe" });

      const calls = readFileSync(callsPath, "utf8");
      // Allowlisted profile names are still snapshotted.
      expect(calls).toContain("/fake/vol/profiles/good-name/config.yaml");
      expect(calls).toContain("/fake/vol/profiles/legit_123/config.yaml");
      // No hostile fragment ever reached a guest-command argument.
      expect(calls).not.toMatch(/\$\(/);
      expect(calls).not.toContain("`");
      expect(calls).not.toContain(";");
      expect(calls).not.toMatch(/\.\./);
      expect(calls).not.toMatch(/profiles\/\*/);
      // And no hostile/traversal directory was created on the host staging tree.
      expect(readdirSync(join(tmp, "stage", "hermes", "profiles")).sort()).toEqual([
        "good-name",
        "legit_123",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("buildMetadataFile", () => {
  it("produces snapshot/EXPORT_METADATA.json with the instance identity", () => {
    const meta = buildMetadataFile({ instanceId: "abc", proxmoxNode: "fixturenode1", proxmoxVmid: 200 });
    expect(meta.path).toBe("EXPORT_METADATA.json");
    const parsed = JSON.parse(meta.content.toString("utf8"));
    expect(parsed.instance_id).toBe("abc");
    expect(parsed.proxmox_node).toBe("fixturenode1");
    expect(parsed.proxmox_vmid).toBe(200);
    expect(parsed.exported_at_utc).toMatch(/Z$/);
  });
});

describe("gitBlobSha", () => {
  it("matches git's blob hash for the empty blob", () => {
    // `printf '' | git hash-object --stdin` -> e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    expect(gitBlobSha(Buffer.from(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
  it("matches git's blob hash for a known string", () => {
    // `printf 'hello' | git hash-object --stdin` -> b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
    expect(gitBlobSha(Buffer.from("hello"))).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
  });
});

describe("pushSnapshotToGitHub", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("refuses to push an empty snapshot (would wipe the backup)", async () => {
    await expect(
      pushSnapshotToGitHub({ repo: "o/r", branch: "main", token: "t", files: [], commitMessage: "x" })
    ).rejects.toThrow(/empty snapshot/);
  });

  it("reuses unchanged blobs, uploads changed ones, deletes vanished files, commits, advances ref", async () => {
    const unchanged = file("hermes/unchanged.md", "i never change");
    const unchangedSha = gitBlobSha(unchanged.content); // matches the existing tree entry below

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url: String(url), body });
      const u = String(url);
      const json = (obj: unknown) =>
        ({ ok: true, status: 200, text: async () => JSON.stringify(obj) } as Response);
      if (method === "GET" && u.endsWith("/git/ref/heads/main")) return json({ object: { sha: "basecommit" } });
      if (method === "GET" && u.includes("/git/commits/basecommit")) return json({ tree: { sha: "basetree" } });
      if (method === "GET" && u.includes("/git/trees/basetree"))
        return json({
          tree: [
            { path: "snapshot/hermes/old.md", type: "blob", sha: "oldsha" },
            { path: "snapshot/hermes/unchanged.md", type: "blob", sha: unchangedSha },
            { path: "snapshot/EXPORT_METADATA.json", type: "blob", sha: "metasha" },
            { path: "README.md", type: "blob", sha: "readmesha" },
          ],
        });
      if (method === "POST" && u.endsWith("/git/blobs")) return json({ sha: "newblob" });
      if (method === "POST" && u.endsWith("/git/trees")) return json({ sha: "newtree" });
      if (method === "POST" && u.endsWith("/git/commits")) return json({ sha: "newcommit" });
      if (method === "PATCH" && u.endsWith("/git/refs/heads/main")) return json({ ref: "ok" });
      throw new Error(`unexpected ${method} ${u}`);
    }) as unknown as typeof fetch;

    const res = await pushSnapshotToGitHub({
      repo: "o/r",
      branch: "main",
      token: "t",
      files: [
        file("hermes/config.yaml", "model: x"),
        unchanged,
        buildMetadataFile({ instanceId: "abc", proxmoxNode: "fixturenode1", proxmoxVmid: 200 }),
      ],
      commitMessage: "snap",
    });

    expect(res.changed).toBe(true);
    expect(res.commitSha).toBe("newcommit");
    // config.yaml + metadata are new/changed -> 2 blob uploads; unchanged.md is reused.
    const blobPosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/blobs"));
    expect(blobPosts.length).toBe(2);
    expect(res.blobsUploaded).toBe(2);
    // snapshot/hermes/old.md vanished from the new set -> exactly one deletion.
    expect(res.filesDeleted).toBe(1);
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees") && c.method === "POST")!;
    const entries = (treeCall.body as { tree: Array<{ path: string; sha: string | null }> }).tree;
    expect(entries.find((e) => e.path === "snapshot/hermes/old.md")?.sha).toBeNull();
    // The unchanged file is present in the tree, reusing its existing blob sha (no upload).
    expect(entries.find((e) => e.path === "snapshot/hermes/unchanged.md")?.sha).toBe(unchangedSha);
    // README.md (outside snapshot/) is never touched.
    expect(entries.some((e) => e.path === "README.md")).toBe(false);
    // Ref was advanced to the new commit.
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/git/refs/heads/main"))).toBe(true);
  });

  it("makes no commit when the tree is byte-identical to HEAD", async () => {
    let committed = false;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const u = String(url);
      const json = (obj: unknown) =>
        ({ ok: true, status: 200, text: async () => JSON.stringify(obj) } as Response);
      if (method === "GET" && u.endsWith("/git/ref/heads/main")) return json({ object: { sha: "c" } });
      if (method === "GET" && u.includes("/git/commits/c")) return json({ tree: { sha: "sametree" } });
      if (method === "GET" && u.includes("/git/trees/sametree")) return json({ tree: [] });
      if (method === "POST" && u.endsWith("/git/blobs")) return json({ sha: "b" });
      if (method === "POST" && u.endsWith("/git/trees")) return json({ sha: "sametree" }); // unchanged
      if (method === "POST" && u.endsWith("/git/commits")) {
        committed = true;
        return json({ sha: "x" });
      }
      return json({});
    }) as unknown as typeof fetch;

    const res = await pushSnapshotToGitHub({
      repo: "o/r",
      branch: "main",
      token: "t",
      files: [file("hermes/config.yaml", "model: x")],
      commitMessage: "snap",
    });
    expect(res.changed).toBe(false);
    expect(committed).toBe(false);
  });

  it("uploads changed blobs a few at a time and keeps the tree in file order", async () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`hermes/f${i}.md`, `body ${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const u = String(url);
      const json = (obj: unknown) =>
        ({ ok: true, status: 200, text: async () => JSON.stringify(obj) } as Response);
      if (method === "GET" && u.endsWith("/git/ref/heads/main")) return json({ object: { sha: "basecommit" } });
      if (method === "GET" && u.includes("/git/commits/basecommit")) return json({ tree: { sha: "basetree" } });
      if (method === "GET" && u.includes("/git/trees/basetree")) return json({ tree: [] });
      if (method === "POST" && u.endsWith("/git/blobs")) {
        const body = JSON.parse(init!.body as string) as { content: string };
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return json({ sha: `blob-${Buffer.from(body.content, "base64").toString("utf8")}` });
      }
      if (method === "POST" && u.endsWith("/git/trees")) return json({ sha: "newtree" });
      if (method === "POST" && u.endsWith("/git/commits")) return json({ sha: "newcommit" });
      if (method === "PATCH" && u.endsWith("/git/refs/heads/main")) return json({ ref: "ok" });
      throw new Error(`unexpected ${method} ${u}`);
    }) as unknown as typeof fetch;

    const res = await pushSnapshotToGitHub({
      repo: "o/r",
      branch: "main",
      token: "t",
      files,
      commitMessage: "snap",
    });

    expect(res.blobsUploaded).toBe(8);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    const treeCall = (global.fetch as unknown as jest.Mock).mock.calls.find(
      ([u, init]) => String(u).endsWith("/git/trees") && init?.method === "POST"
    );
    const entries = (JSON.parse(treeCall[1].body as string) as {
      tree: Array<{ path: string; sha: string | null }>;
    }).tree;
    expect(entries.map((e) => e.path)).toEqual(files.map((f) => `snapshot/${f.path}`));
    expect(entries.map((e) => e.sha)).toEqual(files.map((_, i) => `blob-body ${i}`));
  });
});
