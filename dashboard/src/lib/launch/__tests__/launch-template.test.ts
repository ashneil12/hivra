import { launchProfileForTemplate, loadLaunchTemplate, safeTemplateRef } from "../launch-template";

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("launch templates", () => {
  it("accepts only plain template references", () => {
    expect(safeTemplateRef(TEMPLATE_ID)).toBe(TEMPLATE_ID);
    expect(safeTemplateRef("research-bot_2")).toBe("research-bot_2");
    for (const bad of ["", "../x", "a b", "x?y=1", "%2e", "-leading", "a".repeat(129), null, 7]) {
      expect(safeTemplateRef(bad)).toBeNull();
    }
  });

  it("starts only the Hivra agents a template can be saved from", () => {
    expect(launchProfileForTemplate("claude-code")).toBe("claude-code");
    expect(launchProfileForTemplate("agent-zero")).toBe("agent-zero");
    expect(launchProfileForTemplate("general")).toBeNull();
    expect(launchProfileForTemplate("linux-terminal")).toBeNull();
  });

  it("finds the owner's template by id or slug", async () => {
    const fetcher = jest.fn(async () => json({ success: true, data: { templates: [
      { id: TEMPLATE_ID, slug: "research-bot", name: " Research Bot ", type: "codex" },
    ] } })) as unknown as typeof fetch;

    await expect(loadLaunchTemplate("research-bot", null, fetcher)).resolves.toEqual({
      status: "found", template: { id: TEMPLATE_ID, name: "Research Bot", profileId: "codex" },
    });
    expect(fetcher).toHaveBeenCalledWith("/api/hivra/templates", expect.objectContaining({ cache: "no-store" }));
  });

  it("reads a shared template through its token, and only the one the link names", async () => {
    const shared = jest.fn(async () => json({ success: true, data: { template: { id: TEMPLATE_ID, slug: "ops", name: "Ops", type: "openclaw" } } })) as unknown as typeof fetch;
    await expect(loadLaunchTemplate(TEMPLATE_ID, "tok_1", shared)).resolves.toMatchObject({ status: "found", template: { profileId: "openclaw" } });
    expect(shared).toHaveBeenCalledWith("/api/hivra/templates/shared/tok_1", expect.anything());

    await expect(loadLaunchTemplate("22222222-2222-4222-8222-222222222222", "tok_1", shared)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("tells a missing or unlaunchable template apart from a lookup that failed", async () => {
    const empty = jest.fn(async () => json({ success: true, data: { templates: [] } })) as unknown as typeof fetch;
    await expect(loadLaunchTemplate(TEMPLATE_ID, null, empty)).resolves.toMatchObject({ status: "unavailable" });

    const hermes = jest.fn(async () => json({ success: true, data: { templates: [{ id: TEMPLATE_ID, type: "general" }] } })) as unknown as typeof fetch;
    await expect(loadLaunchTemplate(TEMPLATE_ID, null, hermes)).resolves.toMatchObject({
      status: "unavailable", message: expect.stringMatching(/can't be launched from a template yet/),
    });

    const gone = jest.fn(async () => json({ success: false }, 404)) as unknown as typeof fetch;
    await expect(loadLaunchTemplate(TEMPLATE_ID, "tok_1", gone)).resolves.toMatchObject({ status: "unavailable" });

    const down = jest.fn(async () => json({ success: false }, 503)) as unknown as typeof fetch;
    await expect(loadLaunchTemplate(TEMPLATE_ID, null, down)).resolves.toMatchObject({ status: "failed" });
    const offline = jest.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(loadLaunchTemplate(TEMPLATE_ID, null, offline)).resolves.toMatchObject({ status: "failed" });
  });
});
