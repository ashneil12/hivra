import {
  resolveRemoteDesktopInspectionRuntime,
  resolveRemoteDesktopProfileRuntime,
} from "../profile-runtime";

describe("resolveRemoteDesktopProfileRuntime", () => {
  it("maps current and legacy Ubuntu computers to the accepted Selkies runtime", () => {
    expect(resolveRemoteDesktopProfileRuntime({
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
    })).toMatchObject({
      ok: true,
      runtime: {
        profile: "ubuntu-desktop",
        compositor: "x11",
        transport: "selkies-websocket",
        preparation: "selkies-guest-installer",
      },
    });
    expect(resolveRemoteDesktopProfileRuntime({
      type: "linux-desktop",
      computer_profile: null,
    })).toMatchObject({ ok: true, runtime: { profile: "ubuntu-desktop" } });
  });

  it("admits Omarchy's verified browser lane while keeping inspection on the same capability", () => {
    expect(resolveRemoteDesktopProfileRuntime({
      type: "linux-desktop",
      computer_profile: "omarchy",
    })).toMatchObject({ ok: true, runtime: {
      profile: "omarchy", compositor: "wayland", transport: "selkies-websocket", preparation: "not-admitted",
    } });
    expect(resolveRemoteDesktopInspectionRuntime({
      type: "linux-desktop",
      computer_profile: "omarchy",
    })).toEqual({
      ok: true,
      runtime: {
        profile: "omarchy",
        compositor: "wayland",
        transport: "selkies-websocket",
        preparation: "not-admitted",
      },
    });
  });

  it("keeps Windows on its distinct RDP path", () => {
    expect(resolveRemoteDesktopProfileRuntime({
      type: "linux-desktop",
      computer_profile: "windows",
    })).toEqual({
      ok: false,
      code: "computer_profile_not_ready",
      profile: "windows",
      message: "Windows desktop access is waiting for its licensed image and RDP gateway.",
    });
    expect(resolveRemoteDesktopInspectionRuntime({
      type: "linux-desktop",
      computer_profile: "windows",
    })).toEqual({
      ok: true,
      runtime: {
        profile: "windows",
        compositor: "windows",
        transport: "guacamole-rdp",
        preparation: "not-admitted",
      },
    });
  });

  it("rejects agents and unknown profiles", () => {
    expect(resolveRemoteDesktopProfileRuntime({ type: "codex", computer_profile: null }))
      .toMatchObject({ ok: false, code: "unsupported_computer" });
    expect(resolveRemoteDesktopProfileRuntime({ type: "linux-desktop", computer_profile: "macos" }))
      .toMatchObject({ ok: false, code: "unsupported_computer" });
  });
});
