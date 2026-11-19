/** @jest-environment jsdom */
import { buildVeniceLaunchHref, parseAgentParam, parseVeniceInference, withVeniceInference } from "../launch-link";
import {
  VENICE_ATTRIBUTION_COOKIE,
  attributionFromParams,
  captureVeniceAttribution,
  parseVeniceAttribution,
  readVeniceAttribution,
} from "../attribution";
import { createLaunchDraft } from "@/lib/launch/draft-store";

describe("launch link parsing", () => {
  it("parses inference", () => {
    expect(parseVeniceInference("venice")).toBe("venice");
    expect(parseVeniceInference("venice-key")).toBe("venice-key");
    expect(parseVeniceInference("openai")).toBeNull();
    expect(parseVeniceInference(null)).toBeNull();
  });

  it("parses agents and rejects unknown ones", () => {
    expect(parseAgentParam("hermes")).toBe("hermes");
    expect(parseAgentParam("agent-zero")).toBe("agent-zero");
    expect(parseAgentParam("nope")).toBeNull();
    expect(parseAgentParam("__proto__")).toBeNull();
  });

  it("builds the href", () => {
    expect(buildVeniceLaunchHref("openclaw")).toBe("/dashboard/launch?agent=openclaw&inference=venice&ref=venice");
  });

  it("preselects credits or a Venice key", () => {
    const base = { ...createLaunchDraft(), profileId: "hermes" as const };
    expect(withVeniceInference(base, "venice").modelAccess).toMatchObject({ mode: "credits", provider: "venice", source: "custom" });
    expect(withVeniceInference(base, "venice-key").modelAccess).toMatchObject({ mode: "api-key", provider: "venice", source: "custom" });
    expect(withVeniceInference(base, null)).toBe(base);
  });
});

describe("attribution", () => {
  beforeEach(() => {
    document.cookie = `${VENICE_ATTRIBUTION_COOKIE}=; Max-Age=0; Path=/`;
  });

  it("sanitises ref and code", () => {
    const params = new URLSearchParams({ ref: "venice", code: "bad code!" });
    expect(attributionFromParams(k => params.get(k))).toEqual({ ref: "venice", code: null });
    expect(parseVeniceAttribution("ref%3Dvenice%26code%3DVENICE")).toEqual({ ref: "venice", code: "VENICE" });
    expect(parseVeniceAttribution("%E0%A4%A")).toEqual({ ref: null, code: null });
  });

  it("stores in a cookie, keeps an earlier code, and ignores empty visits", () => {
    captureVeniceAttribution({ ref: null, code: null });
    expect(readVeniceAttribution()).toEqual({ ref: null, code: null });
    captureVeniceAttribution({ ref: "venice", code: "VENICE" });
    expect(readVeniceAttribution()).toEqual({ ref: "venice", code: "VENICE" });
    captureVeniceAttribution({ ref: "venice", code: null });
    expect(readVeniceAttribution()).toEqual({ ref: "venice", code: "VENICE" });
  });
});
