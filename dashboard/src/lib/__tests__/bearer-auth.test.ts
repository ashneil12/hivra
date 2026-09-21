import { verifyBearerHeader } from "@/lib/bearer-auth";
import { makeRequest } from "@/test-utils/request";

function makeReq(authorization?: string) {
  return makeRequest("http://localhost/x", authorization ? { headers: { authorization } } : {});
}

describe("verifyBearerHeader", () => {
  it.each([
    ["accepts the exact bearer", "Bearer s3cr3t", "s3cr3t", true],
    ["rejects a wrong bearer", "Bearer nope", "s3cr3t", false],
    ["rejects when scheme is missing", "s3cr3t", "s3cr3t", false],
    ["rejects when scheme is wrong", "Basic s3cr3t", "s3cr3t", false],
    ["rejects when no header is present", undefined, "s3cr3t", false],
    ["rejects when expected secret is empty", "Bearer ", "", false],
    ["rejects when expected secret is null", "Bearer s3cr3t", null, false],
    ["rejects when expected secret is undefined", "Bearer s3cr3t", undefined, false],
    ["rejects a header that is a prefix of the expected value", "Bearer s3cr3", "s3cr3t", false],
    ["rejects a header that has extra trailing data", "Bearer s3cr3tx", "s3cr3t", false],
    ["trims wrapping whitespace from the header", "  Bearer s3cr3t  ", "s3cr3t", true],
    ["rejects when the header has an empty payload", "Bearer ", "s3cr3t", false],
  ] as const)("%s", (_label, header, expected, result) => {
    expect(verifyBearerHeader(makeReq(header), expected)).toBe(result);
  });

  it("works with a raw header string", () => {
    expect(verifyBearerHeader("Bearer s3cr3t", "s3cr3t")).toBe(true);
    expect(verifyBearerHeader("Bearer wrong", "s3cr3t")).toBe(false);
    expect(verifyBearerHeader(null, "s3cr3t")).toBe(false);
    expect(verifyBearerHeader(undefined, "s3cr3t")).toBe(false);
  });
});
