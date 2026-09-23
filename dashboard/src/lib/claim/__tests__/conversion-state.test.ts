import {
  HERMESOS_CONTRACT_ADDRESS,
  checkTokenAddress,
  readAllowedUrl,
  resolveConversionState,
} from "../conversion-state";
import {
  CONVERSION_URL_ALLOWED_HOSTS,
  HIVRA_LAUNCH_CONFIG,
  TERMS_URL_ALLOWED_HOSTS,
  type HivraLaunchConfig,
} from "../hivra-launch-config";

// Stand-in address for tests only. It is not, and must never be treated as, $HIVRA.
const TEST_HIVRA = "0x1111111111111111111111111111111111111111";
const TERMS = "https://hivra.cloud/token/conversion-terms";
const CONVERT = "https://bankr.bot/convert/hivra";

function config(overrides: Partial<HivraLaunchConfig>): HivraLaunchConfig {
  return { hivraTokenAddress: null, termsUrl: null, conversionUrl: null, ...overrides };
}

describe("committed launch config", () => {
  it("ships dormant: no $HIVRA address, terms or conversion link is set", () => {
    expect(HIVRA_LAUNCH_CONFIG).toEqual({ hivraTokenAddress: null, termsUrl: null, conversionUrl: null });
    expect(resolveConversionState()).toEqual({ status: "dormant", problems: [] });
  });

  it("pins the exact hosts conversion and terms links may use", () => {
    expect(CONVERSION_URL_ALLOWED_HOSTS).toEqual(["bankr.bot"]);
    expect(TERMS_URL_ALLOWED_HOSTS).toEqual(["hivra.cloud", "canary.hermesos.cloud"]);
  });
});

describe("resolveConversionState", () => {
  it("stays dormant when only the links are set", () => {
    expect(resolveConversionState(config({ termsUrl: TERMS, conversionUrl: CONVERT })).status).toBe("dormant");
  });

  it.each([
    ["not an address", "hivra"],
    ["too short", "0x1234"],
    ["zero address", "0x0000000000000000000000000000000000000000"],
  ])("rejects an invalid $HIVRA address (%s) and stays dormant", (_label, address) => {
    const state = resolveConversionState(config({ hivraTokenAddress: address, termsUrl: TERMS, conversionUrl: CONVERT }));
    expect(state.status).toBe("dormant");
    expect(state.status === "dormant" && state.problems).toEqual([
      "hivraTokenAddress is not a valid Base contract address",
    ]);
  });

  it("refuses the $HermesOS contract as $HIVRA", () => {
    const state = resolveConversionState(
      config({ hivraTokenAddress: HERMESOS_CONTRACT_ADDRESS.toUpperCase().replace("0X", "0x"), termsUrl: TERMS, conversionUrl: CONVERT }),
    );
    expect(state).toEqual({ status: "dormant", problems: ["hivraTokenAddress is the $HermesOS contract"] });
  });

  it("announces the contract but keeps conversion closed until terms are published", () => {
    expect(resolveConversionState(config({ hivraTokenAddress: TEST_HIVRA, conversionUrl: CONVERT }))).toEqual({
      status: "announced",
      hivraTokenAddress: TEST_HIVRA,
      problems: [],
    });
  });

  it("keeps conversion closed without a conversion link", () => {
    expect(resolveConversionState(config({ hivraTokenAddress: TEST_HIVRA, termsUrl: TERMS })).status).toBe("announced");
  });

  it("opens only when address, terms and conversion link are all valid", () => {
    expect(
      resolveConversionState(config({ hivraTokenAddress: TEST_HIVRA.toUpperCase().replace("0X", "0x"), termsUrl: TERMS, conversionUrl: CONVERT })),
    ).toEqual({ status: "open", hivraTokenAddress: TEST_HIVRA, termsUrl: TERMS, conversionUrl: CONVERT });
  });

  it("keeps conversion closed and reports a conversion link on an unapproved host", () => {
    const state = resolveConversionState(
      config({ hivraTokenAddress: TEST_HIVRA, termsUrl: TERMS, conversionUrl: "https://bankr-bot.xyz/convert" }),
    );
    expect(state).toEqual({
      status: "announced",
      hivraTokenAddress: TEST_HIVRA,
      problems: ["conversionUrl must be https on an allowed host"],
    });
  });

  it("keeps conversion closed and reports terms on an unapproved host", () => {
    const state = resolveConversionState(
      config({ hivraTokenAddress: TEST_HIVRA, termsUrl: "https://hivra-cloud.io/terms", conversionUrl: CONVERT }),
    );
    expect(state.status).toBe("announced");
    expect(state.status === "announced" && state.problems).toEqual(["termsUrl must be https on an allowed Hivra host"]);
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
  const dormant = resolveConversionState(config({}));
  const announced = resolveConversionState(config({ hivraTokenAddress: TEST_HIVRA }));

  it("recognises the $HermesOS contract in any case", () => {
    expect(checkTokenAddress(` ${HERMESOS_CONTRACT_ADDRESS.toLowerCase()} `, dormant)).toEqual({ kind: "hermesos" });
  });

  it("says any other token is not Hivra's while $HIVRA has not launched", () => {
    expect(checkTokenAddress(TEST_HIVRA, dormant)).toEqual({ kind: "hivra-not-launched" });
  });

  it("recognises the configured $HIVRA contract once announced", () => {
    expect(checkTokenAddress(TEST_HIVRA, announced)).toEqual({ kind: "hivra" });
  });

  it("flags a lookalike once $HIVRA is announced", () => {
    expect(checkTokenAddress("0x2222222222222222222222222222222222222222", announced)).toEqual({ kind: "not-official" });
  });

  it("rejects partial input", () => {
    expect(checkTokenAddress("0x1111", announced)).toEqual({ kind: "invalid" });
  });
});
