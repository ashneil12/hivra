import {
  isWebfreeBackend,
  resolveWebfreeGatewayService,
} from "@/lib/types/instance";

describe("isWebfreeBackend", () => {
  it("treats both webui and gateway as webfree", () => {
    expect(isWebfreeBackend("webui")).toBe(true);
    expect(isWebfreeBackend("gateway")).toBe(true);
  });

  it("treats null/legacy backends as non-webfree", () => {
    expect(isWebfreeBackend(null)).toBe(false);
    expect(isWebfreeBackend(undefined)).toBe(false);
    expect(isWebfreeBackend("legacy")).toBe(false);
  });
});

describe("resolveWebfreeGatewayService", () => {
  it("restarts the `gateway` compose service for the webfree gateway backend", () => {
    expect(resolveWebfreeGatewayService("gateway")).toBe("gateway");
  });

  it("restarts the `webui` compose service for the legacy webui backend", () => {
    expect(resolveWebfreeGatewayService("webui")).toBe("webui");
  });

  it("defaults to the `gateway` service for any non-webui value", () => {
    // Phase-2 default is gateway; never mistarget the absent `webui` service.
    expect(resolveWebfreeGatewayService(null)).toBe("gateway");
    expect(resolveWebfreeGatewayService(undefined)).toBe("gateway");
    expect(resolveWebfreeGatewayService("something-new")).toBe("gateway");
  });
});
