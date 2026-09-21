import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { applyGuestLlmApplication, inspectGuestLlmApplication } from "@/lib/hivra/guest-llm-transport";

const TOKEN = "a".repeat(64);
const OPERATION = "11111111-1111-4111-8111-111111111111";
const PROTOCOL = "hivra-llm-apply-v1";
const SETTING = { provider: "venice", baseUrl: "https://api.venice.ai/api/v1", apiKey: "fixture-private-model-key", model: "fixture-model" };
const source = path.resolve("provisioner/hivra-chat/server.js");
let root: string, file: string, port: number, child: ChildProcess | undefined;

async function start(runtime = "codex", observeSpawn = false) {
  // Real gateway in a separate process and private HOME. No inherited local
  // credentials, agent/shell processes, provider requests or real computers.
  const launcher = `
    const http = require("node:http");
    const create = http.createServer;
    http.createServer = (...args) => {
      const server = create(...args);
      server.once("listening", () => process.send({port: server.address().port}));
      return server;
    };
    const processes = require("node:child_process");
    processes.execFile = () => { throw Error("Agent execution is outside this fixture"); };
    processes.spawn = (bin,args,options) => {
      if (!${JSON.stringify(observeSpawn)}) throw Error("Agent execution is outside this fixture");
      const {EventEmitter} = require("node:events"), {PassThrough} = require("node:stream");
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      process.send({spawn: {bin,args,modelKey:options.env.HIVRA_LLM_API_KEY??null}});
      process.nextTick(() => child.emit("close",0));
      return child;
    };
    require(${JSON.stringify(source)});
  `;
  const running = spawn(process.execPath, ["-e", launcher], {
    env: { NODE_ENV: "test", HOME: root, HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: runtime },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child = running;
  let errorText = "";
  running.stderr?.on("data", chunk => { errorText = (errorText + String(chunk)).slice(-2048); });
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Guest fixture start timed out")), 5000);
    running.once("error", error => { clearTimeout(timer); reject(error); });
    running.once("exit", () => { clearTimeout(timer); reject(new Error(`Guest fixture exited: ${errorText}`)); });
    running.once("message", message => {
      clearTimeout(timer);
      const result = message as { port: number };
      if (!Number.isInteger(result.port) || result.port < 1) reject(new Error("Guest fixture did not bind TCP"));
      else resolve(result.port);
    });
  });
}

async function stop() {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const kill = setTimeout(() => running.kill("SIGKILL"), 2000);
    const timeout = setTimeout(() => reject(new Error("Guest fixture cleanup timed out")), 4000);
    running.once("exit", () => { clearTimeout(kill); clearTimeout(timeout); resolve(); });
    running.kill("SIGTERM");
  });
}

function request(route: string, options: { method?: string; body?: string; token?: string | null; headers?: http.OutgoingHttpHeaders } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method: options.method ?? "GET", agent: false,
      headers: { Host: "box.hivra.test", "Content-Type": "application/json",
        ...(options.token === null ? {} : { Authorization: `Bearer ${options.token ?? TOKEN}` }), ...options.headers } }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; if (body.length > 20000) res.destroy(new Error("Fixture response too large")); });
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("Guest fixture request timed out")));
    req.end(options.body);
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hivra-llm-http-test-"));
  fs.mkdirSync(path.join(root, ".hivra"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".hivra/api-token"), TOKEN, { mode: 0o600 });
  file = path.join(root, ".hivra/llm-provider.json");
  await start();
});
afterEach(async () => {
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
});

