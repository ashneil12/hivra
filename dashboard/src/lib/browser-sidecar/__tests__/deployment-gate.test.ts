import {
  isBrowserSidecarDeploymentGateEnabled,
  instanceCanFitBrowserSidecar,
  BROWSER_SIDECAR_MIN_RAM_MB,
  BROWSER_SIDECAR_DEPLOY_ENABLED_ENV,
} from "@/lib/browser-sidecar/deployment-gate";

describe("browser-sidecar deployment gate", () => {
  it("is off by default and on only for truthy env values", () => {
    expect(isBrowserSidecarDeploymentGateEnabled({})).toBe(false);
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      expect(
        isBrowserSidecarDeploymentGateEnabled({
          [BROWSER_SIDECAR_DEPLOY_ENABLED_ENV]: v,
        })
      ).toBe(true);
    }
    for (const v of ["0", "false", "", "off"]) {
      expect(
        isBrowserSidecarDeploymentGateEnabled({
          [BROWSER_SIDECAR_DEPLOY_ENABLED_ENV]: v,
        })
      ).toBe(false);
    }
  });
});

describe("instanceCanFitBrowserSidecar (RAM floor)", () => {
  it("rejects boxes below the floor so we never OOM an undersized VM", () => {
    expect(instanceCanFitBrowserSidecar(1024)).toBe(false); // free/credit/token base
    expect(instanceCanFitBrowserSidecar(2048)).toBe(false); // 2 GB still too small
    expect(instanceCanFitBrowserSidecar(BROWSER_SIDECAR_MIN_RAM_MB - 1)).toBe(false);
  });

  it("admits every Pro tier (operator 4096 / fleet 8192 / command 16384)", () => {
    expect(instanceCanFitBrowserSidecar(BROWSER_SIDECAR_MIN_RAM_MB)).toBe(true);
    expect(instanceCanFitBrowserSidecar(4096)).toBe(true);
    expect(instanceCanFitBrowserSidecar(8192)).toBe(true);
    expect(instanceCanFitBrowserSidecar(16384)).toBe(true);
  });

  it("allows unknown (null/undefined) budgets — entrypoint re-checks actual RAM", () => {
    expect(instanceCanFitBrowserSidecar(null)).toBe(true);
    expect(instanceCanFitBrowserSidecar(undefined)).toBe(true);
  });

  it("excludes a known-bad numeric budget (NaN)", () => {
    expect(instanceCanFitBrowserSidecar(Number.NaN)).toBe(false);
  });
});
