import { createLocalSessionToken } from "@/lib/self-host/session-token";

const secret = "correct-hivra-test-secret-that-is-at-least-32-characters";

jest.mock("@/lib/self-host/config", () => ({
  ...jest.requireActual("@/lib/self-host/config"),
  requireLocalAuthMode: jest.fn(),
  requireLocalJwtSecret: () => "correct-hivra-test-secret-that-is-at-least-32-characters",
}));
jest.mock("@/lib/self-host/local-user", () => ({
  createLocalOperatorUser: () => ({ id: "hivra-local-operator", firstName: "Operator" }),
}));
jest.mock("@/lib/self-host/operator-store", () => ({
  loadLocalOperatorState: async () => ({ publicMetadata: {} }),
}));

import { GET } from "../route";

describe("GET /api/self-host/auth/session", () => {
  it("returns the signed-in user without echoing the httpOnly session token", async () => {
    const token = await createLocalSessionToken({
      email: "operator@example.com",
      name: "Operator",
      secret,
    });

    const response = await GET(
      new Request("http://localhost:3000/api/self-host/auth/session", {
        headers: { cookie: `hivra_operator_session=${token}` },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ authenticated: true, user: { id: "hivra-local-operator" } });
    expect(body).not.toHaveProperty("accessToken");
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("answers 401 without a valid session cookie", async () => {
    const response = await GET(new Request("http://localhost:3000/api/self-host/auth/session"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
  });
});
