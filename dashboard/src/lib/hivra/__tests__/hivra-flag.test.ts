/** @jest-environment jsdom */

import { isHivraEnabled, preparedCanarySurfaceAvailable } from "../hivra-flag";

const originalLocation = window.location;

function setLocation(hostname: string, search = "") {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      hostname,
      search,
      origin: `https://${hostname}`,
      href: `https://${hostname}/${search}`,
    },
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  delete process.env.NEXT_PUBLIC_HIVRA_PREPARED_CANARY;
  delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
});

describe("preparedCanarySurfaceAvailable", () => {
  it("is off in production, which has no prepared-computer slot", () => {
    setLocation("hivra.cloud");
    expect(preparedCanarySurfaceAvailable()).toBe(false);
  });

  it("is on for the Canary deployment", () => {
    setLocation("canary.hermesos.cloud");
    expect(preparedCanarySurfaceAvailable()).toBe(true);
    setLocation("canary.hivra.cloud");
    expect(preparedCanarySurfaceAvailable()).toBe(true);
  });

  it("is not keyed on the Hivra surfaces flag, which production turns on", () => {
    process.env.NEXT_PUBLIC_HIVRA_AGENTS = "1";
    setLocation("hivra.cloud");

    expect(isHivraEnabled()).toBe(true);
    expect(preparedCanarySurfaceAvailable()).toBe(false);
  });

  it("honours the explicit build-env opt-in and the preview escape hatch", () => {
    setLocation("hivra.cloud");
    process.env.NEXT_PUBLIC_HIVRA_PREPARED_CANARY = "1";
    expect(preparedCanarySurfaceAvailable()).toBe(true);

    delete process.env.NEXT_PUBLIC_HIVRA_PREPARED_CANARY;
    setLocation("hermesos-abc123.vercel.app", "?prepared=1");
    expect(preparedCanarySurfaceAvailable()).toBe(true);
  });

  it("stays off on a preview alias that is not the Canary project", () => {
    setLocation("hermesos-git-main-ashneil12s-projects.vercel.app");
    expect(preparedCanarySurfaceAvailable()).toBe(false);
  });
});
