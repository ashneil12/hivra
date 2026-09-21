/** @jest-environment node */

jest.mock("server-only", () => ({}));

import {
  BUZZ_SPRIG_RELEASE,
  buildBuzzRuntimeHostScript,
  buildBuzzRuntimeInstallGuestScript,
  buildBuzzRuntimeObserveGuestScript,
  buildBuzzRuntimeRemoveGuestScript,
  parseBuzzRuntimeReceipt,
} from "../buzz-runtime";

const input = {
  bindingId: "00000000-0000-4000-8000-000000001014",
  agentId: "00000000-0000-4000-8000-000000001008",
  agentType: "codex",
  agentIp: "10.241.30.40",
  publicKey: "b".repeat(64),
  privateKey: "1".repeat(64),
  relayUrl: "wss://buzz.example",
  provider: "openai" as const,
  model: "gpt-5",
  apiKey: "sk-private-fixture",
  ownerPublicKey: "c".repeat(64),
  operationId: "00000000-0000-4000-8000-000000001017",
  requestDigest: "d".repeat(64),
  leaseId: "00000000-0000-4000-8000-000000001023",
};

describe("Buzz guest runtime", () => {
  function decodedEnvironment(script: string) {
    const encoded = script.match(/printf '%s' '([^']+)' \| base64 -d > '\/etc\/hivra\/buzz\//)?.[1];
    if (!encoded) throw new Error("environment payload missing");
    return Buffer.from(encoded, "base64").toString("utf8");
  }

  it("pins the reviewed Sprig source, archive and binary before enabling the service", () => {
    const script = buildBuzzRuntimeInstallGuestScript(input);
    expect(script).toContain(BUZZ_SPRIG_RELEASE.sourceGitSha);
    expect(script).toContain(BUZZ_SPRIG_RELEASE.targets.x86_64.archiveSha256);
    expect(script).toContain(BUZZ_SPRIG_RELEASE.targets.x86_64.binarySha256);
    expect(script).toContain(BUZZ_SPRIG_RELEASE.targets.aarch64.archiveSha256);
    expect(script).toContain("HIVRA_BUZZ_RUNTIME_FAILURE stage=%s code=%s");
    expect(script).toContain('case "${BUZZ_RUNTIME_TMP:-}"');
    expect(script).not.toContain("trap 'rm -rf");
    expect(script).toContain("FAILURE_STAGE=archive_digest");
    expect(script).toContain('grep -Fq "\\\"target\\\": \\\"${TARGET}\\\""');
    expect(script).not.toContain('grep -Fq ""target": "$TARGET""');
    expect(script).toContain("install -d -o root -g root -m 0755 /opt/hivra /opt/hivra/buzz");
    expect(script).toContain('install -d -o root -g root -m 0755 "$ROOT"');
    expect(script.indexOf('install -d -o root -g root -m 0755 "$ROOT"')).toBeLessThan(
      script.indexOf('if [ ! -x "$ROOT/sprig" ]'),
    );
    expect(script).toContain("install -d -o bux -g bux -m 0750 /var/lib/hivra/buzz");
    expect(script).not.toContain("mkdir -p /opt/hivra/buzz");
    expect(script).toContain("FAILURE_STAGE=service_health");
    expect(script).toContain("unexpected archive contents");
    expect(script).toContain('ln -sfn sprig "$ROOT/buzz"');
    expect(script.indexOf('ln -sfn sprig "$ROOT/buzz"')).toBeLessThan(
      script.indexOf("FAILURE_STAGE=activate_binary"),
    );
    expect(script).not.toContain("StrictHostKeyChecking");
    expect(script.indexOf("sha256sum \"$ARCHIVE\"")).toBeLessThan(script.indexOf("tar -xzf"));
    expect(script.indexOf("binary digest mismatch")).toBeLessThan(script.indexOf("systemctl enable --now"));
  });

  it("installs an owner-gated ACP sidecar and does not print secrets in its receipt", () => {
    const script = buildBuzzRuntimeInstallGuestScript(input);
    const environment = decodedEnvironment(script);
    expect(environment).toContain("BUZZ_ACP_RESPOND_TO=owner-only");
    expect(environment).toContain("BUZZ_ACP_AGENT_COMMAND=/opt/hivra/buzz/current/buzz-agent");
    expect(environment).toContain("BUZZ_ACP_MCP_COMMAND=/opt/hivra/buzz/current/buzz-dev-mcp");
    expect(environment).toContain("BUZZ_AGENT_REQUIRE_REPLY=1");
    expect(environment).toContain("BUZZ_AGENT_MAX_OUTPUT_TOKENS=32768");
    expect(Buffer.from(script.match(/printf '%s' '([^']+)' \| base64 -d > '\/etc\/systemd/)?.[1] ?? "", "base64").toString("utf8"))
      .toContain("ProtectSystem=strict");
    const receiptLine = script.split("\n").find((line) => line.includes("HIVRA_BUZZ_RUNTIME_V1")) ?? "";
    expect(receiptLine).not.toContain(input.apiKey);
    expect(receiptLine).not.toContain(input.privateKey);
  });

  it("routes Venice through its documented OpenAI-compatible chat endpoint", () => {
    const script = buildBuzzRuntimeInstallGuestScript({
      ...input, provider: "venice", model: "qwen3-4b",
    });
    const environment = decodedEnvironment(script);
    expect(environment).toContain("BUZZ_AGENT_PROVIDER=openai");
    expect(environment).toContain("OPENAI_COMPAT_BASE_URL=https://api.venice.ai/api/v1");
    expect(environment).toContain("OPENAI_COMPAT_API=chat");
    expect(environment).toContain("OPENAI_COMPAT_MODEL=qwen3-4b");
  });

  it("pins SSH to the host key attested by the selected VMID's guest-agent channel", () => {
    const host = buildBuzzRuntimeHostScript({
      agentIp: input.agentIp,
      vmid: 1112,
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      infrastructureBindingTag: `hivra-bind-${"a".repeat(32)}`,
    }, "echo guest");
    expect(host).toContain('qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub');
    expect(host).toContain("StrictHostKeyChecking=yes");
    expect(host).toContain('UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS"');
    expect(host).toContain('HostKeyAlias="$GUEST_SSH_HOST_ALIAS"');
    expect(host).toContain("flock -w 60 8");
    expect(host).toContain("qm config \"$VMID\"");
    expect(host).toContain("bound VM tag mismatch");
    expect(host).toContain("bound VM IP mismatch");
    expect(host).toContain("/etc/hivra/keys/vm-orchestrator");
    expect(host).not.toContain("StrictHostKeyChecking=no");
    expect(host).not.toContain("StrictHostKeyChecking=accept-new");
    expect(host).not.toContain("UserKnownHostsFile=/dev/null");
  });

  it("builds exact observe and idempotent secret-erasing removal operations", () => {
    const identity = {
      bindingId: input.bindingId,
      agentId: input.agentId,
      agentIp: input.agentIp,
      publicKey: input.publicKey,
    };
    expect(buildBuzzRuntimeObserveGuestScript(identity)).toContain('"action":"observed"');
    const remove = buildBuzzRuntimeRemoveGuestScript({ ...identity, operationId: input.operationId,
      requestDigest: input.requestDigest, leaseId: input.leaseId });
    expect(remove).toContain(`/etc/hivra/buzz/${input.bindingId}.env`);
    expect(remove).toContain("systemctl disable --now");
    expect(remove).toContain('"action":"removed"');
  });

  it("accepts one strict receipt and rejects ambiguous output", () => {
    const receipt = {
      protocol: "hivra-buzz-runtime-v1",
      action: "installed",
      bindingId: input.bindingId,
      agentId: input.agentId,
      publicKey: input.publicKey,
      serviceName: `hivra-buzz-${input.bindingId}.service`,
      sourceGitSha: BUZZ_SPRIG_RELEASE.sourceGitSha,
      observedAt: "2026-09-01T12:00:00Z",
      state: "active",
      architecture: "x86_64",
      archiveSha256: BUZZ_SPRIG_RELEASE.targets.x86_64.archiveSha256,
      binarySha256: BUZZ_SPRIG_RELEASE.targets.x86_64.binarySha256,
      provider: "openai",
      model: "gpt-5",
      ownerPublicKey: input.ownerPublicKey,
      operationId: input.operationId,
      requestDigest: input.requestDigest,
      leaseId: input.leaseId,
      mainPid: 42,
    };
    expect(parseBuzzRuntimeReceipt(`noise\nHIVRA_BUZZ_RUNTIME_V1 ${JSON.stringify(receipt)}\n`)).toEqual(receipt);
    expect(() => parseBuzzRuntimeReceipt(`HIVRA_BUZZ_RUNTIME_V1 ${JSON.stringify(receipt)}\nHIVRA_BUZZ_RUNTIME_V1 ${JSON.stringify(receipt)}`)).toThrow(/ambiguous/);
  });

  it("rejects unsafe model, secret and relay input before building a shell script", () => {
    expect(() => buildBuzzRuntimeInstallGuestScript({ ...input, model: "gpt-5\nBAD=1" })).toThrow();
    expect(() => buildBuzzRuntimeInstallGuestScript({ ...input, apiKey: "secret with spaces" })).toThrow();
    expect(() => buildBuzzRuntimeInstallGuestScript({ ...input, relayUrl: "ws://127.0.0.1:3000" })).toThrow();
  });
});
