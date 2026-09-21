import { GET } from "../route";

// The shared-template GET is a PUBLIC read: the unguessable 48-hex share_token
// is the access capability, so a logged-out recipient of a share link must be
// able to view the template. These tests pin that behaviour (no Clerk session
// required) and that only stripped, non-private shared-template data comes back.

const mockGetPublicTemplateByShareToken = jest.fn();
let mockHivraAllowed = true;

jest.mock("@/lib/hivra/hivra-flag", () => ({
  isHivraApiAllowed: () => mockHivraAllowed,
}));

jest.mock("@/lib/hivra/agent-templates", () => ({
  getPublicTemplateByShareToken: (...args: unknown[]) => mockGetPublicTemplateByShareToken(...args),
}));

const VALID_TOKEN = "a".repeat(48); // shape of a real 48-hex share token

function makeRequest() {
  return new Request(`https://hivra.cloud/api/hivra/templates/shared/${VALID_TOKEN}`, {
    method: "GET",
    headers: { Host: "hivra.cloud" }, // no Authorization / Clerk cookie: logged-out viewer
  });
}

function makeParams(token: string) {
  return { params: Promise.resolve({ token }) };
}

describe("GET /api/hivra/templates/shared/[token]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHivraAllowed = true;
  });

  it("returns the shared template to an UNAUTHENTICATED viewer (token is the capability)", async () => {
    // The public helper has already stripped `context` (null) and made llm_config
    // key-free; it carries no owner_user_id / PII.
    const sharedTemplate = {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "forked-builder-abcd",
      type: "codex",
      name: "Forked Builder",
      goal: "build things",
      context: null,
      personality: "direct",
      emoji: "🔨",
      llm_config: { provider: "venice" },
      skills: ["web-search"],
      visibility: "public",
    };
    mockGetPublicTemplateByShareToken.mockResolvedValue(sharedTemplate);

    const response = await GET(makeRequest() as never, makeParams(VALID_TOKEN));

    // Public read succeeds with NO session — never a 401.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.template).toEqual(sharedTemplate);

    // Looked up strictly BY the share token (capability), nothing else.
    expect(mockGetPublicTemplateByShareToken).toHaveBeenCalledWith(VALID_TOKEN);

    // Defense check: no private/owner data is present in the response payload.
    expect(body.data.template.context).toBeNull();
    expect(body.data.template).not.toHaveProperty("owner_user_id");
    expect(body.data.template).not.toHaveProperty("share_token");
    expect(JSON.stringify(body)).not.toContain("llm_api_key");
  });

  it("404s an unknown/revoked/private token (helper returns null)", async () => {
    mockGetPublicTemplateByShareToken.mockResolvedValue(null);

    const response = await GET(makeRequest() as never, makeParams(VALID_TOKEN));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not found/i);
  });

  it("404s when the Hivra surface is not allowed on this host (canary-only gate)", async () => {
    mockHivraAllowed = false;

    const response = await GET(makeRequest() as never, makeParams(VALID_TOKEN));

    expect(response.status).toBe(404);
    // Gate short-circuits before any template lookup.
    expect(mockGetPublicTemplateByShareToken).not.toHaveBeenCalled();
  });
});
