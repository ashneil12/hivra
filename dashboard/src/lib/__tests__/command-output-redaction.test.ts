import { redactSensitiveCommandOutput, SECRET_TOKEN_SHAPES } from "@/lib/command-output-redaction";

describe("redactSensitiveCommandOutput", () => {
  it("redacts common token and secret formats before logging", () => {
    const raw = [
      'refresh_token=super-secret',
      '"client_secret":"very-secret"',
      "Authorization: Bearer top-secret-token",
      "password=hunter2",
      "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-secret&api_key=secondary-secret",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain("refresh_token=[REDACTED]");
    expect(redacted).toContain('"client_secret":"[REDACTED]"');
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).toContain("https://generativelanguage.googleapis.com/v1beta/models?key=[REDACTED]&api_key=[REDACTED]");
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("very-secret");
    expect(redacted).not.toContain("top-secret-token");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("gemini-secret");
    expect(redacted).not.toContain("secondary-secret");
  });

  it("redacts generic secret-like values even when they are not key/value pairs", () => {
    const raw = [
      "db leaked sk-live-secret",
      "hosts-secret-leak",
      "upload-secret-leak",
      "super-secret",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain("db leaked [REDACTED]");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-live-secret");
    expect(redacted).not.toContain("hosts-secret-leak");
    expect(redacted).not.toContain("upload-secret-leak");
    expect(redacted).not.toContain("super-secret");
  });

  it("redacts Tailscale auth keys from command output", () => {
    const raw = "tailscale up failed for tskey-auth-abcDEF123456";

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("tskey-auth-abcDEF123456");
  });

  it("redacts agent-run reporter credentials wherever they appear", () => {
    const token = ["hvra_otlp_v1", "eyJ2IjoxLCJ1c2VySWQiOiJ1c2VyIn0", "c2lnbmF0dXJlLWZpeHR1cmU"].join("."); // synthetic, built at runtime
    const raw = [
      `reporter replayed ${token} after restart`,
      `HIVRA_ACTIVITY_TOKEN:${token}`,
      "truncated hvra_otlp_v1.eyJ2IjoxfQ",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw, 1000);

    expect(redacted).toBe([
      "reporter replayed [REDACTED] after restart",
      "HIVRA_ACTIVITY_TOKEN:[REDACTED]",
      "truncated [REDACTED]",
    ].join("\n"));
    expect(redacted).not.toContain("hvra_otlp_v1");
    expect(redacted).not.toContain("c2lnbmF0dXJlLWZpeHR1cmU");
  });

  it("redacts camelCase secret fields from JSON error bodies", () => {
    const raw = JSON.stringify({
      error: "forbidden",
      message: "partner scope does not allow wallet creation",
      apiKey: "bk_ptr_secret_that_must_not_be_logged",
      partnerKey: "partner-key-secret",
    });

    const redacted = redactSensitiveCommandOutput(raw);

    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"partnerKey":"[REDACTED]"');
    expect(redacted).not.toContain("bk_ptr_secret_that_must_not_be_logged");
    expect(redacted).not.toContain("partner-key-secret");
  });

  // The assignment pattern used to start at a word boundary, and there is no
  // boundary between an underscore and a letter. So `API_KEY=` was redacted but
  // `OPENAI_API_KEY=` and `GITHUB_TOKEN=` were not: the name is one word, and
  // the secret words sat inside it.
  it("redacts environment-style assignments whose name only ends in a secret word", () => {
    const raw = [
      "OPENAI_API_KEY=sk-not-really-a-key-1234",
      "export GITHUB_TOKEN=ghp_examplevalue1234",
      "GHCR_TOKEN=ghcr-example-value",
      "VENICE_API_KEY=venice-example-value",
      "API_SERVER_KEY=server-example-value",
      "DB_PASSWORD=db-example-value",
      "MY_CLIENT_SECRET=client-example-value",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw, 1000);

    expect(redacted).toBe([
      "OPENAI_API_KEY=[REDACTED]",
      "export GITHUB_TOKEN=[REDACTED]",
      "GHCR_TOKEN=[REDACTED]",
      "VENICE_API_KEY=[REDACTED]",
      "API_SERVER_KEY=[REDACTED]",
      "DB_PASSWORD=[REDACTED]",
      "MY_CLIENT_SECRET=[REDACTED]",
    ].join("\n"));
  });

  it("redacts Bankr keys in assignments and on their own", () => {
    const raw = [
      "BANKR_API_KEY=bk_usr_FAKEFAKEFAKEFAKE1234",
      "BANKR_USER_KEY=bk_usr_FAKEFAKEFAKEFAKE5678",
      "export BANKR_AGENT_KEY=bk_ptr_FAKEFAKEFAKEFAKE9012",
      "the wallet call failed for bk_agent_FAKEFAKEFAKEFAKE3456 today",
    ].join("\n");

    const redacted = redactSensitiveCommandOutput(raw, 1000);

    expect(redacted).not.toMatch(/FAKEFAKE/);
    expect(redacted).toContain("BANKR_API_KEY=[REDACTED]");
    expect(redacted).toContain("BANKR_USER_KEY=[REDACTED]");
    expect(redacted).toContain("export BANKR_AGENT_KEY=[REDACTED]");
    expect(redacted).toContain("the wallet call failed for [REDACTED] today");
  });

  it("keeps ordinary text that only looks close to a secret name", () => {
    const raw = [
      "MAX_TOKENS=4096",
      "PUBLIC_KEY=ssh-ed25519-example",
      "monkey=banana",
      "bk_ is a prefix, bk_short is too short to be a key",
    ].join("\n");

    expect(redactSensitiveCommandOutput(raw, 1000)).toBe(raw);
  });
  // Bare token shapes: a provider, bot or infrastructure credential that appears
  // with no name in front of it, such as an error body that echoes the key. The
  // synthetic values are built at runtime so no scanner sees a literal key.
  describe("bare token shapes", () => {
    const body = (n: number) => "Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu0Vw".repeat(4).slice(0, n);
    const hex = (n: number) => "0123456789abcdef".repeat(8).slice(0, n);
    const telegram = `123456789:${body(35)}`;

    it.each([
      ["Anthropic", `sk-ant-api03-${body(40)}`],
      ["OpenRouter", `sk-or-v1-${hex(64)}`],
      ["OpenAI-style", `sk-${body(48)}`],
      ["xAI", `xai-${body(40)}`],
      ["Groq", `gsk_${body(40)}`],
      ["GitHub classic", `ghp_${body(36)}`],
      ["GitHub OAuth", `gho_${body(36)}`],
      ["GitHub fine-grained", `github_pat_${body(22)}_${body(59)}`],
      ["GitLab", `glpat-${body(20)}`],
      ["AWS access key", `AKIA${"ABCDEFGH23456789"}`],
      ["AWS temporary (session) key", `ASIA${"ABCDEFGH23456789"}`],
      ["Google API", `AIza${body(35)}`],
      ["Telegram bot", telegram],
      ["Slack", `xoxb-1234567890-${body(12)}`],
      ["Stripe live secret", `sk_live_${body(24)}`],
      ["Stripe restricted", `rk_test_${body(24)}`],
      ["JWT", `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.${body(20)}`],
      ["Managed Venice", `hven_live_${body(24)}`],
      ["Agent link", `hvl_${hex(64)}`],
      ["Tailscale API", `tskey-api-${body(16)}`],
      ["Tailscale client", `tskey-client-${body(16)}`],
    ])("redacts a bare %s token", (_label, token) => {
      const raw = `upstream rejected ${token} for this request`;

      const redacted = redactSensitiveCommandOutput(raw, 1000);

      expect(redacted).toBe("upstream rejected [REDACTED] for this request");
      expect(redacted).not.toContain(token);
    });

    it("redacts a Telegram token inside a bot API URL", () => {
      const raw = `GET https://api.telegram.org/bot${telegram}/getMe failed`;

      const redacted = redactSensitiveCommandOutput(raw, 1000);

      expect(redacted).toBe("GET https://api.telegram.org/bot[REDACTED]/getMe failed");
      expect(redacted).not.toContain(body(35));
    });

    it("redacts a whole PEM private key block, including its body", () => {
      const raw = [
        "ssh failed with key:",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEA0synthetic",
        "-----END RSA PRIVATE KEY-----",
        "done",
      ].join("\n");

      const redacted = redactSensitiveCommandOutput(raw, 1000);

      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain("MIIEowIBAAKCAQEA0synthetic");
      expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(redacted.endsWith("done")).toBe(true);
    });

    it("keeps ordinary text that only contains a token prefix", () => {
      const raw = [
        "task-manager restarted in risk-assessment mode",
        "sk-learn-based classifier with 11 features",
        "gh_ is a prefix and ghp_short is too short",
        "xoxo hugs and AKIA is an access key prefix",
        "eyJ is the base64 start of a JSON object",
        "xai-grok-helper-for-everything-in-the-workspace is a project name",
        "step 3 of 4 at 12:30:45 with 2 bots",
        "token count: 12",
        `sha256 digest ${hex(64)} of the release`,
      ].join("\n");

      expect(redactSensitiveCommandOutput(raw, 1000)).toBe(raw);
    });
  });
  // A legacy shape is matched wherever it sits, as the base snapshot scanner did, so a
  // key glued onto a word or URL-encoded inside a URL is still masked.
  describe("keys glued to text or URL-encoded", () => {
    const body = (n: number) => "Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu0Vw".repeat(4).slice(0, n);

    it.each([
      ["Anthropic key glued to a word", `notes keysk-ant-api03-${body(40)}`, "notes key[REDACTED]"],
      ["Anthropic key URL-encoded", `x%20sk-ant-api03-${body(40)}`, "x%20[REDACTED]"],
      ["GitHub token URL-encoded", `x%20ghp_${body(36)}`, "x%20[REDACTED]"],
      ["managed Venice key URL-encoded", `x%20hven_live_${body(24)}`, "x%20[REDACTED]"],
      ["Bankr key with another prefix", `wallet call rejected bk_test_${body(20)} today`, "wallet call rejected [REDACTED] today"],
    ])("masks an %s", (_label, raw, expected) => {
      expect(redactSensitiveCommandOutput(raw, 1000)).toBe(expected);
    });
  });

  // A 64-character hex value straight after a token word, however long the value is.
  it("masks a longer hex value after a token word, not only exactly 64 characters", () => {
    const hex128 = "0123456789abcdef".repeat(8);
    const raw = [`token: ${hex128}`, `agent key ${hex128}`].join("\n");

    expect(redactSensitiveCommandOutput(raw, 1000)).toBe("token: [REDACTED]\nagent key [REDACTED]");
  });

  // A whitespace run after a token word used to take quadratic time: the separator could
  // split the run two ways before the hex check failed. 100k spaces took about 12 s.
  it("handles a long whitespace run after a token word in linear time", () => {
    const raw = `token${" ".repeat(100_000)}`;

    const started = Date.now();
    const redacted = redactSensitiveCommandOutput(raw, 200_000);
    const elapsedMs = Date.now() - started;

    expect(redacted).toBe(raw);
    expect(elapsedMs).toBeLessThan(1000);
  });

  // Unquoted YAML `name: value` lines, the form agent CLI configs are written in. Only
  // a key that starts its own line counts, so prose such as "Auth token: missing" is
  // left alone. Quoted values are covered by the JSON patterns.
  describe("unquoted YAML secret fields", () => {
    it("redacts unquoted secret-named values on their own line", () => {
      const raw = [
        "client_secret: hunter2hunter2",
        "api_key: plainvalue123",
        "  password: hunter2",
        "- token: abc123def456",
        "x-api-key: abc123def456",
      ].join("\n");

      expect(redactSensitiveCommandOutput(raw, 1000)).toBe([
        "client_secret: [REDACTED]",
        "api_key: [REDACTED]",
        "  password: [REDACTED]",
        "- token: [REDACTED]",
        "x-api-key: [REDACTED]",
      ].join("\n"));
    });

    it("keeps quoted YAML values redacted as before", () => {
      expect(redactSensitiveCommandOutput('api_key: "plainvalue123"', 1000)).toBe('api_key: "[REDACTED]"');
    });

    // `x-api-key` is the header name agent APIs use. It was masked unquoted (YAML) but not
    // when quoted, because the JSON and single-quote patterns named `api_key` only.
    it("masks a quoted hyphenated api-key name in JSON and YAML", () => {
      expect(redactSensitiveCommandOutput('{"x-api-key": "plainvalue123"}', 1000)).toBe('{"x-api-key": "[REDACTED]"}');
      expect(redactSensitiveCommandOutput("x-api-key: 'plainvalue123'", 1000)).toBe("x-api-key: '[REDACTED]'");
    });

    it("keeps ordinary keys and mid-line prose unchanged", () => {
      const raw = [
        "monkey: banana",
        "tokens: 3",
        "primary_key: id",
        "sort_key: name",
        "Auth token: missing for the request",
        "the token: expired",
      ].join("\n");

      expect(redactSensitiveCommandOutput(raw, 1000)).toBe(raw);
    });
  });

  // A 64-character hex value straight after a token-like word is a credential
  // (for example an agent link key). A bare sha256 digest is ordinary output and stays.
  describe("64-character hex values after a token word", () => {
    const hexKey = "0123456789abcdef".repeat(4);

    it("redacts the hex value after a token-like word", () => {
      const raw = [`token: ${hexKey}`, `agent key ${hexKey}`, `password="${hexKey}"`].join("\n");

      expect(redactSensitiveCommandOutput(raw, 1000)).toBe([
        "token: [REDACTED]",
        "agent key [REDACTED]",
        'password="[REDACTED]"',
      ].join("\n"));
    });

    it("keeps a bare digest and a digest under an ordinary label", () => {
      const raw = [`release digest ${hexKey}`, `fingerprint: ${hexKey}`].join("\n");

      expect(redactSensitiveCommandOutput(raw, 1000)).toBe(raw);
    });
  });

  // The JWT shape used to start a match at every `eyJ` inside a dash-joined run (a `-` is
  // not a boundary for it), and each start scanned to the end of the run before failing on
  // the missing `.eyJ`. 200 KB of `eyJ-` took about 10 s. A run must now start one match at
  // most, so the scan is linear.
  describe("JWT shape on long dash-joined runs", () => {
    const jwtShape = SECRET_TOKEN_SHAPES.find(({ kind }) => kind === "jwt")!.pattern;
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.${"Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu0Vw".repeat(2)}`;

    it("tests a 200 KB run of eyJ- in linear time", () => {
      const raw = "eyJ-".repeat(50_000);

      const started = Date.now();
      const matched = jwtShape.test(raw);
      const elapsedMs = Date.now() - started;

      expect(matched).toBe(false);
      expect(elapsedMs).toBeLessThan(1000);
    });

    it("still masks a JWT after a space, an equals sign, a quote or %20", () => {
      const raw = [
        `upstream said ${jwt}`,
        `x=${jwt}`,
        `"${jwt}"`,
        `q%20${jwt}`,
      ].join("\n");

      expect(redactSensitiveCommandOutput(raw, 1000)).toBe([
        "upstream said [REDACTED]",
        "x=[REDACTED]",
        '"[REDACTED]"',
        "q%20[REDACTED]",
      ].join("\n"));
    });
  });
});
