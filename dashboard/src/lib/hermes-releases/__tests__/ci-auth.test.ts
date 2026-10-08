import { CI_ALLOWED_IMAGE_REPOS, CI_IMMUTABLE_TAG, configuredCiToken, isAllowedCiImageRepo, requireCiToken } from "../ci-auth";

const TOKEN = "s".repeat(32);
const withHeader = (authorization?: string) =>
  new Request("http://localhost/x", { method: "POST", headers: authorization ? { authorization } : {} });

describe("requireCiToken", () => {
  it("accepts exactly the configured token", () => {
    expect(requireCiToken(withHeader(`Bearer ${TOKEN}`), { HERMES_RELEASE_CI_TOKEN: TOKEN })).toEqual({ ok: true, actor: "ci" });
    expect(requireCiToken(withHeader(`Bearer ${TOKEN}`), { HERMES_RELEASE_CI_TOKEN: `${TOKEN}\n` }).ok).toBe(true);
  });

  it("is 401 for a missing or wrong token and 503 when unset or too short", () => {
    const env = { HERMES_RELEASE_CI_TOKEN: TOKEN };
    expect(requireCiToken(withHeader(), env)).toMatchObject({ ok: false, status: 401 });
    expect(requireCiToken(withHeader(`Bearer ${"x".repeat(32)}`), env)).toMatchObject({ ok: false, status: 401 });
    expect(requireCiToken(withHeader(`Bearer ${TOKEN}`), {})).toMatchObject({ ok: false, status: 503 });
    expect(configuredCiToken({ HERMES_RELEASE_CI_TOKEN: "x".repeat(31) })).toBeNull();
  });
});

describe("CI allowlist and tag rules", () => {
  it("allows only the canary fork image, exactly", () => {
    expect(CI_ALLOWED_IMAGE_REPOS).toEqual(["ghcr.io/ashneil12/vanilla-hermes-agent-canary"]);
    expect(isAllowedCiImageRepo("GHCR.io/ashneil12/vanilla-hermes-agent-canary")).toBe(true);
    expect(isAllowedCiImageRepo("ghcr.io/ashneil12/vanilla-hermes-agent")).toBe(false);
    expect(isAllowedCiImageRepo("ghcr.io/ashneil12/vanilla-hermes-agent-canary:stable")).toBe(false);
  });

  it("accepts <upstream tag>-<sha7> and rejects floating tags", () => {
    expect(CI_IMMUTABLE_TAG.test("v2026.9.24-ab12cd3")).toBe(true);
    for (const tag of ["stable", "latest", "main", "v2026.9.24", "v2026.9.24-AB12CD3", "-ab12cd3"]) {
      expect(CI_IMMUTABLE_TAG.test(tag)).toBe(false);
    }
  });
});
