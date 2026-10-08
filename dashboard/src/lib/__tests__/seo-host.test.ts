import { isCanaryHost, isNoIndexHost } from "@/lib/seo-host";

describe("isCanaryHost", () => {
  it.each(["canary.hermesos.cloud", "canary.hermesos.cloud:443", "CANARY.HERMESOS.CLOUD"])(
    "recognizes %s",
    (host) => {
      expect(isCanaryHost(host)).toBe(true);
    },
  );

  it.each(["hivra.cloud", "preview.hermesos.cloud", "localhost", null, undefined])(
    "does not recognize %s",
    (host) => {
      expect(isCanaryHost(host)).toBe(false);
    },
  );
});

describe("isNoIndexHost", () => {
  it.each([
    "canary.hermesos.cloud",
    "hermesos-canary.vercel.app",
    "hermesos.vercel.app",
    "hermesos-git-some-branch-team.vercel.app:443",
    "HERMESOS.VERCEL.APP",
  ])("keeps %s out of the index", (host) => {
    expect(isNoIndexHost(host)).toBe(true);
  });

  it.each(["hivra.cloud", "www.hivra.cloud", "hermesos.cloud", "vercel.app.example.com", "localhost", null, undefined])(
    "lets %s be indexed",
    (host) => {
      expect(isNoIndexHost(host)).toBe(false);
    },
  );
});
