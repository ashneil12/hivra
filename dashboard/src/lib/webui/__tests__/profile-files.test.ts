import { writeWebUIProfileSystemPrompt } from "../profile-files";
import { sshExec } from "@/lib/hetzner/ssh";
import { SOUL_WROTE_MARKER, SOUL_SKIPPED_MARKER } from "../soul-guard";

jest.mock("@/lib/hetzner/ssh", () => ({ sshExec: jest.fn() }));

const mockedSshExec = sshExec as jest.Mock;

const okWrote = { ok: true, stdout: `${SOUL_WROTE_MARKER}\n`, stderr: "" };
const okSkipped = { ok: true, stdout: `${SOUL_SKIPPED_MARKER}\n`, stderr: "" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("writeWebUIProfileSystemPrompt", () => {
  it("sends a GUARDED write (never an unconditional clobber) by default", async () => {
    mockedSshExec.mockResolvedValue(okWrote);

    await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "default",
      systemPrompt: "# Bea",
    });

    expect(mockedSshExec).toHaveBeenCalledTimes(1);
    const [ip, cmd] = mockedSshExec.mock.calls[0];
    expect(ip).toBe("203.0.113.4");
    // The write is gated on the shared empty-or-factory-or-ritual guard.
    expect(cmd).toContain('[ ! -s "$soul_path" ]');
    expect(cmd).toContain('grep -qE "$head_pattern"');
    expect(cmd).toContain('cat > "$soul_path"');
    // Overwrite defaults off → trailing arg "0".
    expect(cmd.trimEnd().endsWith(" 0")).toBe(true);
  });

  it("returns { status: 'written' } when the box accepted the write", async () => {
    mockedSshExec.mockResolvedValue(okWrote);
    const res = await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "default",
      systemPrompt: "# Bea",
    });
    expect(res).toEqual({ status: "written" });
  });

  it("returns { status: 'skipped_existing_identity' } when the guard preserved the soul", async () => {
    mockedSshExec.mockResolvedValue(okSkipped);
    const res = await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "default",
      systemPrompt: "# overwrite attempt",
    });
    expect(res).toEqual({ status: "skipped_existing_identity" });
  });

  it("passes overwrite=1 down the wire when overwriteExistingIdentity is set", async () => {
    mockedSshExec.mockResolvedValue(okWrote);
    await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "default",
      systemPrompt: "# Bea",
      overwriteExistingIdentity: true,
    });
    const [, cmd] = mockedSshExec.mock.calls[0];
    expect(cmd.trimEnd().endsWith(" 1")).toBe(true);
  });

  it("targets the box's primary identity path for the default profile", async () => {
    mockedSshExec.mockResolvedValue(okWrote);
    await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "default",
      systemPrompt: "x",
    });
    const [, cmd] = mockedSshExec.mock.calls[0];
    expect(cmd).toContain(JSON.stringify("/home/hermes/.hermes"));
  });

  it("targets the isolated per-profile path for a non-default profile", async () => {
    mockedSshExec.mockResolvedValue(okWrote);
    await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "work",
      systemPrompt: "x",
    });
    const [, cmd] = mockedSshExec.mock.calls[0];
    expect(cmd).toContain("/home/hermes/.hermes/profiles/work");
  });

  it("base64-encodes the prompt for transport (handles UTF-8)", async () => {
    mockedSshExec.mockResolvedValue(okWrote);
    await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "default",
      systemPrompt: "héllo 🌍",
    });
    const [, cmd] = mockedSshExec.mock.calls[0];
    expect(cmd).toContain(Buffer.from("héllo 🌍", "utf8").toString("base64"));
  });

  it("throws when the ssh command fails", async () => {
    mockedSshExec.mockResolvedValue({ ok: false, stdout: "", stderr: "boom" });
    await expect(
      writeWebUIProfileSystemPrompt({
        instanceId: "abc",
        hostIp: "203.0.113.4",
        profileName: "default",
        systemPrompt: "x",
      }),
    ).rejects.toThrow(/Failed to write WebUI profile system prompt/);
  });

  // The thrown message is what the soul-seed reconcile logs (and stores in
  // SoulReconcileInstanceResult.error). A bare "Failed to write…" makes a failed
  // reseed undiagnosable from logs alone.
  it("carries the ssh stderr into the thrown message", async () => {
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "no running agent container",
    });
    await expect(
      writeWebUIProfileSystemPrompt({
        instanceId: "abc",
        hostIp: "203.0.113.4",
        profileName: "default",
        systemPrompt: "x",
      }),
    ).rejects.toThrow(/no running agent container/);
  });

  it("carries the ssh error into the thrown message when stderr is empty", async () => {
    // sshExec reports connection/timeout failures on `error` with an EMPTY
    // stderr — the exact case worth diagnosing.
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH operation timed out after 8000ms",
    });
    await expect(
      writeWebUIProfileSystemPrompt({
        instanceId: "abc",
        hostIp: "203.0.113.4",
        profileName: "default",
        systemPrompt: "x",
      }),
    ).rejects.toThrow(/SSH operation timed out after 8000ms/);
  });

  it("redacts secrets carried in the failure output", async () => {
    mockedSshExec.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "docker exec failed: leaked sk-live-abcdef123456",
    });

    const err = await writeWebUIProfileSystemPrompt({
      instanceId: "abc",
      hostIp: "203.0.113.4",
      profileName: "default",
      systemPrompt: "x",
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("[REDACTED]");
    expect(err?.message).not.toContain("sk-live-abcdef123456");
  });

  it("falls back to the bare message when the ssh failure carries no detail", async () => {
    mockedSshExec.mockResolvedValue({ ok: false, stdout: "", stderr: "   " });
    await expect(
      writeWebUIProfileSystemPrompt({
        instanceId: "abc",
        hostIp: "203.0.113.4",
        profileName: "default",
        systemPrompt: "x",
      }),
    ).rejects.toThrow(/^Failed to write WebUI profile system prompt$/);
  });
});
