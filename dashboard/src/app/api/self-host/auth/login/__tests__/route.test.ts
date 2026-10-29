import { hashLocalOperatorPassword } from "@/lib/self-host/password";

const OPERATOR_PASSWORD = "correct horse battery staple";
const OPERATOR_EMAIL = "operator@example.com";

let clock = 1_700_000_000_000;
let POST: (request: Request) => Promise<Response>;

// Each attempt claims a different address in X-Forwarded-For, the way a client
// behind a non-normalising proxy can. The budget must not depend on that header.
function attempt(password: string, claimedAddress: string, email = OPERATOR_EMAIL) {
  return POST(
    new Request("http://localhost:3000/api/self-host/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": claimedAddress },
      body: JSON.stringify({ email, password }),
    }),
  );
}

function freshAddress(n: number) {
  return `198.51.100.${(n % 250) + 1}`;
}

describe("POST /api/self-host/auth/login", () => {
  beforeAll(async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    process.env.HIVRA_LOCAL_JWT_SECRET = "hivra-login-test-secret-that-is-long-enough-32";
    process.env.HIVRA_OPERATOR_EMAIL = OPERATOR_EMAIL;
    process.env.HIVRA_OPERATOR_PASSWORD_HASH = await hashLocalOperatorPassword(OPERATOR_PASSWORD);
  });

  beforeEach(async () => {
    // The limiter keeps its state in module scope, so each test starts from a fresh module.
    jest.resetModules();
    POST = (await import("../route")).POST;
    clock += 3 * 60 * 60 * 1000;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stops guessing the operator password after ten failed sign-ins, whatever address each one claims", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await attempt("wrong guess", freshAddress(i))).status).toBe(401);
    }

    const eleventh = await attempt("wrong guess", "203.0.113.250");
    expect(eleventh.status).toBe(429);
    // The correct password is refused during the lockout too, so a guesser gains nothing from waiting.
    expect((await attempt(OPERATOR_PASSWORD, "203.0.113.251")).status).toBe(429);
  });

  it("still signs the operator in with the correct password while the budget has room", async () => {
    for (let i = 0; i < 9; i++) {
      expect((await attempt("wrong guess", freshAddress(i))).status).toBe(401);
    }

    const signedIn = await attempt(OPERATOR_PASSWORD, freshAddress(20));
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain("hivra_operator_session=");
  });

  it("a successful sign-in clears the budget, so earlier misses do not count against the next ones", async () => {
    for (let i = 0; i < 9; i++) {
      await attempt("wrong guess", freshAddress(i));
    }
    expect((await attempt(OPERATOR_PASSWORD, freshAddress(20))).status).toBe(200);

    for (let i = 0; i < 9; i++) {
      expect((await attempt("wrong guess", freshAddress(30 + i))).status).toBe(401);
    }
  });

  it("doubles the lockout after each repeat, so the next lockout is longer than the first", async () => {
    for (let i = 0; i < 10; i++) {
      await attempt("wrong guess", freshAddress(i));
    }
    // First lockout: fifteen minutes.
    clock += 15 * 60 * 1000 + 1;
    expect((await attempt("wrong guess", freshAddress(40))).status).toBe(401);
    for (let i = 0; i < 9; i++) {
      await attempt("wrong guess", freshAddress(50 + i));
    }
    expect((await attempt("wrong guess", freshAddress(70))).status).toBe(429);

    // Second lockout: thirty minutes, so fifteen minutes later it still holds.
    clock += 15 * 60 * 1000 + 1;
    expect((await attempt(OPERATOR_PASSWORD, freshAddress(71))).status).toBe(429);

    clock += 15 * 60 * 1000;
    expect((await attempt(OPERATOR_PASSWORD, freshAddress(72))).status).toBe(200);
  });
});
