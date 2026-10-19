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
});
