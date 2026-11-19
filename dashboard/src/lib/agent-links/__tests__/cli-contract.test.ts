/** @jest-environment node */
// The CLI an agent gets against a stand-in for /api/agent-link that answers
// in the route's own shape: what it sends, and what it does with the answer.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { HIVRA_COMPUTERS_CLI } from "../kit-program";

function hasPython(): boolean {
  try { execFileSync("python3", ["-c", "pass"]); return true; } catch { return false; }
}

const KEY = `hvl_${"f".repeat(64)}`;
const maybe = hasPython() ? describe : describe.skip;

maybe("hivra-computers against the agent API", () => {
  let server: http.Server, home: string, cli: string;
  const seen: { method: string; auth: string | undefined; body: Record<string, unknown> | null }[] = [];
  let answer: (body: Record<string, unknown>) => unknown = () => ({});

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        seen.push({ method: req.method ?? "", auth: req.headers.authorization, body });
        const data = req.method === "GET"
          ? { agent: { id: "a", name: "Claude" }, computers: [{ id: "c1", name: "Studio", kind: "Ubuntu desktop", status: "running", ready: true }] }
          : answer(body ?? {});
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ success: true, data }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-agent-"));
    fs.mkdirSync(path.join(home, ".hivra"));
    const port = (server.address() as AddressInfo).port;
    fs.writeFileSync(path.join(home, ".hivra/link.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}/api/agent-link`, key: KEY, agentId: "a" }));
    cli = path.join(home, "hivra-computers");
    fs.writeFileSync(cli, HIVRA_COMPUTERS_CLI);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = (args: string[]) => new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve) => {
    const child = spawn("python3", [cli, ...args], { cwd: home, env: { ...process.env, HOME: home } });
    const out: Buffer[] = []; let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { err += chunk; });
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
  });
  const ran = (stdout: Buffer | string, exitCode = 0, extra: Record<string, unknown> = {}) => ({ computer: { id: "c1", name: "Studio" }, exitCode,
    stdoutBase64: Buffer.from(stdout).toString("base64"), stderrBase64: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 1, ...extra });

  it("lists computers with the agent's key", async () => {
    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("Studio\tUbuntu desktop\tc1\tready\n");
    expect(seen.at(-1)).toMatchObject({ method: "GET", auth: `Bearer ${KEY}` });
  });

  it("runs a command and exits with its code", async () => {
    answer = () => ran("Linux\n", 7);
    const result = await run(["run", "Studio", "--timeout", "30", "--", "uname", "-s"]);
    expect(result.code).toBe(7);
    expect(result.stdout.toString()).toBe("Linux\n");
    expect(seen.at(-1)?.body).toEqual({ computer: "Studio", command: "uname -s", timeoutSeconds: 30 });
  });

  it("pushes a file as stdin and pulls one back", async () => {
    fs.writeFileSync(path.join(home, "notes.txt"), "hello");
    answer = () => ran("");
    expect((await run(["push", "Studio", "notes.txt", "/tmp/my notes.txt"])).code).toBe(0);
    expect(seen.at(-1)?.body).toMatchObject({ stdinBase64: Buffer.from("hello").toString("base64") });
    expect(String(seen.at(-1)?.body?.command)).toContain("cat > '/tmp/my notes.txt'");
    answer = () => ran(Buffer.from("remote bytes").toString("base64"));
    expect((await run(["pull", "Studio", "/etc/hostname", "got.txt"])).code).toBe(0);
    expect(fs.readFileSync(path.join(home, "got.txt"), "utf8")).toBe("remote bytes");
  });

  it("says when a command ran out of time", async () => {
    answer = () => ran("", 137, { timedOut: true });
    const result = await run(["run", "Studio", "sleep 999"]);
    expect(result.code).toBe(137);
    expect(result.stderr).toMatch(/ran out of time/);
  });

  describe("bridge", () => {
    const MAC = "33333333-3333-4333-8333-333333333333", REQ = "44444444-4444-4444-8444-444444444444";
    let polls: Record<string, unknown>[] = [];
    let bridgeServer: http.Server, bridgeCli: string;
    const bridgeSeen: { method: string; url: string; auth: string | undefined; body: Record<string, unknown> | null }[] = [];
    const reply = (res: http.ServerResponse, data: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ success: true, data })); };

    beforeAll(async () => {
      bridgeServer = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          bridgeSeen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
          if (req.url === "/api/agent-bridge" && req.method === "GET") return reply(res, { computers: [{ id: MAC, name: "Owner Mac" }] });
          if (req.url === "/api/agent-bridge" && req.method === "POST") return reply(res, { request: { id: REQ, status: "pending" } });
          if (req.url === `/api/agent-bridge?id=${REQ}`) return reply(res, { request: polls.shift() ?? { id: REQ, status: "pending" } });
          res.statusCode = 404; res.end("{}");
        });
      });
      await new Promise<void>((resolve) => bridgeServer.listen(0, "127.0.0.1", resolve));
      fs.mkdirSync(path.join(home, "b/.hivra"), { recursive: true });
      const port = (bridgeServer.address() as AddressInfo).port;
      fs.writeFileSync(path.join(home, "b/.hivra/link.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}/api/agent-link`, key: KEY, agentId: "a" }));
      bridgeCli = cli;
    });
    afterAll(() => new Promise<void>((resolve) => bridgeServer.close(() => resolve())));

    const bridge = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("python3", [bridgeCli, "bridge", ...args], { cwd: home, env: { ...process.env, HOME: path.join(home, "b"), HIVRA_BRIDGE_POLL_SECONDS: "0.05" } });
      let out = "", err = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
      child.stderr.on("data", (chunk: Buffer) => { err += chunk; });
      child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    });

    it("lists the owner's computers on the bridge route", async () => {
      const result = await bridge(["list"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`Owner Mac\t${MAC}\n`);
      expect(bridgeSeen.at(-1)).toMatchObject({ method: "GET", url: "/api/agent-bridge", auth: `Bearer ${KEY}` });
    });

    it("waits for approval, then prints the output and exits with the command's code", async () => {
      polls = [{ id: REQ, status: "pending" }, { id: REQ, status: "approved" }, { id: REQ, status: "running" },
        { id: REQ, status: "done", result: { stdout: "Darwin\n", stderr: "warn\n", exitCode: 3, truncated: false } }];
      const result = await bridge(["run", "owner mac", "--cwd", "/Users/example", "--timeout", "20", "--", "uname", "-s"]);
      expect(result.code).toBe(3);
      expect(result.stdout).toBe("Darwin\n");
      expect(result.stderr).toContain("Waiting for your owner to approve this in Hivra...");
      expect(result.stderr).toContain("warn");
      const post = bridgeSeen.filter((entry) => entry.method === "POST").at(-1);
      expect(post?.body).toEqual({ computer: MAC, argv: ["uname", "-s"], cwd: "/Users/example", timeoutSeconds: 20 });
    });

    it("exits non-zero with a clear message when denied, expired or failed", async () => {
      polls = [{ id: REQ, status: "denied" }];
      const denied = await bridge(["run", MAC, "--", "ls"]);
      expect(denied.code).toBe(3);
      expect(denied.stderr).toMatch(/owner said no/);
      polls = [{ id: REQ, status: "expired" }];
      const expired = await bridge(["run", MAC, "--", "ls"]);
      expect(expired.code).toBe(4);
      expect(expired.stderr).toMatch(/didn't approve this command in time/);
      polls = [{ id: REQ, status: "failed", result: { message: "Your computer's bridge did not answer." } }];
      const failed = await bridge(["run", MAC, "--", "ls"]);
      expect(failed.code).toBe(5);
      expect(failed.stderr).toMatch(/bridge did not answer/);
    });

    it("refuses an unknown computer without filing anything", async () => {
      const before = bridgeSeen.filter((entry) => entry.method === "POST").length;
      const result = await bridge(["run", "Nope", "--", "ls"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/no computer of your owner's called Nope/);
      expect(bridgeSeen.filter((entry) => entry.method === "POST").length).toBe(before);
    });
  });
});
