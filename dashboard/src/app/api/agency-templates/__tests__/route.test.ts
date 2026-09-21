/**
 * Locks in the module-scope caching of /api/agency-templates.
 *
 * Before the cache, every GET re-read and re-parsed a ~2 MB JSON file.
 * Now we read once on cold start; subsequent requests return the cached
 * array. The test asserts the file system is hit exactly once across
 * many GETs by mocking `node:fs/promises.readFile` and counting calls.
 */

const mockReadFile = jest.fn();

jest.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

beforeEach(() => {
  mockReadFile.mockReset();
  jest.resetModules();
});

describe("GET /api/agency-templates", () => {
  it("loads the templates JSON only once across many requests", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([]));

    const { GET } = await import("../route");

    for (let i = 0; i < 5; i += 1) {
      const response = await GET();
      expect(response.status).toBe(200);
    }

    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it("retries the file read after the first attempt fails", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("disk hiccup"));
    mockReadFile.mockResolvedValueOnce(JSON.stringify([]));

    const { GET } = await import("../route");

    const failed = await GET();
    expect(failed.status).toBe(500);

    const succeeded = await GET();
    expect(succeeded.status).toBe(200);

    // Two reads: the failed first call followed by the retry. If we cached
    // the rejected promise, the second GET would never call readFile again
    // and the user would be permanently locked out.
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });
});
