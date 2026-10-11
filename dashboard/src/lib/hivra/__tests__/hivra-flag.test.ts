/** @jest-environment jsdom */

import { isHivraEnabled } from "../hivra-flag";

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
  delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
});

describe("isHivraEnabled", () => {
  it("is off in production by hostname", () => {
    setLocation("hivra.cloud");
    expect(isHivraEnabled()).toBe(false);
  });

  it("is on for the Canary deployment and its preview alias", () => {
    setLocation("canary.hermesos.cloud");
    expect(isHivraEnabled()).toBe(true);
    setLocation("canary.hivra.cloud");
    expect(isHivraEnabled()).toBe(true);
    setLocation("hermesos-canary-abc123.vercel.app");
    expect(isHivraEnabled()).toBe(true);
  });

  it("honours the build-env opt-in, which production sets", () => {
    process.env.NEXT_PUBLIC_HIVRA_AGENTS = "1";
    setLocation("hivra.cloud");
    expect(isHivraEnabled()).toBe(true);
  });

  it("honours the ?hivra=1 escape hatch on a preview deployment", () => {
    setLocation("hermesos-git-main-ashneil12s-projects.vercel.app", "?hivra=1");
    expect(isHivraEnabled()).toBe(true);
  });
});
