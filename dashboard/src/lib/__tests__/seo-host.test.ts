import { isCanaryHost } from "@/lib/seo-host";

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
