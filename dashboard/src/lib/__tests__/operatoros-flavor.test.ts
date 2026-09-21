import {
  isOperatorosAgentImage,
  isOperatorosFlavorConfig,
  OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH,
  OPERATOROS_AUTONOMY_SOUL_HEAD,
  readStoredWebuiAgentImage,
  resolveAgentImageForStoredConfig,
} from "../operatoros-flavor";

describe("operatoros-flavor", () => {
  describe("isOperatorosAgentImage", () => {
    it("matches any tag/registry carrying the marker so image overrides keep working", () => {
      expect(isOperatorosAgentImage("ghcr.io/ashneil12/operatoros-agent:stable")).toBe(true);
      expect(isOperatorosAgentImage("ghcr.io/ashneil12/operatoros-agent:canary-abc123")).toBe(true);
      expect(isOperatorosAgentImage("registry.internal/mirror/operatoros-agent@sha256:dead")).toBe(
        true
      );
    });

    it("does not match the vanilla runtime or non-strings", () => {
      expect(isOperatorosAgentImage("ghcr.io/ashneil12/vanilla-hermes-agent:latest")).toBe(false);
      expect(isOperatorosAgentImage(undefined)).toBe(false);
      expect(isOperatorosAgentImage(null)).toBe(false);
      expect(isOperatorosAgentImage(123)).toBe(false);
    });
  });

  describe("readStoredWebuiAgentImage", () => {
    it("ignores blank/non-string stored values", () => {
      expect(readStoredWebuiAgentImage({ webuiAgentImage: "img:tag" })).toBe("img:tag");
      expect(readStoredWebuiAgentImage({ webuiAgentImage: "   " })).toBeUndefined();
      expect(readStoredWebuiAgentImage({ webuiAgentImage: 42 })).toBeUndefined();
      expect(readStoredWebuiAgentImage({})).toBeUndefined();
      expect(readStoredWebuiAgentImage(undefined)).toBeUndefined();
    });
  });

  describe("isOperatorosFlavorConfig", () => {
    it("recognizes the flavor from either the persisted flavor or the stored image", () => {
      expect(isOperatorosFlavorConfig({ agentFlavor: "operatoros" })).toBe(true);
      expect(
        isOperatorosFlavorConfig({ webuiAgentImage: "ghcr.io/ashneil12/operatoros-agent:stable" })
      ).toBe(true);
      expect(
        isOperatorosFlavorConfig({
          agentFlavor: "operatoros",
          webuiAgentImage: "ghcr.io/ashneil12/operatoros-agent:stable",
        })
      ).toBe(true);
    });

    it("does not over-fire on vanilla rows", () => {
      expect(isOperatorosFlavorConfig({})).toBe(false);
      expect(isOperatorosFlavorConfig(undefined)).toBe(false);
      expect(isOperatorosFlavorConfig({ agentFlavor: "vanilla" })).toBe(false);
      expect(
        isOperatorosFlavorConfig({ webuiAgentImage: "ghcr.io/ashneil12/vanilla-hermes-agent:latest" })
      ).toBe(false);
    });
  });

  describe("resolveAgentImageForStoredConfig", () => {
    it("prefers the stored image verbatim", () => {
      expect(
        resolveAgentImageForStoredConfig({
          agentFlavor: "operatoros",
          webuiAgentImage: "ghcr.io/ashneil12/operatoros-agent:pinned",
        })
      ).toBe("ghcr.io/ashneil12/operatoros-agent:pinned");
    });

    it("fails closed for a flavor-only row without a pinned image", () => {
      expect(() => resolveAgentImageForStoredConfig({ agentFlavor: "operatoros" }))
        .toThrow("missing its pinned runtime image");
    });

    it("returns undefined for vanilla rows so env-default resolution is unchanged", () => {
      expect(resolveAgentImageForStoredConfig({})).toBeUndefined();
      expect(resolveAgentImageForStoredConfig({ agentFlavor: "vanilla" })).toBeUndefined();
    });
  });

  it("pins the in-image autonomy SOUL path + head marker the seeder and DoD check depend on", () => {
    // Both are contracts with the agent image (profiles/operatoros/ in
    // vanilla-hermes-agent-operatoros) and with the image's own cont-init
    // enforcer, which greps this same head string. Changing either here
    // without rebuilding the image silently stops the autonomy seed.
    expect(OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH).toBe(
      "/opt/hermes/profiles/operatoros/SOUL.autonomy.md"
    );
    expect(OPERATOROS_AUTONOMY_SOUL_HEAD).toBe("Operator OS — Autonomy Build");
  });
});
