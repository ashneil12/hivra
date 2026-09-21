import {
  buildFleetPersistenceReport,
  extractInstanceIdFromAgentContainer,
  formatFleetPersistenceMarkdownReport,
  type FleetHostProbe,
  type FleetInstanceRow,
} from "@/lib/recovery/fleet-persistence-sweep";

describe("fleet-persistence-sweep", () => {
  const instanceId = "00000000-0000-4000-8000-000000001054";

  it("extracts only main agent container instance IDs", () => {
    expect(extractInstanceIdFromAgentContainer(`agent-${instanceId}`)).toBe(instanceId);
    expect(extractInstanceIdFromAgentContainer(`agent-${instanceId}-web`)).toBeNull();
    expect(extractInstanceIdFromAgentContainer("hermes-caddy-1")).toBeNull();
  });

  it("reports a clean fleet when active instances are matched and volumes are named", () => {
    const instances: FleetInstanceRow[] = [
      {
        id: instanceId,
        name: "Aurelius",
        status: "running",
        ipv4_address: "203.0.113.11",
      },
    ];
    const hosts: FleetHostProbe[] = [
      {
        host: "host-f358efb1",
        ip: "203.0.113.11",
        status: "running",
        sshOk: true,
        agents: [
          {
            instanceId,
            containerName: `agent-${instanceId}`,
            containerStatus: "running",
            webStatus: "running",
            sessionsMounted: true,
            sessionsMountType: "volume",
            profilesMounted: true,
            profilesMountType: "volume",
            dbExists: true,
            sqliteIntegrity: "ok",
            blankAssistantUuidRows: 0,
          },
        ],
      },
    ];

    const report = buildFleetPersistenceReport({ hosts, instances, generatedAt: "2026-04-25T00:00:00.000Z" });

    expect(report.summary).toMatchObject({
      hosts: 1,
      sshOk: 1,
      agents: 1,
      activeInstances: 1,
      matchedActiveInstances: 1,
      sqliteOk: 1,
      findings: 0,
    });
    expect(formatFleetPersistenceMarkdownReport(report)).toContain("No fleet persistence findings.");
  });

  it("treats the shared webui state volume as valid sessions and profiles storage", () => {
    const instances: FleetInstanceRow[] = [
      {
        id: instanceId,
        name: "Aurelius",
        status: "running",
        ipv4_address: "203.0.113.11",
      },
    ];
    const hosts: FleetHostProbe[] = [
      {
        host: "host-f358efb1",
        ip: "203.0.113.11",
        status: "running",
        sshOk: true,
        agents: [
          {
            instanceId,
            containerName: `agent-${instanceId}`,
            containerStatus: "running",
            webStatus: "running",
            sessionsMounted: true,
            sessionsMountType: "volume",
            sessionsMountName: `agent-${instanceId}_webui-state`,
            profilesMounted: true,
            profilesMountType: "volume",
            profilesMountName: `agent-${instanceId}_webui-state`,
            dbExists: true,
            sqliteIntegrity: "ok",
            blankAssistantUuidRows: 0,
          },
        ],
      },
    ];

    const report = buildFleetPersistenceReport({ hosts, instances, generatedAt: "2026-04-25T00:00:00.000Z" });

    expect(report.findings).toHaveLength(0);
    expect(report.summary.sqliteOk).toBe(1);
  });

  it("flags the regression risks from the chat wipe incident", () => {
    const missingIpInstanceId = "00000000-0000-4000-8000-000000001030";
    const missingContainerId = "00000000-0000-4000-8000-000000001040";
    const instances: FleetInstanceRow[] = [
      {
        id: missingIpInstanceId,
        name: "Adam",
        status: "running",
        ipv4_address: null,
      },
      {
        id: missingContainerId,
        name: "Gojin",
        status: "running",
        ipv4_address: "192.0.2.151",
      },
    ];
    const hosts: FleetHostProbe[] = [
      {
        host: "host-3cbb3ca1",
        ip: "192.0.2.160",
        status: "running",
        sshOk: true,
        agents: [
          {
            instanceId: missingIpInstanceId,
            containerName: `agent-${missingIpInstanceId}`,
            containerStatus: "restarting",
            webStatus: "running",
            sessionsMounted: true,
            sessionsMountType: "bind",
            profilesMounted: false,
            profilesMountType: null,
            dbExists: true,
            sqliteIntegrity: "database disk image is malformed",
            blankAssistantUuidRows: 2,
          },
        ],
      },
    ];

    const report = buildFleetPersistenceReport({ hosts, instances, generatedAt: "2026-04-25T00:00:00.000Z" });
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining([
      "instance-missing-ip",
      "instance-container-missing",
      "container-unhealthy",
      "sessions-volume-missing",
      "profiles-volume-missing",
      "sqlite-integrity-failed",
      "blank-assistant-uuid-rows",
    ]));
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(formatFleetPersistenceMarkdownReport(report)).toContain("sessions-volume-missing");
  });

  it("does not require stopped instances to have live containers", () => {
    const report = buildFleetPersistenceReport({
      generatedAt: "2026-04-25T00:00:00.000Z",
      hosts: [],
      instances: [
        {
          id: "00000000-0000-4000-8000-000000001026",
          name: "ED",
          status: "stopped",
          ipv4_address: "192.0.2.150",
        },
      ],
    });

    expect(report.summary.activeInstances).toBe(0);
    expect(report.findings).toHaveLength(0);
  });
});