it("delivers through the actual gateway and reconciles a lost reply across restart without reposting", async () => {
  const target = { hostname: "box.hivra.test", apiToken: TOKEN, runtime: "codex" as const };
  let loseReply = true, writes = 0;
  // Explicit test-only mapping to this owned child, not a production fetch
  // override. Default production transport/DNS checks have separate regressions.
  const fetcher = async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://box.hivra.test");
    expect(parsed.search).toBe("");
    const result = await request(parsed.pathname, { method: init.method, body: init.body as string | undefined,
      token: null, headers: init.headers as http.OutgoingHttpHeaders });
    if (init.method === "POST") {
      writes++;
      if (loseReply) { loseReply = false; throw new Error("Synthetic lost acknowledgement"); }
    }
    return new Response(result.body, { status: result.status, headers: {
      "Content-Type": String(result.headers["content-type"] ?? ""),
      "Cache-Control": String(result.headers["cache-control"] ?? ""),
    } });
  };
  const initial = await inspectGuestLlmApplication(target, fetcher);
  if (!initial.ok) throw new Error("Fixture inspection failed");
  const input = { target, operationId: OPERATION, expectedStateDigest: initial.receipt.stateDigest,
    payload: { ...SETTING, provider: "venice" as const } };
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  const inode = fs.statSync(file).ino;
  await stop(); await start();
  const recovered = await applyGuestLlmApplication(input, fetcher);
  if (recovered.status !== "applied") throw new Error("Fixture reconciliation failed");
  expect(recovered.writeAttempted).toBe(false);
  expect(fs.statSync(file).ino).toBe(inode); expect(writes).toBe(1);
  expect(JSON.stringify(recovered)).not.toContain(SETTING.apiKey);
  const cleared = await applyGuestLlmApplication({ ...input, payload: null,
    operationId: "22222222-2222-4222-8222-222222222222", expectedStateDigest: recovered.receipt.stateDigest }, fetcher);
  if (cleared.status !== "applied") throw new Error("Fixture clear failed");
  expect(cleared.receipt.provider).toBe(null); expect(writes).toBe(2);
  expect(fs.readFileSync(file, "utf8")).not.toContain(SETTING.apiKey);
  await stop(); await start();
  await expect(inspectGuestLlmApplication(target, fetcher)).resolves.toEqual({ ok: true, receipt: cleared.receipt });
});

it.each(["{", "", "null", "[]", '{"unexpected":true}', '{"provider":false}'])("does not turn invalid legacy JSON %j into a credential clear", async body => {
  fs.writeFileSync(file, JSON.stringify(SETTING), { mode: 0o600 });
  const before = fs.readFileSync(file, "utf8");
  const result = await request("/api/llm", { method: "POST", body });
  expect(result.status).toBe(400);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.body).not.toContain(SETTING.apiKey);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("authenticates operation routes before inspecting storage", async () => {
  for (const method of ["GET", "POST"]) {
    const result = await request("/api/llm/application", { method, token: null, body: method === "POST" ? "{}" : undefined });
    expect(result.status).toBe(401);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).not.toContain(TOKEN);
  }
  expect(fs.existsSync(file)).toBe(false);
});

it("advertises only the supported runtime's application protocol", async () => {
  expect(JSON.parse((await request("/api/meta", { token: null })).body).llmApplication).toBe(PROTOCOL);
  await stop(); await start("generic");
  expect(JSON.parse((await request("/api/meta", { token: null })).body).llmApplication).toBeUndefined();
  expect((await request("/api/llm/application")).status).toBe(409);
  expect(fs.existsSync(file)).toBe(false);
});

it("returns a durable key-free receipt across a real gateway restart and exact replay", async () => {
  const state = JSON.parse((await request("/api/llm/application")).body);
  const input = JSON.stringify({ protocol: PROTOCOL, operationId: OPERATION, expectedStateDigest: state.stateDigest, payload: SETTING });
  const applied = await request("/api/llm/application", { method: "POST", body: input });
  expect(applied.status).toBe(200);
  expect(applied.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(applied.body)).toMatchObject({ ok: true, operationId: OPERATION, provider: "venice" });
  expect(applied.body).not.toContain(SETTING.apiKey);
  const inode = fs.statSync(file).ino;
  await stop(); await start();
  expect((await request("/api/llm/application")).body).toBe(applied.body);
  expect((await request("/api/llm/application", { method: "POST", body: input })).body).toBe(applied.body);
  expect(fs.statSync(file).ino).toBe(inode);
  expect(JSON.parse((await request("/api/llm")).body)).toMatchObject({ provider: "venice", model: SETTING.model });
});

it("rejects legacy writes after a recorded operation while keeping the original setting", async () => {
  const state = JSON.parse((await request("/api/llm/application")).body);
  await request("/api/llm/application", { method: "POST", body: JSON.stringify({ protocol: PROTOCOL, operationId: OPERATION, expectedStateDigest: state.stateDigest, payload: SETTING }) });
  const before = fs.readFileSync(file, "utf8");
  for (const body of ["{}", JSON.stringify({ ...SETTING, apiKey: "another-fixture-key" })]) {
    const result = await request("/api/llm", { method: "POST", body });
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body).code).toBe("application_protocol_required");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }
});

