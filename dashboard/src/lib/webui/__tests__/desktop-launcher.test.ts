import {
  buildDesktopConnectionConfig,
  buildDesktopInlineCommand,
  buildDesktopLauncherScript,
  desktopLauncherFilename,
} from "@/lib/webui/desktop-launcher";

const conn = {
  gatewayUrl: "https://agent.example.com/desktop",
  token: "abc123def456",
};

describe("desktop-launcher", () => {
  it("builds the exact connection.json the Desktop app reads (plaintext token)", () => {
    const parsed = JSON.parse(buildDesktopConnectionConfig(conn));
    expect(parsed).toEqual({
      mode: "remote",
      remote: {
        url: "https://agent.example.com/desktop",
        token: { value: "abc123def456" },
      },
    });
    // token MUST be plaintext (no safeStorage encoding) so a script can write it
    expect(parsed.remote.token.encoding).toBeUndefined();
  });

  it.each(["macos", "linux", "windows"] as const)(
    "setup script writes a valid connection.json with the url + plaintext token (%s)",
    (os) => {
      const script = buildDesktopLauncherScript(os, conn);
      // the embedded config is valid JSON carrying url + token
      expect(script).toContain('"mode":"remote"');
      expect(script).toContain(conn.gatewayUrl);
      expect(script).toContain(conn.token);
      expect(script).toContain('"value":"abc123def456"');
      // writes connection.json (for persistence)
      expect(script).toContain("connection.json");
      // AND env-launches once to bypass the fresh-install installer
      expect(script).toContain("HERMES_DESKTOP_REMOTE_URL");
      expect(script).toContain("HERMES_DESKTOP_REMOTE_TOKEN");
      // points at the official download when the app is missing
      expect(script).toContain("hermes-agent.nousresearch.com/desktop");
    }
  );

  it("targets the correct userData path per OS", () => {
    expect(buildDesktopLauncherScript("macos", conn)).toContain(
      '"$HOME/Library/Application Support/Hermes"'
    );
    expect(buildDesktopLauncherScript("linux", conn)).toContain(
      '${XDG_CONFIG_HOME:-$HOME/.config}/Hermes'
    );
    expect(buildDesktopLauncherScript("windows", conn)).toContain(
      '"$env:APPDATA\\Hermes"'
    );
  });

  it("launches Hermes (env-launch) so it connects past the fresh-install installer", () => {
    expect(buildDesktopLauncherScript("macos", conn)).toContain(
      "/Applications/Hermes.app/Contents/MacOS/"
    );
    expect(buildDesktopLauncherScript("windows", conn)).toContain("Hermes.exe");
    expect(buildDesktopLauncherScript("linux", conn)).toMatch(/hermes-desktop|hermes/);
  });

  it("inline command writes the same config", () => {
    for (const os of ["macos", "linux", "windows"] as const) {
      const cmd = buildDesktopInlineCommand(os, conn);
      expect(cmd).toContain("connection.json");
      expect(cmd).toContain(conn.gatewayUrl);
      expect(cmd).toContain(conn.token);
    }
  });

  it("single-quotes shell config so a stray char can't break the write", () => {
    const tricky = { gatewayUrl: "https://x/desktop", token: "a'b" };
    const sh = buildDesktopLauncherScript("linux", tricky);
    // ' inside is closed-escaped-reopened: a'\''b
    expect(sh).toContain("a'\\''b");
    const ps = buildDesktopLauncherScript("windows", tricky);
    // PowerShell doubles the quote: a''b
    expect(ps).toContain("a''b");
  });

  it("suggests an OS-appropriate filename", () => {
    expect(desktopLauncherFilename("macos")).toBe("connect-hermesos.command");
    expect(desktopLauncherFilename("linux")).toBe("connect-hermesos.sh");
    expect(desktopLauncherFilename("windows")).toBe("connect-hermesos.ps1");
  });
});
