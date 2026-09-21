import {
  buildWebUISignalDaemonScript,
  WEBUI_SIGNAL_CLI_VERSION,
  WEBUI_SIGNAL_JRE_MAJOR,
  WEBUI_SIGNAL_DAEMON_CONTAINER_PATH,
} from "../webui-signal-daemon";

describe("webui-signal-daemon script", () => {
  const script = buildWebUISignalDaemonScript();

  it("is a POSIX sh script that satisfies the bootstrap heredoc contract", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    // The heredoc helper emits `${body}__HERMES_EOF__` — a body without a
    // trailing newline would glue the terminator onto the last line.
    expect(script.endsWith("\n")).toBe(true);
    expect(script).not.toContain("__HERMES_EOF__");
    // TS-template escapes must have rendered (no stray `\$`, no leaked
    // `${WEBUI_...}` placeholders, no `undefined` interpolations).
    expect(script).not.toContain("\\$");
    expect(script).not.toContain("${WEBUI_");
    expect(script).not.toContain("undefined");
  });

  it("never hardcodes the container home dir (it has changed before)", () => {
    // /home/hermeswebui -> /home/hermes happened once already; the script
    // must derive everything from $HERMES_HOME (with a $HOME fallback).
    expect(script).not.toContain("/home/hermes");
    expect(script).not.toContain("/home/hermeswebui");
    expect(script).toContain('HERMES_DIR="${HERMES_HOME:-${HOME}/.hermes}"');
  });

  it("installs everything into the persisted volume, nothing via apt/sudo", () => {
    // uid 1024, no sudo in prod: any package-manager path would silently
    // no-op. Installs must be tarball-unpack into $HERMES_HOME.
    expect(script).not.toMatch(/\bapt(-get)?\b/);
    expect(script).not.toMatch(/\bsudo\b/);
    expect(script).toContain('JRE_DIR="$HERMES_DIR/jre"');
    expect(script).toContain('CLI_DIR="$HERMES_DIR/signal-cli"');
    expect(script).toContain('DATA_DIR="$HERMES_DIR/signal-data"');
  });

  it("pins signal-cli and the matching JRE major together", () => {
    // 0.14.x is compiled for Java 25 (class-file 69); a mismatched JRE
    // throws UnsupportedClassVersionError at daemon start.
    expect(script).toContain(`SIGNAL_CLI_VERSION:-${WEBUI_SIGNAL_CLI_VERSION}`);
    expect(script).toContain(`SIGNAL_JRE_MAJOR:-${WEBUI_SIGNAL_JRE_MAJOR}`);
    expect(script).toContain("api.adoptium.net/v3/binary/latest/$SIGNAL_JRE_MAJOR/ga/linux/");
    expect(script).toContain(
      "github.com/AsamK/signal-cli/releases/download/v$SIGNAL_CLI_VERSION/signal-cli-$SIGNAL_CLI_VERSION.tar.gz"
    );
    // The JRE-major check reads the unpacked JRE's release file so a stale
    // wrong-major install self-heals instead of crash-looping.
    expect(script).toContain('JAVA_VERSION=\\"$SIGNAL_JRE_MAJOR[.\\"]');
  });

  it("rescues account data left in the ephemeral default location", () => {
    // An agent-led setup that linked the phone with signal-cli's default
    // XDG data dir would lose the link keys on the next container recreate.
    expect(script).toContain('.local/share/signal-cli/data');
    expect(script).toContain('cp -a "${HOME}/.local/share/signal-cli/."');
  });

  it("runs the daemon with persisted config on the loopback port from SIGNAL_HTTP_URL", () => {
    expect(script).toContain('url="${SIGNAL_HTTP_URL:-http://127.0.0.1:8080}"');
    expect(script).toContain('exec "$CLI_DIR/bin/signal-cli" --config "$DATA_DIR" daemon --http "127.0.0.1:$port"');
    expect(script).toContain('export JAVA_HOME="$JRE_DIR"');
  });

  it("exports a container path outside the persisted volume", () => {
    // The mount must always serve the builder-fresh script; a path under
    // ~/.hermes could shadow it with a stale persisted copy.
    expect(WEBUI_SIGNAL_DAEMON_CONTAINER_PATH.startsWith("/opt/")).toBe(true);
  });
});
