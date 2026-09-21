import { orderLiveModelsByStaticPreference } from "@/lib/hooks/usePreferredProviderModels";

describe("orderLiveModelsByStaticPreference", () => {
  it("keeps curated Venice defaults ahead of the live catalog order", () => {
    const ordered = orderLiveModelsByStaticPreference(
      [
        { value: "zai-org-glm-5-1", label: "GLM 5.1" },
        { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
        { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        { value: "new-live-model", label: "New Live Model" },
      ],
      [
        { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash (via Venice · best balance)" },
        { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro (via Venice)" },
        { value: "zai-org-glm-5-1", label: "GLM 5.1 (via Venice)" },
      ]
    );

    expect(ordered.map((model) => model.value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "zai-org-glm-5-1",
      "new-live-model",
    ]);
    expect(ordered[0]?.label).toContain("best balance");
  });
});
