import {
  buildTailscaleDisableScript,
  buildTailscaleEnrollCommand,
  buildTailscaleInstallScript,
  formatTailscaleCommandError,
  parseTailscaleStatusJson,
  redactTailscaleError,
} from "@/lib/services/tailscale-private-access";

describe("tailscale private access service helpers", () => {
  it("builds an install script that installs and starts tailscale", () => {
    const script = buildTailscaleInstallScript();

    // Download-then-run, never `curl ... | sh`: a piped install hides a
    // failed download behind sh's (zero) exit status, silently leaving the
    // host with no tailscaled.
    expect(script).toContain(
      'curl -fsSL https://tailscale.com/install.sh -o "$ts_installer"'
    );
    expect(script).not.toContain("curl -fsSL https://tailscale.com/install.sh | sh");
    // Ensures curl exists before attempting the download (minimal hosts).
    expect(script).toContain("apt-get install -y curl");
    expect(script).toContain(
      "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then"
    );
    expect(script).toContain("systemctl enable --now tailscaled");
    expect(script).toContain("nohup tailscaled");
    expect(script).toContain("--tun=userspace-networking");
    expect(script).toContain("/var/log/hermes-tailscaled.log");
    expect(script).toContain("tailscaled did not become ready");
  });

  it("uses an environment variable for the auth key during enrollment", () => {
    const command = buildTailscaleEnrollCommand({
      authKeyEnvVar: "TAILSCALE_AUTH_KEY",
      machineName: "atlas-agent",
      tags: ["tag:prod", "tag:hermes"],
      enableSsh: true,
    });

    expect(command).toContain('tailscale up --auth-key "$TAILSCALE_AUTH_KEY"');
    expect(command).toContain("--hostname='atlas-agent'");
    expect(command).toContain("--advertise-tags='tag:prod,tag:hermes'");
    expect(command).toContain("--ssh");
    expect(command).not.toContain("tskey-auth-");
  });

  it("shell-quotes enrollment values that come from request data", () => {
    const command = buildTailscaleEnrollCommand({
      authKeyEnvVar: "TAILSCALE_AUTH_KEY",
      machineName: "atlas-agent; rm -rf /",
      tags: ["tag:prod", "tag:ops; touch /tmp/pwned"],
    });

    expect(command).toContain("--hostname='atlas-agent; rm -rf /'");
    expect(command).toContain("--advertise-tags='tag:prod,tag:ops; touch /tmp/pwned'");
    expect(command).not.toContain("--hostname atlas-agent; rm -rf /");
    expect(command).not.toContain("--advertise-tags tag:prod,tag:ops; touch /tmp/pwned");
  });

  it("rejects invalid auth key environment variable names", () => {
    expect(() =>
      buildTailscaleEnrollCommand({
        authKeyEnvVar: "TAILSCALE_AUTH_KEY; rm -rf /",
      })
    ).toThrow("Invalid auth key env var name");
  });

  it("builds a disable script that safely removes tailscale state", () => {
    const script = buildTailscaleDisableScript();

    expect(script).toContain("tailscale logout");
    expect(script).toContain(
      "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then"
    );
    expect(script).toContain("systemctl disable --now tailscaled");
    expect(script).toContain("pkill -x tailscaled");
  });

  it("parses a tailscale status payload into a dashboard snapshot", () => {
    const snapshot = parseTailscaleStatusJson(
      JSON.stringify({
        Self: {
          HostName: "atlas-agent",
          DNSName: "atlas-agent.customer.ts.net.",
          TailscaleIPs: ["100.64.0.4", "fd7a:115c:a1e0::4"],
          SSHEnabled: true,
        },
        CurrentTailnet: {
          Name: "customer.ts.net",
        },
      })
    );

    expect(snapshot).toEqual({
      machineName: "atlas-agent",
      magicDnsName: "atlas-agent.customer.ts.net",
      tailnetName: "customer.ts.net",
      ipv4: "100.64.0.4",
      ipv6: "fd7a:115c:a1e0::4",
      sshEnabled: true,
    });
  });

  it("redacts raw auth keys from surfaced errors", () => {
    expect(
      redactTailscaleError(
        "tailscale up failed for tskey-auth-123456789",
        "tskey-auth-123456789"
      )
    ).toBe("tailscale up failed for [REDACTED]");
  });

  describe("formatTailscaleCommandError", () => {
    it("prepends captured stderr ahead of the bare remote-exit error", () => {
      const message = formatTailscaleCommandError(
        {
          stderr: "ssh: connect to host 10.250.30.80 port 22: No route to host",
          error: "Remote bash exited with code 255",
        },
        "Failed to configure Tailscale",
      );

      expect(message).toContain("No route to host");
      expect(message).toContain("Remote bash exited with code 255");
    });

    it("falls back to stdout when stderr is empty for generic remote exits", () => {
      const message = formatTailscaleCommandError(
        {
          stdout: "tailscale up: auth key rejected by control plane",
          stderr: "",
          error: "Remote bash exited with code 1",
        },
        "Failed to configure Tailscale",
      );

      expect(message).toContain("auth key rejected by control plane");
      expect(message).toContain("Remote bash exited with code 1");
    });

    it("surfaces a code-255 hint when no stream output was captured", () => {
      const message = formatTailscaleCommandError(
        {
          stdout: "",
          stderr: "",
          error: "Remote bash exited with code 255",
        },
        "Failed to configure Tailscale",
      );

      expect(message).not.toBe("Remote bash exited with code 255");
      expect(message).toContain("management SSH bridge");
      expect(message).toContain("exit 255");
    });

    it("falls back to the supplied fallback for non-generic errors with no streams", () => {
      const message = formatTailscaleCommandError(
        { stdout: "", stderr: "", error: "" },
        "Failed to configure Tailscale",
      );

      expect(message).toBe("Failed to configure Tailscale");
    });

    it("redacts the supplied auth key from generic-exit hint output", () => {
      const message = formatTailscaleCommandError(
        {
          stderr: "ssh: connect to host 10.250.30.80 port 22: tskey-auth-xyz",
          error: "Remote bash exited with code 255",
        },
        "Failed to configure Tailscale",
        "tskey-auth-xyz",
      );

      expect(message).not.toContain("tskey-auth-xyz");
      expect(message).toContain("[REDACTED]");
    });
  });
});
