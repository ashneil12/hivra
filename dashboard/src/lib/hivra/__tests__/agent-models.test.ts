import { BOX_MODEL_OPTIONS, effortLabel, isEffortLevel, modelLabelFor, parseChatEffort } from "@/lib/hivra/agent-models";

describe("agent-models", () => {
  it("offers the default first for each CLI, then its models", () => {
    expect(BOX_MODEL_OPTIONS.claude[0]).toEqual({ value: "", label: "Default" });
    expect(BOX_MODEL_OPTIONS.codex[0]).toEqual({ value: "", label: "Default" });
    expect(BOX_MODEL_OPTIONS.claude.map((o) => o.value)).toContain("opus");
  });

  it("takes only the effort levels it knows, once each, in its own order", () => {
    expect(parseChatEffort(["high", "low", "high", "turbo", 3, null, "medium"])).toEqual(["low", "medium", "high"]);
    expect(parseChatEffort(["max", "xhigh"])).toEqual(["xhigh", "max"]);
  });

  it("treats a missing or malformed chatEffort as a computer that takes no effort", () => {
    expect(parseChatEffort(undefined)).toEqual([]);
    expect(parseChatEffort("high")).toEqual([]);
    expect(parseChatEffort({ 0: "high" })).toEqual([]);
    expect(parseChatEffort([])).toEqual([]);
  });

  it("words the levels and recognizes them", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("max")).toBe("Max");
    expect(effortLabel("custom")).toBe("custom");
    expect(isEffortLevel("low")).toBe(true);
    expect(isEffortLevel("turbo")).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
  });

  it("names a model from its CLI's list, or by its own id when it is a custom one", () => {
    expect(modelLabelFor("claude", "opus")).toBe("Opus");
    expect(modelLabelFor("codex", "gpt-5.1-codex-max")).toBe("Codex Max");
    expect(modelLabelFor("claude", " my-model ")).toBe("my-model");
    expect(modelLabelFor("claude", null)).toBe("Default");
  });
});
