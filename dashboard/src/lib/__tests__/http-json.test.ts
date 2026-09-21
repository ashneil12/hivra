import { parseJsonResponse } from "@/lib/http-json";

describe("parseJsonResponse", () => {
  it("parses valid JSON bodies", async () => {
    const response = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });

    await expect(parseJsonResponse<{ success: boolean }>(response)).resolves.toEqual({
      success: true,
    });
  });

  it("throws a readable error when the server returns plain text", async () => {
    const response = new Response("Internal Server Error", {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
      },
    });

    await expect(parseJsonResponse(response)).rejects.toThrow(
      "HTTP 500: Internal Server Error"
    );
  });

  it("falls back to json() when a response mock does not implement text()", async () => {
    const response = {
      status: 200,
      json: async () => ({ success: true }),
    } as Pick<Response, "status" | "json">;

    await expect(parseJsonResponse<{ success: boolean }>(response)).resolves.toEqual({
      success: true,
    });
  });

  it("returns an empty object when the body is empty", async () => {
    const response = new Response(null, {
      status: 204,
    });

    await expect(parseJsonResponse<Record<string, never>>(response)).resolves.toEqual({});
  });
});
