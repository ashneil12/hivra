import { createHash } from "node:crypto";

import { DOORBELL_BUNDLE_FILES } from "../doorbell-scripts";
import { isDoorbellAction, runDoorbellAction } from "../doorbell-host";

const TARGET = "fixturenode";
const BASE_ENV = {
  PROXMOX_FIXTURENODE_SSH_HOST: "fixture.invalid",
  PROXMOX_FIXTURENODE_SSH_USER: "root",
} as unknown as NodeJS.ProcessEnv;
const ON = { ...BASE_ENV, HIVRA_WAKE_DOORBELLS: "email" } as NodeJS.ProcessEnv;
const fakeAssets = DOORBELL_BUNDLE_FILES.map((name) => ({ relativePath: name, content: Buffer.from(`fixture ${name}\n`) }));

function deps(overrides: Record<string, unknown> = {}) {
  return {
    loadBundle: jest.fn(async () => fakeAssets),
    runHostScript: jest.fn(async () => ({ ok: true, stdout: "HIVRA_DOORBELL_RESULT status=installed step=health changed=1 ms=700\n", stderr: "" })),
    env: ON,
    ...overrides,
  } as unknown as Parameters<typeof runDoorbellAction>[1];
}

describe("runDoorbellAction", () => {
  it("knows its actions", () => {
    expect(isDoorbellAction("install-doorbell")).toBe(true);
    expect(isDoorbellAction("install-wake-proxy")).toBe(false);
  });

  it("installs only with HIVRA_WAKE_DOORBELLS and a configured target", async () => {
    const off = deps({ env: BASE_ENV });
    expect(await runDoorbellAction({ action: "install-doorbell", channel: "default", targetId: TARGET }, off))
      .toMatchObject({ ok: false, httpStatus: 409, error: "HIVRA_WAKE_DOORBELLS lists no channel." });
    expect(off!.runHostScript).not.toHaveBeenCalled();
    const elsewhere = deps();
    expect(await runDoorbellAction({ action: "install-doorbell", channel: "default", targetId: "elsewhere" }, elsewhere))
      .toMatchObject({ ok: false, httpStatus: 400 });
    expect(elsewhere!.runHostScript).not.toHaveBeenCalled();
  });

  it("installs with the reviewed digests", async () => {
    const d = deps();
    expect(await runDoorbellAction({ action: "install-doorbell", channel: "canary", targetId: TARGET }, d))
      .toMatchObject({ ok: true, result: { status: "installed", changed: true } });
    const script = (d!.runHostScript as jest.Mock).mock.calls[0][0] as string;
    for (const asset of fakeAssets) expect(script).toContain(createHash("sha256").update(asset.content).digest("hex"));
  });

  it("reports status without the switch, and a refused removal as 409", async () => {
    const status = deps({ env: BASE_ENV, runHostScript: jest.fn(async () => ({ ok: true,
      stdout: "HIVRA_DOORBELL_STATUS installed=1 active=active ok=1 armed=0 fired=0 helper=1 credential=1\n", stderr: "" })) });
    expect(await runDoorbellAction({ action: "doorbell-status", channel: "default", targetId: TARGET }, status))
      .toMatchObject({ ok: true, status: { installed: true, armed: 0 } });
    const refused = deps({ env: BASE_ENV, runHostScript: jest.fn(async () => ({ ok: false,
      stdout: "HIVRA_DOORBELL_RESULT status=refused step=dependents changed=0 ms=40\n", stderr: "holds arms" })) });
    expect(await runDoorbellAction({ action: "remove-doorbell", channel: "default", targetId: TARGET }, refused))
      .toMatchObject({ ok: false, httpStatus: 409 });
  });
});
