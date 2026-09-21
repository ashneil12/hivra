import { buildProviderNativeRuntimeProbe, parseProviderNativeRuntimeReceipt } from "../provider-native-runtime";
import { nativeInstallFixture } from "@/lib/hivra/__tests__/provider-native-install.fixtures";

function fixture() {
  const f = nativeInstallFixture(), access = { mode: "cloudflare-named" as const,
    hostname: f.context.hostname!, tunnelId: f.context.tunnelId! };
  return { input: { identity: f.identity, access }, cookie: `__Host-hivra_auth=${"a".repeat(64)}`,
    invocationId: "b".repeat(32) };
}
it("binds the exact native identity/access and emits a fixed retained-service probe without credentials", () => {
  const f = fixture(), plan = buildProviderNativeRuntimeProbe(f.input);
  expect(plan.identity).toEqual(f.input.identity); expect(plan.access).toEqual(f.input.access);
  expect(plan.script).toContain("owner.verify_running()"); expect(plan.script).toContain("fcntl.LOCK_EX|fcntl.LOCK_NB");
  expect(plan.script).toContain("installer.verified_existing()"); expect(plan.script).toContain('"/etc","/etc/hivra"');
  expect(plan.script).toContain("expected_attrs=sorted"); expect(plan.script).toContain("/api/browser/status"); expect(plan.script).toContain("/vnc/");
  expect(plan.script).not.toContain(f.cookie); expect(plan.script).not.toContain("private-fixture-tunnel");
  const decoded = JSON.parse(Buffer.from(plan.script.match(/base64.b64decode\("([A-Za-z0-9+/=]+)"/)![1], "base64").toString());
  expect(decoded).toMatchObject({ identity: f.input.identity, access: f.input.access, origin: `https://${f.input.access.hostname}` });
  expect(decoded.rows.map((row: unknown[]) => row[0])).toEqual([
    "deepseek-harness/bux-hivra-chat.service", "deepseek-harness/install-native.py", "deepseek-harness/service-owner.py",
  ]);
  expect(decoded.gatewayRows.map((row: unknown[]) => row[0])).toEqual([
    "agent-zero-editor.cjs", "app.js", "deepseek-harness/gateway-policy.cjs", "deepseek-harness/native-broker.cjs",
    "deepseek-harness/runtime-process.cjs", "guarded-files.cjs", "index.html", "llm-application.js", "server.js",
  ]);
  expect(plan.script).toContain('sorted(os.listdir(gateway))');
});
it("refuses to declare the historical credential-leaking gateway ready", () => {
  const f = fixture(), historical = structuredClone(f.input);
  historical.identity.bundle.provisionerVersion = "2026.08.31.3" as "2026.09.02.8";
  historical.identity.bundle.bundleSha256 = "8f74ff4ce921d21c84784fdff6885f2ff60b1e83b9c1f3609a95422982bc16ec";
  expect(() => buildProviderNativeRuntimeProbe(historical)).toThrow("Invalid provider native runtime probe");
});
it("retains readiness for the immediately previous non-leaking native release", () => {
  const f = fixture(), previous = structuredClone(f.input);
  previous.identity.bundle.provisionerVersion = "2026.09.01.8" as "2026.09.02.8";
  previous.identity.bundle.bundleSha256 = "d641a55cb724a59abf5f5453b44bd00a4078be923956b5b82f11a0fd2fbcb4e0";
  const plan = buildProviderNativeRuntimeProbe(previous);
  expect(plan.identity).toEqual(previous.identity);
  const decoded = JSON.parse(Buffer.from(plan.script.match(/base64.b64decode\("([A-Za-z0-9+/=]+)"/)![1], "base64").toString());
  const server = decoded.gatewayRows.find((row: unknown[]) => row[0] === "server.js");
  expect(server[1]).toBe("e5141de9be583e23e9d002f290c09b1d5e9245e4fb8a3eb2b4ce528ff9d9cab4");
});
it("retains readiness for the older reviewed non-leaking native release", () => {
  const f = fixture(), older = structuredClone(f.input);
  older.identity.bundle.provisionerVersion = "2026.08.31.4" as "2026.09.02.8";
  older.identity.bundle.bundleSha256 = "bb67d66049af310db6f91b9627bd6e0bc25543e9629c9fc264d816b7ffb7b3aa";
  expect(buildProviderNativeRuntimeProbe(older).identity).toEqual(older.identity);
});
it("accepts only a bound opaque session and stable invocation receipt", () => {
  const f = fixture(), receipt = { version: 1, ready: true, identity: f.input.identity, access: f.input.access,
    sessionCookie: f.cookie, invocationId: f.invocationId } as const;
  expect(parseProviderNativeRuntimeReceipt(`HIVRA_PROVIDER_NATIVE_RUNTIME_V1 ${JSON.stringify(receipt)}\n`, f.input)).toEqual(receipt);
});
it.each(["identity", "access", "cookie", "invocation", "extra", "prefix", "suffix", "multiline"])("rejects malformed or unbound %s output", field => {
  const f = fixture(), receipt: Record<string, unknown> = { version: 1, ready: true, identity: f.input.identity, access: f.input.access,
    sessionCookie: f.cookie, invocationId: f.invocationId };
  if (field === "identity") receipt.identity = { ...f.input.identity, operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  if (field === "access") receipt.access = { ...f.input.access, hostname: "other.example.test" };
  if (field === "cookie") receipt.sessionCookie = `dsh-auth=${"a".repeat(64)}`;
  if (field === "invocation") receipt.invocationId = "0".repeat(32);
  if (field === "extra") receipt.apiToken = "private";
  let output = `HIVRA_PROVIDER_NATIVE_RUNTIME_V1 ${JSON.stringify(receipt)}\n`;
  if (field === "prefix") output = "private log\n" + output;
  if (field === "suffix") output += "private log";
  if (field === "multiline") output = output.replace("\n", "\n\n");
  expect(() => parseProviderNativeRuntimeReceipt(output, f.input)).toThrow("Invalid provider native runtime receipt");
});
it("returns a bounded failure without inventing session authority", () => {
  const f = fixture(), receipt = { version: 1, ready: false, identity: f.input.identity, access: f.input.access, reason: "service_unverified" } as const;
  expect(parseProviderNativeRuntimeReceipt(`HIVRA_PROVIDER_NATIVE_RUNTIME_V1 ${JSON.stringify(receipt)}\n`, f.input)).toEqual(receipt);
});
