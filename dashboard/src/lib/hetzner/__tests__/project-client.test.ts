import {
  createHetznerCloudProjectClient,
  HetznerCloudApiError,
} from "@/lib/hetzner/client";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("self-managed Hetzner Cloud project client", () => {
  const originalAmbientToken = process.env.HETZNER_API_TOKEN;

  afterEach(() => {
    if (originalAmbientToken === undefined) delete process.env.HETZNER_API_TOKEN;
    else process.env.HETZNER_API_TOKEN = originalAmbientToken;
  });

  it("uses the fixed official API origin, explicit token, and bounded pagination", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        json({
          servers: [{ id: 1 }],
          meta: {
            pagination: {
              page: 1,
              per_page: 50,
              previous_page: null,
              next_page: 2,
              last_page: 2,
              total_entries: 2,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          servers: [{ id: 2 }],
          meta: {
            pagination: {
              page: 2,
              per_page: 50,
              previous_page: 1,
              next_page: null,
              last_page: 2,
              total_entries: 2,
            },
          },
        }),
      );
    process.env.HETZNER_API_TOKEN = "ambient-token-must-not-be-used";

    const servers = await createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).listServers();

    expect(servers).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.hetzner.cloud/v1/servers?per_page=50&page=1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const firstHeaders = fetchImpl.mock.calls[0][1].headers as Headers;
    expect(firstHeaders.get("Authorization")).toBe("Bearer owner-project-token");
    expect(firstHeaders.get("Authorization")).not.toContain("ambient-token");
  });

  it("uses one terminal exact-name request for mutation reconciliation", async () => {
    const terminalPagination = {
      page: 1,
      per_page: 50,
      previous_page: null,
      next_page: null,
      last_page: 1,
      total_entries: 1,
    };
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json({
        servers: [{ id: 42, name: "hivra-capacity-abc" }],
        meta: { pagination: terminalPagination },
      }))
      .mockResolvedValueOnce(json({
        ssh_keys: [{ id: 77, name: "hivra-key-abc" }],
        meta: { pagination: terminalPagination },
      }));
    const client = createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.findServersByName("hivra-capacity-abc")).resolves.toEqual([
      { id: 42, name: "hivra-capacity-abc" },
    ]);
    await expect(client.findSshKeysByName("hivra-key-abc")).resolves.toEqual([
      { id: 77, name: "hivra-key-abc" },
    ]);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.hetzner.cloud/v1/servers?name=hivra-capacity-abc&per_page=50&page=1",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.hetzner.cloud/v1/ssh_keys?name=hivra-key-abc&per_page=50&page=1",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of paginating an exact-name reconciliation lookup", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({
      servers: [{ id: 42, name: "hivra-capacity-abc" }],
      meta: {
        pagination: {
          page: 1,
          per_page: 50,
          previous_page: null,
          next_page: 2,
          last_page: 2,
          total_entries: 51,
        },
      },
    }));

    await expect(createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).findServersByName("hivra-capacity-abc")).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        status: 502,
        code: "response_invalid",
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds an exact-name reconciliation lookup to the single 15-second request", async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn().mockImplementation(
        async (_url: string, init: RequestInit) => ({
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const error = new Error("aborted while streaming");
              error.name = "AbortError";
              reject(error);
            });
          }),
        }) as unknown as Response,
      );
      const request = createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).findSshKeysByName("hivra-key-abc");
      const timeoutExpectation = expect(request).rejects.toEqual(
        expect.objectContaining<Partial<HetznerCloudApiError>>({
          code: "timeout",
        }),
      );

      await jest.advanceTimersByTimeAsync(15_001);
      await timeoutExpectation;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not allow a caller header to replace the project credential", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        servers: [],
        meta: {
          pagination: {
            page: 1,
            per_page: 50,
            previous_page: null,
            next_page: null,
            last_page: 1,
            total_entries: 0,
          },
        },
      }),
    );

    await createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).listServers();

    const headers = fetchImpl.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer owner-project-token");
  });

  it("fails closed on GET redirects without forwarding the credential", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.test/servers" },
      }),
    );

    await expect(createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).listServers()).rejects.toEqual(expect.objectContaining({ status: 307 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toEqual(expect.objectContaining({
      redirect: "error",
    }));
  });

  it("fails closed when list pagination metadata is missing", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ servers: [{ id: 1 }] }));

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        status: 502,
        code: "request_failed",
      }),
    );
  });

  it("fails closed when next_page is absent instead of explicitly null", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        servers: [{ id: 1 }],
        meta: {
          pagination: {
            page: 1,
            per_page: 50,
            previous_page: null,
            last_page: 1,
            total_entries: 1,
          },
        },
      }),
    );

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        status: 502,
        code: "request_failed",
      }),
    );
  });

  it("fails closed when provider pagination reports the wrong current page", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        servers: [{ id: 1 }],
        meta: {
          pagination: {
            page: 2,
            per_page: 50,
            previous_page: 1,
            next_page: null,
            last_page: 2,
            total_entries: 1,
          },
        },
      }),
    );

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        status: 502,
        code: "request_failed",
      }),
    );
  });

  it("fails closed when next_page skips a page", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        servers: [{ id: 1 }],
        meta: {
          pagination: {
            page: 1,
            per_page: 50,
            previous_page: null,
            next_page: 3,
            last_page: 3,
            total_entries: 3,
          },
        },
      }),
    );

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        status: 502,
        code: "request_failed",
      }),
    );
  });

  it("fails closed when previous_page does not match the requested page", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        json({
          servers: [{ id: 1 }],
          meta: {
            pagination: {
              page: 1,
              per_page: 50,
              previous_page: null,
              next_page: 2,
              last_page: 2,
              total_entries: 2,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          servers: [{ id: 2 }],
          meta: {
            pagination: {
              page: 2,
              per_page: 50,
              previous_page: null,
              next_page: null,
              last_page: 2,
              total_entries: 2,
            },
          },
        }),
      );

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        status: 502,
        code: "request_failed",
      }),
    );
  });

  it("fails closed when the final count does not match total_entries", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        servers: [{ id: 1 }],
        meta: {
          pagination: {
            page: 1,
            per_page: 50,
            previous_page: null,
            next_page: null,
            last_page: 1,
            total_entries: 2,
          },
        },
      }),
    );

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        status: 502,
        code: "request_failed",
      }),
    );
  });

  it.each([2, null] as const)(
    "fails closed when a later page changes known last_page to %s",
    async (laterLastPage) => {
      const firstPage = Array.from(
        { length: 50 },
        (_, index) => ({ id: index + 1 }),
      );
      const secondPage = Array.from(
        { length: 50 },
        (_, index) => ({ id: index + 51 }),
      );
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          json({
            servers: firstPage,
            meta: {
              pagination: {
                page: 1,
                per_page: 50,
                previous_page: null,
                next_page: 2,
                last_page: 3,
                total_entries: null,
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          json({
            servers: secondPage,
            meta: {
              pagination: {
                page: 2,
                per_page: 50,
                previous_page: 1,
                next_page: null,
                last_page: laterLastPage,
                total_entries: null,
              },
            },
          }),
        );

      await expect(
        createHetznerCloudProjectClient("owner-project-token", {
          fetchImpl: fetchImpl as typeof fetch,
        }).listServers(),
      ).rejects.toEqual(
        expect.objectContaining<Partial<HetznerCloudApiError>>({
          status: 502,
          code: "request_failed",
        }),
      );
    },
  );

  it("accepts schema-valid null last_page and total_entries on a terminal page", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        servers: [{ id: 1 }],
        meta: {
          pagination: {
            page: 1,
            per_page: 50,
            previous_page: null,
            next_page: null,
            last_page: null,
            total_entries: null,
          },
        },
      }),
    );

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).resolves.toEqual([{ id: 1 }]);
  });

  it("advances from explicit next_page when last_page and total_entries are null", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        json({
          servers: [{ id: 1 }],
          meta: {
            pagination: {
              page: 1,
              per_page: 50,
              previous_page: null,
              next_page: 2,
              last_page: null,
              total_entries: null,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          servers: [{ id: 2 }],
          meta: {
            pagination: {
              page: 2,
              per_page: 50,
              previous_page: 1,
              next_page: null,
              last_page: null,
              total_entries: null,
            },
          },
        }),
      );

    await expect(
      createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers(),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("redacts provider response bodies and credentials from failures", async () => {
    const secret = "owner-project-token-secret";
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(`provider reflected ${secret}`, { status: 401 }),
    );

    const request = createHetznerCloudProjectClient(secret, {
      fetchImpl: fetchImpl as typeof fetch,
    }).listServers();

    await expect(request).rejects.toEqual(
      expect.objectContaining<Partial<HetznerCloudApiError>>({
        name: "HetznerCloudApiError",
        status: 401,
        code: "request_failed",
      }),
    );
    await expect(request).rejects.not.toThrow(secret);
  });

  it("keeps the 15-second abort deadline active through response-body parsing", async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn().mockImplementation(
        async (_url: string, init: RequestInit) => ({
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const error = new Error("aborted while streaming");
              error.name = "AbortError";
              reject(error);
            });
          }),
        }) as unknown as Response,
      );
      const request = createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).listServers();
      const timeoutExpectation = expect(request).rejects.toEqual(
        expect.objectContaining<Partial<HetznerCloudApiError>>({
          code: "timeout",
        }),
      );

      await jest.advanceTimersByTimeAsync(15_001);
      await timeoutExpectation;
    } finally {
      jest.useRealTimers();
    }
  });

  it("creates one powered-off server with quote-bound identifiers and accepts omitted root_password plus next actions", async () => {
    const server = {
      id: 42,
      name: "hivra-11111111111141118111",
      status: "off",
      public_net: {
        ipv4: { ip: "203.0.113.10" },
        ipv6: { ip: "2001:db8::/64" },
      },
      created: "2026-08-26T15:00:00+00:00",
      labels: {
        "hivra-operation": "11111111-1111-4111-8111-111111111111",
        "hivra-quote": "0123456789abcdef0123456789abcdef",
        "hivra-managed": "true",
      },
      backup_window: null,
      server_type: { id: 104, name: "cpx22", cores: 2, memory: 4, disk: 80 },
      image: { id: 100, name: "ubuntu-24.04" },
      location: { id: 1, name: "fsn1" },
    };
    const fetchImpl = jest.fn().mockResolvedValue(json({
      server,
      action: {
        id: 500,
        status: "running",
        command: "create_server",
        resources: [{ id: 42, type: "server" }],
      },
      next_actions: [{
        id: 501,
        status: "running",
        command: "create_primary_ip",
        resources: [{ id: 88, type: "primary_ip" }],
      }],
    }, 201));

    const result = await createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).createServer({
      name: server.name,
      server_type: "104",
      image: "100",
      location: "1",
      user_data: "#cloud-config\nusers: []\n",
      ssh_keys: ["77"],
      labels: server.labels,
      start_after_create: false,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      volumes: [],
    });

    expect(result.nextActions).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.hetzner.cloud/v1/servers");
    const payload = JSON.parse(String(init.body));
    expect(payload).toEqual(expect.objectContaining({
      server_type: "104",
      image: "100",
      location: "1",
      ssh_keys: ["77"],
      start_after_create: false,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      volumes: [],
    }));
    expect(payload).not.toHaveProperty("backups");
  });

  it("fails closed on POST redirects without replaying a paid mutation", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 308,
        headers: { location: "https://attacker.test/servers" },
      }),
    );
    const request = createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).createServer({
      name: "hivra-11111111111141118111",
      server_type: "104",
      image: "100",
      location: "1",
      user_data: "#cloud-config\n",
      ssh_keys: ["77"],
      labels: { "hivra-managed": "true" },
      start_after_create: false,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      volumes: [],
    });

    await expect(request).rejects.toEqual(expect.objectContaining({ status: 308 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toEqual(expect.objectContaining({
      redirect: "error",
    }));
  });

  it("changes one exact server type while always retaining its existing disk", async () => {
    const action = {
      id: 701,
      status: "running" as const,
      command: "change_server_type",
      resources: [{ id: 42, type: "server" }],
    };
    const fetchImpl = jest.fn().mockResolvedValue(json({ action }, 201));

    await expect(createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).changeServerType({ serverId: 42, serverType: "cpx32" })).resolves.toEqual(action);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.hetzner.cloud/v1/servers/42/actions/change_type",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ server_type: "cpx32", upgrade_disk: false }),
      }),
    );
  });

  it.each([
    { command: "change_type", resources: [{ id: 42, type: "server" }] },
    { command: "change_server_type", resources: [{ id: 43, type: "server" }] },
    { command: "change_server_type", resources: [{ id: 42, type: "image" }] },
  ])("rejects a wrong resize receipt without repeating the POST: %j", async (receipt) => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ action: {
      id: 701, status: "running", ...receipt,
    } }, 201));
    await expect(createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).changeServerType({ serverId: 42, serverType: "cpx32" }))
      .rejects.toEqual(expect.objectContaining({ code: "response_invalid", status: 502 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not follow or repeat an ambiguous change-type redirect", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: "https://attacker.test/change_type" },
    }));

    await expect(createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).changeServerType({ serverId: 42, serverType: "cpx32" }))
      .rejects.toEqual(expect.objectContaining({ status: 307 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined])(
    "accepts root_password %s but never returns it",
    async (rootPassword) => {
      const body: Record<string, unknown> = {
        server: { id: 42 },
        action: {
          id: 500,
          status: "running",
          command: "create_server",
          resources: [{ id: 42, type: "server" }],
        },
      };
      if (rootPassword !== undefined) body.root_password = rootPassword;
      const fetchImpl = jest.fn().mockResolvedValue(json(body, 201));
      const result = await createHetznerCloudProjectClient("owner-project-token", {
        fetchImpl: fetchImpl as typeof fetch,
      }).createServer({
        name: "hivra-11111111111141118111",
        server_type: "104",
        image: "100",
        location: "1",
        user_data: "#cloud-config\n",
        ssh_keys: ["77"],
        labels: { "hivra-managed": "true" },
        start_after_create: false,
        public_net: { enable_ipv4: true, enable_ipv6: true },
        volumes: [],
      });
      expect(result).not.toHaveProperty("root_password");
      expect(result.nextActions).toEqual([]);
    },
  );

  it("fails closed and never exposes a returned plaintext root password", async () => {
    const rootPassword = "provider-plaintext-root-secret";
    const fetchImpl = jest.fn().mockResolvedValue(json({
      server: { id: 42 },
      action: {
        id: 500,
        status: "running",
        command: "create_server",
        resources: [{ id: 42, type: "server" }],
      },
      root_password: rootPassword,
    }, 201));
    const request = createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).createServer({
      name: "hivra-11111111111141118111",
      server_type: "104",
      image: "100",
      location: "1",
      user_data: "#cloud-config\n",
      ssh_keys: ["77"],
      labels: { "hivra-managed": "true" },
      start_after_create: false,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      volumes: [],
    });
    await expect(request).rejects.toEqual(expect.objectContaining({
      code: "response_invalid",
    }));
    await expect(request).rejects.not.toThrow(rootPassword);
  });

  it("retains only the allowlisted provider code from an error body", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({
      error: {
        code: "token_readonly",
        message: "secret reflected provider detail",
        details: { token: "must-not-escape" },
      },
    }, 401));
    const request = createHetznerCloudProjectClient("owner-project-token", {
      fetchImpl: fetchImpl as typeof fetch,
    }).listServers();
    await expect(request).rejects.toEqual(expect.objectContaining({
      providerCode: "token_readonly",
      status: 401,
    }));
    await expect(request).rejects.not.toThrow("must-not-escape");
  });
});
