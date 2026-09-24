import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";
import { createFirstBootChallenge, FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION } from "../first-boot-enrollment";
import { renderFirstBootCloudInit } from "../first-boot-cloud-init";

jest.mock("node:fs/promises", () => ({
  ...jest.requireActual("node:fs/promises"),
  readFile: jest.fn((...args: unknown[]) => jest.requireActual("node:fs/promises").readFile(...args)),
}));
const now = new Date("2026-08-27T15:00:00.000Z");
const binding = { userId: "fixture_owner", connectionId: "11111111-1111-4111-8111-111111111111",
  connectionRevision: 2, orderId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333", quoteFingerprint: "a".repeat(64),
  recipeVersion: FIRST_BOOT_RECIPE_VERSION };
const publicKey = "ssh-ed25519 " + Buffer.concat([
  Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, 1),
]).toString("base64");
function fixture() {
  return { ...createFirstBootChallenge(binding, now), currentBinding: binding,
    publicKeyOpenSsh: publicKey + " hivra-capacity", callbackOrigin: "https://hivra.example", now };
}
type RenderedConfig = {
  write_files: Array<{path: string; owner: string; permissions: string; content: string}>;
  runcmd: string[][];
  users: unknown;
};
function parse(data: string): RenderedConfig {
  expect(data.startsWith("#cloud-config\n")).toBe(true);
  return JSON.parse(data.slice("#cloud-config\n".length));
}
function fileContent(config: ReturnType<typeof parse>, path: string) {
  const file = config.write_files.find(file => file.path === path);
  if (!file) throw new Error("Expected rendered fixture file is missing");
  return Buffer.from(file.content, "base64").toString("utf8");
}

