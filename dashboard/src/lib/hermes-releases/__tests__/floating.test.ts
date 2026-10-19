import { clearFloatingImageCache, resolveFloatingImageTarget, splitImageReference } from "../floating";

const DIGEST = `sha256:${"d".repeat(64)}`;

function ghcr(digest = DIGEST) {
  return jest.fn(async (url: string | URL | Request) =>
    String(url).startsWith("https://ghcr.io/token")
      ? new Response(JSON.stringify({ token: "t" }))
      : new Response("{}", { headers: { "docker-content-digest": digest } })) as unknown as jest.Mock & typeof fetch;
}

beforeEach(() => clearFloatingImageCache());

describe("floating image targets", () => {
  it("splits tags, digests and untagged references", () => {
    expect(splitImageReference("ghcr.io/o/agent:stable")).toEqual({ imageRepo: "ghcr.io/o/agent", tag: "stable", digest: null });
    expect(splitImageReference("ghcr.io/o/agent")).toEqual({ imageRepo: "ghcr.io/o/agent", tag: "latest", digest: null });
    expect(splitImageReference(`ghcr.io/o/agent@${DIGEST}`)).toEqual({ imageRepo: "ghcr.io/o/agent", tag: null, digest: DIGEST });
  });

  it("answers a pinned reference without asking the registry", async () => {
    const fetchImpl = ghcr();
    await expect(resolveFloatingImageTarget(`ghcr.io/o/agent@${DIGEST}`, { fetchImpl })).resolves.toEqual({ imageRepo: "ghcr.io/o/agent", tag: null, digest: DIGEST });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never looks up an image outside GHCR", async () => {
    const fetchImpl = ghcr();
    await expect(resolveFloatingImageTarget("hivra-local/hermes:overlay", { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches a tag lookup for a few minutes, then reads it again", async () => {
    let clock = 1_000_000;
    const fetchImpl = ghcr();
    const now = () => clock;
    await resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl, now });
    await resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock += 6 * 60_000;
    await resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("floating image lookup failures and bursts", () => {
  it("remembers a failed lookup for a minute so an outage isn't paid on every view", async () => {
    let clock = 5_000_000;
    const now = () => clock;
    const fetchImpl = jest.fn(async () => new Response("", { status: 503 })) as unknown as jest.Mock & typeof fetch;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl, now })).resolves.toBeNull();
    await expect(resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl, now })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one lookup between views that arrive together", async () => {
    const fetchImpl = ghcr();
    const [a, b] = await Promise.all([
      resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl }),
      resolveFloatingImageTarget("ghcr.io/o/agent:stable", { fetchImpl }),
    ]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
