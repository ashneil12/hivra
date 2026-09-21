import { resolveColdStorageAuditHost } from "../audit-config";

describe("cold-storage audit host selection", () => {
  it("uses the explicitly configured active PVE host", () => {
    expect(resolveColdStorageAuditHost({ COLD_STORAGE_AUDIT_HOST: "  fixturenode19  " })).toBe(
      "fixturenode19"
    );
  });

  it("fails closed when no audit host is configured instead of falling back to retired fixturenode1", () => {
    expect(resolveColdStorageAuditHost({})).toBeNull();
  });
});