it("preserves repeated explicit legacy set and clear until application protocol adoption", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await request("/api/llm", { method: "POST", body: JSON.stringify(SETTING) })).status).toBe(200);
    expect(JSON.parse((await request("/api/llm")).body).provider).toBe("venice");
    expect((await request("/api/llm", { method: "POST", body: "{}" })).status).toBe(200);
    expect(JSON.parse((await request("/api/llm")).body).provider).toBe(null);
    expect(fs.readFileSync(file, "utf8")).not.toContain(SETTING.apiKey);
  }
});

it("spawns pinned Codex with Responses for configured providers, keeping the key out of argv and native auth unchanged", async () => {
  await stop(); await start("codex", true);
  const spawns: Array<{ args: string[]; modelKey: string | null }> = [];
  child!.on("message", (message: { spawn?: { args: string[]; modelKey: string | null } }) => { if (message.spawn) spawns.push(message.spawn); });
  expect((await request("/api/llm", { method: "POST", body: JSON.stringify(SETTING) })).status).toBe(200);
  const providerState = await request("/api/llm");
  expect(JSON.parse(providerState.body)).toMatchObject({ provider: "venice", providerChatProtocol: "responses-v1" });
  expect(providerState.body).not.toContain(SETTING.apiKey);
  const chat = await request("/api/chat", { method: "POST", body: JSON.stringify({ message: "fixture only" }) });
  expect(chat.status).toBe(200);
  expect(spawns).toHaveLength(1);
  expect(spawns[0].args).toEqual(expect.arrayContaining(['model_providers.venice.wire_api="responses"', 'model_providers.venice.requires_openai_auth=false', 'web_search="disabled"']));
  expect(spawns[0].modelKey).toBe(SETTING.apiKey);
  expect(JSON.stringify(spawns[0].args)).not.toContain(SETTING.apiKey);
  expect((await request("/api/llm", { method: "POST", body: "{}" })).status).toBe(200);
  await request("/api/chat", { method: "POST", body: JSON.stringify({ message: "fixture native" }) });
  expect(spawns).toHaveLength(2);
  expect(spawns[1].modelKey).toBeNull();
  expect(spawns[1].args.join(" ")).not.toContain("model_provider");
});

it("reports corrupt configuration rather than claiming native settings or leaking file errors", async () => {
  fs.writeFileSync(file, "{", { mode: 0o600 });
  for (const route of ["/api/llm", "/api/llm/application"]) {
    const result = await request(route);
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).code).toBe("storage_unavailable");
    expect(result.body).not.toContain(root);
  }
  expect(fs.readFileSync(file, "utf8")).toBe("{");
  const turn = await request("/api/chat", { method: "POST", body: JSON.stringify({ message: "fixture must not execute" }) });
  expect(turn.status).toBe(503);
  expect(JSON.parse(turn.body).code).toBe("storage_unavailable");
  expect((await request("/healthz")).status).toBe(200);
});

it.each(["{", "null", "[]", "{}"])("rejects malformed operation input %j without changing settings", async body => {
  fs.writeFileSync(file, JSON.stringify(SETTING), { mode: 0o600 });
  const before = fs.readFileSync(file, "utf8");
  const result = await request("/api/llm/application", { method: "POST", body });
  expect(result.status).toBe(400);
  expect(JSON.parse(result.body).code).toBe("invalid_request");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("bounds operation request bodies and keeps the gateway running", async () => {
  const result = await request("/api/llm/application", { method: "POST", body: "x".repeat(16385) });
  expect(result.status).toBe(413);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(fs.existsSync(file)).toBe(false);
  expect((await request("/healthz")).status).toBe(200);
});

it("does not grant the control-plane application protocol to a browser session cookie", async () => {
  const bootstrap = await request("/auth/bootstrap", { method: "POST", token: null,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://canary.hivra.test" },
    body: new URLSearchParams({ token: TOKEN, destination: "/" }).toString() });
  expect(bootstrap.status).toBe(303);
  const cookie = bootstrap.headers["set-cookie"]![0].split(";")[0];
  for (const method of ["GET", "POST"]) {
    const result = await request("/api/llm/application", { method, token: null, headers: { Cookie: cookie, Origin: "https://box.hivra.test" }, body: method === "POST" ? "{}" : undefined });
    expect(result.status).toBe(401);
  }
  expect(fs.existsSync(file)).toBe(false);
});
