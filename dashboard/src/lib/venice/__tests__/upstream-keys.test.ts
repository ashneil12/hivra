import {
  parseManagedVeniceInferenceKeys,
  resolveManagedVeniceUpstreamKey,
} from "@/lib/venice/upstream-keys";

describe("managed Venice upstream key rotation", () => {
  it("parses JSON, newline, and comma separated key pools without blanks", () => {
    expect(
      parseManagedVeniceInferenceKeys({
        MANAGED_VENICE_INFERENCE_KEYS: '[" key_a ","","key_b"]',
      })
    ).toEqual(["key_a", "key_b"]);

    expect(
      parseManagedVeniceInferenceKeys({
        MANAGED_VENICE_INFERENCE_KEYS: "key_c\nkey_d, key_e",
      })
    ).toEqual(["key_c", "key_d", "key_e"]);
  });

  it("prefers the managed inference key pool over the legacy single key", () => {
    const resolved = resolveManagedVeniceUpstreamKey(
      {
        referenceId: "ref_1",
        proxyKeyId: "proxy_1",
        model: "venice-uncensored-1-2",
        endpoint: "/api/v1/chat/completions",
      },
      {
        MANAGED_VENICE_INFERENCE_KEYS: JSON.stringify(["pool_a", "pool_b", "pool_c"]),
        VENICE_API_KEY: "legacy_key",
      }
    );

    expect(resolved).toEqual(
      expect.objectContaining({
        key: expect.stringMatching(/^pool_[abc]$/),
        source: "pool",
        poolSize: 3,
      })
    );
  });

  it("falls back to VENICE_API_KEY when the pool is missing", () => {
    expect(
      resolveManagedVeniceUpstreamKey(
        { referenceId: "ref_1", proxyKeyId: "proxy_1", endpoint: "/api/v1/models" },
        { VENICE_API_KEY: "legacy_key" }
      )
    ).toEqual({ key: "legacy_key", source: "legacy", index: 0, poolSize: 1 });
  });

  it("returns null when no upstream key is configured", () => {
    expect(
      resolveManagedVeniceUpstreamKey(
        { referenceId: "ref_1", proxyKeyId: "proxy_1", endpoint: "/api/v1/models" },
        {}
      )
    ).toBeNull();
  });

  it("chooses keys deterministically for the same request identity", () => {
    const env = { MANAGED_VENICE_INFERENCE_KEYS: "key_1,key_2,key_3,key_4" };
    const input = {
      referenceId: "ref_stable",
      proxyKeyId: "proxy_stable",
      model: "model_stable",
      endpoint: "/api/v1/chat/completions",
    };

    expect(resolveManagedVeniceUpstreamKey(input, env)).toEqual(
      resolveManagedVeniceUpstreamKey(input, env)
    );
  });
});
