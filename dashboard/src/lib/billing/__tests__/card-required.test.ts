import { getApiErrorMessage } from "../card-required";

describe("api error message helper", () => {
  it("uses the API error message when one is present", () => {
    expect(getApiErrorMessage({ success: false, error: "Choose a plan." }, "Deployment failed")).toBe("Choose a plan.");
  });

  it("falls back to safe default copy for malformed responses", () => {
    expect(getApiErrorMessage({ error: "   " }, "Deployment failed")).toBe("Deployment failed");
    expect(getApiErrorMessage(null, "Deployment failed")).toBe("Deployment failed");
  });
});