describe("private deterministic first-boot recipe", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders stable bounded user-data with only fixed commands and the expected administrative key", async () => {
    const input = fixture();
    const text = await renderFirstBootCloudInit(input);
    expect(await renderFirstBootCloudInit(input)).toBe(text);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_768);
    const config = parse(text);
    expect(config.users).toEqual([{name:"hivra", groups:["sudo"], sudo:["ALL=(ALL) NOPASSWD:ALL"],
      shell:"/bin/bash", lock_passwd:true, ssh_authorized_keys:[publicKey]}]);
    expect(config).toMatchObject({ ssh_pwauth:false, disable_root:true, ssh_deletekeys:true,
      ssh_genkeytypes:["ed25519"], ssh_publish_hostkeys:{enabled:false} });
    expect(config.runcmd).toEqual([["/bin/sh", "-eu", "-c", [
      "ufw default deny incoming", "ufw default allow outgoing",
      "ufw allow 22/tcp", "ufw --force enable", "/usr/sbin/sshd -t", "systemctl reload ssh",
      "exec /usr/bin/python3 -I -B /usr/local/lib/hivra/hetzner-enroll.py",
    ].join("\n")]]);
    expect(JSON.stringify(config.runcmd)).not.toContain(input.token);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(input.currentBinding.userId);
    expect(fileContent(config,"/etc/ssh/sshd_config.d/00-hivra-bootstrap.conf")).toContain("PermitRootLogin no\n");
  });
  it("embeds the exact vendored helper and root-only narrowly scoped configuration", async () => {
    const input = fixture();
    const config = parse(await renderFirstBootCloudInit(input));
    expect(config.write_files.map(file => [file.owner,file.permissions])).toEqual([
      ["root:root","0700"],["root:root","0600"],["root:root","0644"],
    ]);
    expect(fileContent(config,"/usr/local/lib/hivra/hetzner-enroll.py"))
      .toBe(readFileSync(join(process.cwd(),"bootstrap/hetzner-enroll.py"),"utf8"));
    // No absolute expiry reaches the guest: it measures 15 minutes from its own
    // first boot, and Hivra's receiver enforces the window it opened.
    expect(JSON.parse(fileContent(config,"/run/hivra/first-boot-enrollment.json"))).toEqual({
      version:2, recipeVersion: FIRST_BOOT_RECIPE_VERSION, orderId:binding.orderId, attemptId:binding.attemptId,
      token:input.token, callbackUrl:"https://hivra.example/api/infrastructure/first-boot/enroll",
    });
    expect(fileContent(config,"/run/hivra/first-boot-enrollment.json")).not.toContain(input.challenge.expiresAt);
  });
  it("round-trips the real rendered configuration through the real Python validator", async () => {
    const config = parse(await renderFirstBootCloudInit(fixture()));
    const run = (uptime: number) => spawnSync("python3", ["-B", "-c", [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('hivra_enroll','bootstrap/hetzner-enroll.py')",
      "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
      "try:",
      "  config=module.validate_config(json.load(sys.stdin),lambda:" + uptime + ")",
      "  print(json.dumps({'accepted':True,'recipeVersion':config['recipeVersion']}))",
      "except module.EnrollmentFailure as error:",
      "  print(json.dumps({'accepted':False,'code':error.code}))",
    ].join("\n")], { input:fileContent(config,"/run/hivra/first-boot-enrollment.json"), encoding:"utf8", timeout:5_000 });
    // The server was created long ago; only time since this first boot counts.
    for (const [uptime, expected] of [[30, {accepted:true,recipeVersion:FIRST_BOOT_RECIPE_VERSION}],
      [899.5, {accepted:true,recipeVersion:FIRST_BOOT_RECIPE_VERSION}], [900, {accepted:false,code:"ENROLLMENT_EXPIRED"}]] as const) {
      const result = run(uptime);
      expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
  });
  it("passes the helper's own offline unittest suite", () => {
    const result = spawnSync("python3", ["-B", "bootstrap/test_hetzner_enroll.py"], { encoding:"utf8", timeout:30_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/\nOK\s*$/);
  });
  it("renders only the current recipe; a legacy attempt gets no new user-data", async () => {
    const legacy = { ...binding, recipeVersion: FIRST_BOOT_LEGACY_RECIPE_VERSION };
    const input = { ...createFirstBootChallenge(legacy, now), currentBinding: legacy,
      publicKeyOpenSsh: publicKey, callbackOrigin: "https://hivra.example", now };
    await expect(renderFirstBootCloudInit(input)).rejects.toThrow("First-boot recipe unavailable: recipe_retired");
  });
  it.each(["http://hivra.example", "https://user:password@hivra.example", "https://hivra.example:8443",
    "https://hivra.example/other", "https://hivra.example?token=private", "https://hivra.example#fragment",
    "https://hivra.example\\@evil.example", "https://hivra.example\n", "https://-bad.example"])(
    "rejects unsafe configured callback origin %s", async callbackOrigin => {
      await expect(renderFirstBootCloudInit({...fixture(),callbackOrigin})).rejects.toThrow("invalid_origin");
    });
  it("fails closed when the helper is missing or altered, without echoing its contents", async () => {
    const read = jest.mocked(files.readFile);
    read.mockRejectedValueOnce(new Error("do not log this endpoint or secret"));
    await expect(renderFirstBootCloudInit(fixture())).rejects.toThrow("First-boot recipe unavailable: helper_unavailable");
    read.mockResolvedValueOnce(Buffer.from("unreviewed helper bytes"));
    await expect(renderFirstBootCloudInit(fixture())).rejects.toThrow("helper_unavailable");
  });
  it("refuses expired/tampered delivery or command injection before reading the helper", async () => {
    const read = jest.mocked(files.readFile);
    const input = fixture();
    await expect(renderFirstBootCloudInit({...input,now:new Date("2026-08-27T15:15:00Z")})).rejects.toThrow("expired");
    await expect(renderFirstBootCloudInit({...input,token:"hbe1_"+"z".repeat(43)})).rejects.toThrow("invalid_proof");
    await expect(renderFirstBootCloudInit({...input,publicKeyOpenSsh:publicKey+"\nexecute-command"})).rejects.toThrow("invalid_proof");
    expect(read).not.toHaveBeenCalled();
  });
});
