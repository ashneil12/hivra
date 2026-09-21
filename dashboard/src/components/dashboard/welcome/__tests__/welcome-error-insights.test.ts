import {
  buildWelcomeErrorInsight,
  categorizeWelcomeError,
  sanitizeWelcomeErrorMessage,
  shouldRenderWelcomeErrorDetail,
  welcomeValidationInsight,
  WELCOME_CAPACITY_HEADLINE,
  WELCOME_NETWORK_HEADLINE,
} from "../welcome-error-insights";

describe("sanitizeWelcomeErrorMessage", () => {
  it("extracts the message from Error instances and collapses whitespace", () => {
    expect(sanitizeWelcomeErrorMessage(new Error("Deployment\n   failed:  capacity"))).toBe(
      "Deployment failed: capacity",
    );
  });

  it("redacts key-like tokens so credentials never reach analytics", () => {
    expect(sanitizeWelcomeErrorMessage("rejected key sk-or-v1-abcdef1234567890")).toBe(
      "rejected key [redacted]",
    );
    expect(
      sanitizeWelcomeErrorMessage(
        `token ${"a".repeat(48)} rejected`,
      ),
    ).toBe("token [redacted] rejected");
  });

  it("keeps the sk-or- prefix guidance intact (no false redaction)", () => {
    expect(sanitizeWelcomeErrorMessage("OpenRouter API keys must start with sk-or-.")).toBe(
      "OpenRouter API keys must start with sk-or-.",
    );
  });

  it("caps very long messages and handles non-string input", () => {
    expect(sanitizeWelcomeErrorMessage("x ".repeat(400)).length).toBeLessThanOrEqual(240);
    expect(sanitizeWelcomeErrorMessage(null)).toBe("");
    expect(sanitizeWelcomeErrorMessage(undefined)).toBe("");
    expect(sanitizeWelcomeErrorMessage(42)).toBe("42");
  });
});

describe("categorizeWelcomeError", () => {
  it("classifies the known capacity shapes", () => {
    expect(
      categorizeWelcomeError("Deployment failed: No free Proxmox VMID in range 1300-1349"),
    ).toBe("capacity");
    expect(
      categorizeWelcomeError(
        "Temporary Proxmox capacity reached. New agents are paused until more capacity is available.",
      ),
    ).toBe("capacity");
  });

  it("classifies plan-limit shapes", () => {
    expect(categorizeWelcomeError("Your Free plan allows 1 active agent.")).toBe("plan_limit");
    expect(categorizeWelcomeError("Your Pro pool only has 0.5 CPU / 1 GB free.")).toBe(
      "plan_limit",
    );
    expect(categorizeWelcomeError("Browser automation requires a paid plan.")).toBe("plan_limit");
    expect(categorizeWelcomeError("Quota exceeded")).toBe("plan_limit");
    // FreeInstanceLimitError message (one-base-agent guard) — previously fell
    // through to 'unknown' and rendered without the plan CTAs.
    expect(
      categorizeWelcomeError(
        "You already have one active base-tier agent. Upgrade to deploy more.",
      ),
    ).toBe("plan_limit");
  });

  it("classifies validation shapes", () => {
    expect(
      categorizeWelcomeError(
        "Provider API key is required. Provide it manually or select a Vault key that contains an encrypted credential.",
      ),
    ).toBe("validation");
    expect(categorizeWelcomeError("OpenRouter API keys must start with sk-or-.")).toBe(
      "validation",
    );
  });

  it("classifies network shapes", () => {
    expect(categorizeWelcomeError("Failed to fetch")).toBe("network");
    expect(categorizeWelcomeError("The request timed out")).toBe("network");
    expect(categorizeWelcomeError("Provision kickoff failed")).toBe("network");
  });

  it("falls back to unknown", () => {
    expect(categorizeWelcomeError("")).toBe("unknown");
    expect(categorizeWelcomeError("Something exploded")).toBe("unknown");
  });
});

describe("buildWelcomeErrorInsight", () => {
  it("maps capacity errors to a humane retry headline and keeps the raw detail", () => {
    const insight = buildWelcomeErrorInsight(
      new Error("Deployment failed: No free Proxmox VMID in range 1300-1349"),
      "Deployment failed. Please try again.",
    );
    expect(insight.category).toBe("capacity");
    expect(insight.headline).toBe(WELCOME_CAPACITY_HEADLINE);
    expect(insight.detail).toContain("No free Proxmox VMID in range 1300-1349");
    expect(insight.retryable).toBe(true);
    expect(insight.showPlanActions).toBe(false);
  });

  it("keeps plan-limit messages as the headline and flags the plan CTAs", () => {
    const insight = buildWelcomeErrorInsight(
      new Error("Your Free plan allows 1 active agent."),
      "Launch failed",
    );
    expect(insight.category).toBe("plan_limit");
    expect(insight.headline).toBe("Your Free plan allows 1 active agent.");
    expect(insight.detail).toBeNull();
    expect(insight.showPlanActions).toBe(true);
    expect(insight.retryable).toBe(false);
  });

  it("maps network errors to retry guidance with the raw detail attached", () => {
    const insight = buildWelcomeErrorInsight(new TypeError("Failed to fetch"), "Deployment failed");
    expect(insight.category).toBe("network");
    expect(insight.headline).toBe(WELCOME_NETWORK_HEADLINE);
    expect(insight.detail).toBe("Failed to fetch");
    expect(insight.retryable).toBe(true);
  });

  it("passes unknown errors through verbatim and uses the fallback for empty input", () => {
    const unknown = buildWelcomeErrorInsight(new Error("Something exploded"), "Deployment failed");
    expect(unknown.category).toBe("unknown");
    expect(unknown.headline).toBe("Something exploded");
    expect(unknown.detail).toBeNull();

    const fallback = buildWelcomeErrorInsight(new Error(""), "Deployment failed. Please try again.");
    expect(fallback.headline).toBe("Deployment failed. Please try again.");
  });
});

describe("shouldRenderWelcomeErrorDetail", () => {
  const capacityInsight = buildWelcomeErrorInsight(
    "No free Proxmox VMID in range 1300-1349",
    "Deployment failed",
  );

  it("hides managed placement internals but keeps them actionable for a self-managed owner", () => {
    expect(shouldRenderWelcomeErrorDetail(capacityInsight, "managed")).toBe(false);
    expect(shouldRenderWelcomeErrorDetail(capacityInsight, "self-managed")).toBe(true);
  });

  it("keeps ordinary sanitized network detail in managed mode", () => {
    const networkInsight = buildWelcomeErrorInsight("Failed to fetch", "Deployment failed");
    expect(shouldRenderWelcomeErrorDetail(networkInsight, "managed")).toBe(true);
  });
});

describe("welcomeValidationInsight", () => {
  it("wraps an inline validation message", () => {
    expect(welcomeValidationInsight("Name is required.")).toEqual({
      category: "validation",
      headline: "Name is required.",
      detail: null,
      showPlanActions: false,
      retryable: false,
    });
  });
});
