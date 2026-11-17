import { VENICE_API_KEYS_URL, veniceSetupCallLink } from "../onboarding";
import { SUPPORT_EMAIL } from "@/lib/support-channels";

const FLAG = "NEXT_PUBLIC_HIVRA_SETUP_CALL_URL";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe("Venice onboarding links", () => {
  it("points key creation at Venice's API settings", () => {
    expect(VENICE_API_KEYS_URL).toBe("https://venice.ai/settings/api");
  });

  it("books a setup call by email when no booking page is set", () => {
    delete process.env[FLAG];
    const link = veniceSetupCallLink("Hermes");
    expect(link.external).toBe(false);
    expect(link.href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    const params = new URLSearchParams(link.href.split("?")[1]);
    expect(params.get("subject")).toMatch(/Setup call/);
    expect(params.get("body")).toContain("Hermes running on Venice");
  });

  it("uses the booking page when one is set, and ignores anything that isn't https", () => {
    process.env[FLAG] = "https://example.com/book";
    expect(veniceSetupCallLink()).toEqual({ href: "https://example.com/book", external: true });
    process.env[FLAG] = "javascript:alert(1)";
    expect(veniceSetupCallLink().external).toBe(false);
  });
});
