import { HERMESOS_TOKEN, validateHivraLaunchConfig, type PlatformToken } from "@/lib/billing/token-registry";

import {
  checkTokenAddress,
  readAllowedUrl,
  readConversionInputs,
  resolveConversionState,
  type ConversionInputs,
} from "../conversion-state";
import {
  CONVERSION_LINKS,
  CONVERSION_URL_ALLOWED_HOSTS,
  TERMS_URL_ALLOWED_HOSTS,
} from "../conversion-links-config";

// Stand-in address for tests only. It is not, and must never be treated as, $HIVRA.
const TEST_HIVRA = "0x1111111111111111111111111111111111111111";
const TERMS = "https://hivra.cloud/token/conversion-terms";
const CONVERT = "https://bankr.bot/convert/hivra";

function testHivraToken(): PlatformToken {
  const validation = validateHivraLaunchConfig({
    contractAddress: TEST_HIVRA,
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-10-01T16:00:00Z",
  });
  if (validation.status !== "configured") throw new Error("test launch block should validate");
  return validation.token;
}

function inputs(overrides: Partial<ConversionInputs> = {}): ConversionInputs {
  return {
    hivra: testHivraToken(),
    phase: "active",
    links: { termsUrl: TERMS, conversionUrl: CONVERT },
    access: { grandfathered: false, convertedAt: null, conversionGraceEndsAt: null },
    ...overrides,
  };
}

describe("committed configuration", () => {
  it("ships with no conversion link, so the committed state can never be open", () => {
    expect(CONVERSION_LINKS).toEqual({ termsUrl: null, conversionUrl: null });
    // Holds before and after the registry's $HIVRA launch block is filled in.
    expect(resolveConversionState(readConversionInputs({ grandfathered: false, convertedAt: null, conversionGraceEndsAt: null })).status).not.toBe("open");
  });

  it("pins the exact hosts conversion and terms links may use", () => {
    expect(CONVERSION_URL_ALLOWED_HOSTS).toEqual(["bankr.bot"]);
    expect(TERMS_URL_ALLOWED_HOSTS).toEqual(["hivra.cloud", "canary.hermesos.cloud"]);
  });
});

describe("resolveConversionState", () => {
  it("is dormant while the registry has no $HIVRA, even with links and access", () => {
    expect(resolveConversionState(inputs({ hivra: null, phase: "dormant" })).status).toBe("dormant");
  });

  it("opens when $HIVRA is live, both links are valid and the user's tier counts $HIVRA", () => {
    expect(resolveConversionState(inputs())).toEqual({
      status: "open",
      hivraAddress: TEST_HIVRA,
      hivraPublishedAddress: TEST_HIVRA,
      termsUrl: TERMS,
      conversionUrl: CONVERT,
      graceEndsAt: null,
    });
  });

  it.each<[string, Partial<ConversionInputs>]>([
    ["$HIVRA is scheduled but not live", { phase: "scheduled" }],
    ["the terms are not published", { links: { termsUrl: null, conversionUrl: CONVERT } }],
    ["there is no conversion link", { links: { termsUrl: TERMS, conversionUrl: null } }],
    ["the user's access can't be read", { access: null }],
  ])("stays closed (announced) when %s", (_label, overrides) => {
    const state = resolveConversionState(inputs(overrides));
    expect(state.status).toBe("announced");
    expect(state.status === "announced" && state.hivraPublishedAddress).toBe(TEST_HIVRA);
  });

  it("asks a grandfathered holder who hasn't switched to switch their access first, with no swap link", () => {
    expect(resolveConversionState(inputs({ access: { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null } }))).toEqual({
      status: "switch-access",
      hivraAddress: TEST_HIVRA,
      hivraPublishedAddress: TEST_HIVRA,
      termsUrl: TERMS,
    });
  });

  it("opens for a grandfathered holder who has switched their access, carrying their grace end", () => {
    expect(
      resolveConversionState(
        inputs({
          access: {
            grandfathered: true,
            convertedAt: "2026-10-02T00:00:00.000Z",
            conversionGraceEndsAt: "2026-10-05T00:00:00.000Z",
          },
        }),
      ),
    ).toMatchObject({ status: "open", graceEndsAt: "2026-10-05T00:00:00.000Z" });
  });

  it("never asks for the switch while links are missing", () => {
    expect(
      resolveConversionState(
        inputs({ links: { termsUrl: TERMS, conversionUrl: null }, access: { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null } }),
      ).status,
    ).toBe("announced");
  });

  it("keeps conversion closed and reports a conversion link on an unapproved host", () => {
    const state = resolveConversionState(inputs({ links: { termsUrl: TERMS, conversionUrl: "https://bankr-bot.xyz/convert" } }));
    expect(state).toMatchObject({ status: "announced", problems: ["conversionUrl must be https on an allowed host"] });
  });

  it("keeps conversion closed and reports terms on an unapproved host", () => {
    const state = resolveConversionState(inputs({ links: { termsUrl: "https://hivra-cloud.io/terms", conversionUrl: CONVERT } }));
    expect(state).toMatchObject({ status: "announced", problems: ["termsUrl must be https on an allowed Hivra host"] });
  });
});

describe("readAllowedUrl", () => {
  const allowed = ["bankr.bot"];

  it.each([
    ["https://bankr.bot/x", "https://bankr.bot/x"],
    ["https://BANKR.bot/x", "https://bankr.bot/x"],
    ["https://bankr.bot:443/x", "https://bankr.bot/x"],
  ])("accepts %s", (input, expected) => {
    expect(readAllowedUrl(input, allowed)).toBe(expected);
  });

  it.each([
    "http://bankr.bot/x",
    "https://evilbankr.bot/x",
    "https://swap.bankr.bot/x",
    "https://bankr.bot./x",
    "https://bankr.bot:8443/x",
    "https://xn--bnkr-8na.bot/x",
    "https://bankr.bot.evil.example/x",
    "https://user:pass@bankr.bot/x",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("rejects %s", (input) => {
    expect(readAllowedUrl(input, allowed)).toBeNull();
  });
});

describe("checkTokenAddress", () => {
  const dormant = resolveConversionState(inputs({ hivra: null, phase: "dormant" }));
  const announced = resolveConversionState(inputs({ phase: "scheduled" }));

  it("recognises the $HermesOS contract in any case", () => {
    expect(checkTokenAddress(` ${HERMESOS_TOKEN.publishedAddress.toUpperCase().replace("0X", "0x")} `, dormant)).toEqual({
      kind: "hermesos",
    });
  });

  it("says any other token is not Hivra's while $HIVRA has not launched", () => {
    expect(checkTokenAddress(TEST_HIVRA, dormant)).toEqual({ kind: "hivra-not-launched" });
  });

  it("recognises the registry $HIVRA contract once announced", () => {
    expect(checkTokenAddress(TEST_HIVRA, announced)).toEqual({ kind: "hivra" });
  });

  it("flags a lookalike once $HIVRA is announced", () => {
    expect(checkTokenAddress("0x2222222222222222222222222222222222222222", announced)).toEqual({ kind: "not-official" });
  });

  it("rejects partial input", () => {
    expect(checkTokenAddress("0x1111", announced)).toEqual({ kind: "invalid" });
  });
});
