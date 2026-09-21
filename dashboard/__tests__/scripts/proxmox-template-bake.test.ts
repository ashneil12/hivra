import { buildBakeScript, parseArgs } from "../../scripts/proxmox-template-bake";

function decodeGuestScript(hostScript: string): string {
  const match = hostScript.match(/^GUEST_B64='([^']+)'$/m);
  if (!match) throw new Error("GUEST_B64 not found");
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("proxmox template bake script", () => {
  it("uses resolved target env defaults for the source template and temporary IP", () => {
    const args = parseArgs(["--new", "9006", "--apply"], {
      PROXMOX_TEMPLATE_ID: "9005",
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.22",
    });

    expect(args.sourceTemplate).toBe(9005);
    expect(args.temporaryIp).toBe("10.250.22.248");
    expect(args.diskSizeGb).toBe(30);
  });

  it("allows the bake disk size to be overridden", () => {
    const args = parseArgs(["--new", "9006", "--disk-size-gb", "40", "--apply"], {
      PROXMOX_TEMPLATE_ID: "9005",
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.22",
    });

    expect(args.diskSizeGb).toBe(40);

    const legacyArgs = parseArgs(["--new", "9006", "--disk-gb", "45", "--apply"], {
      PROXMOX_TEMPLATE_ID: "9005",
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.22",
    });

    expect(legacyArgs.diskSizeGb).toBe(45);
  });

  it("uses resolved target env values in the generated host script", () => {
    const script = buildBakeScript(
      {
        sourceTemplate: 9005,
        newTemplate: 9006,
        name: "hermes-template-baked-main-9006",
        temporaryIp: "10.250.22.248",
        diskSizeGb: 30,
        thinBase: false,
        apply: true,
      },
      "dashboard-main",
      {
        PROXMOX_PRIVATE_GATEWAY: "10.250.22.1",
        PROXMOX_PRIVATE_CIDR: "24",
        PROXMOX_VM_SSH_USER: "hermes",
        PROXMOX_VM_SSH_KEY_PATH: "/etc/hivra/keys/vm-orchestrator",
        HERMES_AGENT_IMAGE: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
        HERMES_WEBUI_IMAGE: "ghcr.io/ashneil12/hermes-webui:stable",
        HERMES_TEMPLATE_HELPER_IMAGES: "busybox:latest node:22-alpine",
      }
    );

    expect(script).toContain("SOURCE_TEMPLATE='9005'");
    expect(script).toContain("TEMP_IP='10.250.22.248'");
    expect(script).toContain("DISK_SIZE_GB='30'");
    expect(script).toContain("Could not determine cloned scsi0 disk size");
    expect(script).toContain('qm resize "$NEW_TEMPLATE" scsi0 "${DISK_SIZE_GB}G"');
    expect(script).toContain("GATEWAY='10.250.22.1'");
    expect(script).toContain("WEBUI_IMAGE='ghcr.io/ashneil12/hermes-webui:stable'");
    expect(script).toContain("HELPER_IMAGES='busybox:latest node:22-alpine'");

    const guestScript = decodeGuestScript(script);
    expect(guestScript).toContain("quiescing background apt/packagekit before Docker image refresh");
    expect(guestScript).toContain("apt-daily.timer apt-daily-upgrade.timer");
    expect(guestScript).toContain("pgrep -af 'apt.systemd.daily|unattended-upgrade|packagekitd|apt-get|dpkg|aptitude'");
    expect(guestScript).toContain('systemctl mask "$unit"');
    expect(guestScript).toContain("apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin");
    expect(guestScript.indexOf("quiescing background apt/packagekit")).toBeLessThan(
      guestScript.indexOf("docker system prune -af")
    );
    expect(guestScript.indexOf("apt-mark hold")).toBeLessThan(
      guestScript.indexOf("docker system prune -af")
    );
    expect(guestScript).toContain("docker system prune -af");
    expect(guestScript).toContain("growpart");
    expect(guestScript).toContain("df -h /");
    expect(guestScript).toContain('for image in $HELPER_IMAGES; do');
    expect(guestScript).toContain('"helperImages": "$HELPER_IMAGES"');
  });

  describe("--thin-base", () => {
    const env = {
      PROXMOX_PRIVATE_GATEWAY: "10.250.22.1",
      PROXMOX_PRIVATE_CIDR: "24",
      PROXMOX_VM_SSH_USER: "hermes",
      PROXMOX_VM_SSH_KEY_PATH: "/etc/hivra/keys/vm-orchestrator",
      HERMES_AGENT_IMAGE: "ghcr.io/ashneil12/vanilla-hermes-agent:stable",
      HERMES_WEBUI_IMAGE: "ghcr.io/ashneil12/hermes-webui:stable",
      HERMES_TEMPLATE_HELPER_IMAGES: "busybox:latest node:22-alpine",
    };

    it("parseArgs sets thinBase: true when --thin-base is passed", () => {
      const args = parseArgs(["--source", "9006", "--new", "9007", "--thin-base", "--apply"]);
      expect(args.thinBase).toBe(true);
      expect(args.name).toBe("hermes-template-thin-base-9007");
    });

    it("parseArgs defaults thinBase to false when --thin-base is omitted", () => {
      const args = parseArgs(["--source", "9006", "--new", "9007", "--apply"]);
      expect(args.thinBase).toBe(false);
      expect(args.name).toBe("hermes-template-baked-v0.12.x-ash-007-bankr");
    });

    it("parseArgs lets --name override the thin-base default", () => {
      const args = parseArgs([
        "--source",
        "9006",
        "--new",
        "9007",
        "--thin-base",
        "--name",
        "custom-name",
        "--apply",
      ]);
      expect(args.thinBase).toBe(true);
      expect(args.name).toBe("custom-name");
    });

    it("buildBakeScript with thinBase: true skips agent/webui pulls and keeps caddy + helpers", () => {
      const script = buildBakeScript(
        {
          sourceTemplate: 9006,
          newTemplate: 9007,
          name: "hermes-template-thin-base-9007",
          temporaryIp: "10.250.22.248",
          diskSizeGb: 30,
          thinBase: true,
          apply: true,
        },
        "dashboard-thinbase",
        env
      );

      const guestScript = decodeGuestScript(script);
      expect(guestScript).not.toContain('"$AGENT_IMAGE"');
      expect(guestScript).not.toContain('"$WEBUI_IMAGE"');
      expect(guestScript).not.toContain("agent_digest=");
      expect(guestScript).not.toContain("webui_digest=");
      expect(guestScript).toContain('for image in "$CADDY_IMAGE"; do');
      expect(guestScript).toContain('caddy_digest="$(docker image inspect');
      expect(guestScript).toContain('for image in $HELPER_IMAGES; do');
    });

    it("buildBakeScript with thinBase: true stamps null agent/webui fields and thinBase: true in provenance", () => {
      const script = buildBakeScript(
        {
          sourceTemplate: 9006,
          newTemplate: 9007,
          name: "hermes-template-thin-base-9007",
          temporaryIp: "10.250.22.248",
          diskSizeGb: 30,
          thinBase: true,
          apply: true,
        },
        "dashboard-thinbase",
        env
      );

      const guestScript = decodeGuestScript(script);
      expect(guestScript).toContain('"agentImage": null');
      expect(guestScript).toContain('"agentDigest": null');
      expect(guestScript).toContain('"webuiImage": null');
      expect(guestScript).toContain('"webuiDigest": null');
      expect(guestScript).toContain('"thinBase": true');
      expect(guestScript).toContain('"caddyImage": "$CADDY_IMAGE"');
      expect(guestScript).toContain('"caddyDigest": "$caddy_digest"');
      expect(guestScript).toContain('"helperImages": "$HELPER_IMAGES"');
      expect(guestScript).toContain('"dashboardCommit": "$DASHBOARD_COMMIT"');
      expect(guestScript).toContain('"bankrRuntime": true');
    });

    it("buildBakeScript with thinBase: false is byte-identical to legacy output", () => {
      const script = buildBakeScript(
        {
          sourceTemplate: 9005,
          newTemplate: 9006,
          name: "hermes-template-baked-main-9006",
          temporaryIp: "10.250.22.248",
          diskSizeGb: 30,
          thinBase: false,
          apply: true,
        },
        "dashboard-main",
        env
      );

      expect(script).toMatchSnapshot();
    });
  });
});
