import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { SIDECAR_SERVER_CODE } from "@/lib/services/sidecar-script";

type ServerHandler = (req: MockRequest, res: MockResponse) => void | Promise<void>;
type ProxyResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  resume: jest.Mock;
  pipe: (response: MockResponse) => void;
};

class MockRequest extends EventEmitter {
  method = "GET";
  url = "/";
  headers: Record<string, string> = {};
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  headersSent = false;
  body = "";

  writeHead(statusCode: number, headers: Record<string, unknown>) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer) {
    this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    this.headersSent = true;
    return true;
  }

  end(chunk?: string | Buffer) {
    if (chunk) {
      this.write(chunk);
    }
    this.headersSent = true;
    this.emit("finish");
    return this;
  }
}

function waitForFinish(response: MockResponse): Promise<void> {
  return new Promise((resolve) => response.once("finish", () => resolve()));
}

function buildSignedHeaders(apiServerKey: string) {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", apiServerKey)
    .update(timestamp)
    .digest("hex");

  return {
    "x-hermes-timestamp": timestamp,
    "x-hermes-signature": signature,
  };
}

describe("sidecar dashboard recovery", () => {
  it("reflects the upstream WebSocket extension negotiation before relaying frames", async () => {
    const downstreamWrites: Buffer[] = [];
    const downstreamSocket = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy: jest.fn(),
      end: jest.fn(),
      pipe: jest.fn(),
      setNoDelay: jest.fn(),
      write: jest.fn((chunk: string | Buffer) => {
        downstreamWrites.push(Buffer.from(chunk));
        return true;
      }),
    });
    const upstreamSocket = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      end: jest.fn(),
      pipe: jest.fn(),
      setNoDelay: jest.fn(),
      write: jest.fn(),
    });
    const gatewayReadyFrame = Buffer.from("compressed-gateway-ready-frame");

    const requestMock = jest.fn(
      (
        upstreamUrl: URL | string,
        _options: unknown,
        callback?: (response: ProxyResponse) => void,
      ) => {
        const proxyRequest = new EventEmitter() as EventEmitter & {
          destroy: jest.Mock;
          end: () => void;
          setTimeout: jest.Mock;
        };
        proxyRequest.destroy = jest.fn();
        proxyRequest.setTimeout = jest.fn();
        proxyRequest.end = () => {
          const target = String(upstreamUrl);
          if (target.endsWith("/api/status")) {
            const response = new EventEmitter() as ProxyResponse;
            response.statusCode = 200;
            response.headers = {};
            response.resume = jest.fn();
            response.pipe = jest.fn();
            setImmediate(() => callback?.(response));
            return;
          }
          if (target.includes("/api/ws?ticket=upstream-ticket")) {
            setImmediate(() =>
              proxyRequest.emit(
                "upgrade",
                {
                  headers: {
                    "sec-websocket-accept": "accepted-key",
                    "sec-websocket-extensions": "permessage-deflate",
                  },
                },
                upstreamSocket,
                gatewayReadyFrame,
              ),
            );
          }
        };
        return proxyRequest;
      },
    );

    const mockedHttp = {
      createServer: jest.fn(() => ({
        listen: jest.fn(),
        on: jest.fn(),
      })),
      request: requestMock,
    };
    const context = vm.createContext({
      require: (moduleName: string) => {
        switch (moduleName) {
          case "http":
            return mockedHttp;
          case "https":
            return { request: requestMock };
          case "fs":
            return fs;
          case "path":
            return path;
          case "child_process":
            return { exec: jest.fn(), spawn: jest.fn() };
          case "crypto":
            return crypto;
          case "url":
            return { URL };
          default:
            throw new Error(`Unexpected module request: ${moduleName}`);
        }
      },
      process: {
        env: {
          INSTANCE_ID: "inst_123",
          API_SERVER_KEY: "internal-server-key",
          DASHBOARD_BASIC_AUTH_USERNAME: "hermes",
          DASHBOARD_UPSTREAM_URL: "http://agent-inst_123-official-dashboard:9119",
        },
      },
      fetch: jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ticket: "upstream-ticket" }),
      })),
      console: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      Buffer,
      URL,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      setImmediate,
    });

    vm.runInContext(SIDECAR_SERVER_CODE, context);
    vm.runInContext(
      "dashboardUpstreamCookie = 'hermes_session_at=valid-cookie'; " +
        "dashboardUpstreamCookieExpiresAt = Date.now() + 60000",
      context,
    );
    const upgrade = vm.runInContext("handleGatedDashboardWsUpgrade", context) as (
      req: MockRequest,
      socket: typeof downstreamSocket,
      head: Buffer,
      requestUrl: URL,
    ) => Promise<void>;

    const request = new MockRequest();
    request.url = "/api/ws?token=internal-server-key";
    request.headers = {
      "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
      "sec-websocket-key": "client-key",
      "sec-websocket-version": "13",
    };
    await upgrade(
      request,
      downstreamSocket,
      Buffer.alloc(0),
      new URL(`https://agent.example.com${request.url}`),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const handshake = downstreamWrites[0]?.toString("utf8") ?? "";
    expect(handshake).toContain("HTTP/1.1 101 Switching Protocols");
    expect(handshake).toContain("Sec-WebSocket-Accept: accepted-key");
    expect(handshake).toContain("Sec-WebSocket-Extensions: permessage-deflate");
    expect(downstreamWrites[1]).toEqual(gatewayReadyFrame);
    expect(upstreamSocket.pipe).toHaveBeenCalledWith(downstreamSocket);
    expect(downstreamSocket.pipe).toHaveBeenCalledWith(upstreamSocket);
  });

  it("terminates the client bearer before forwarding the internal dashboard session", async () => {
    let forwardedHeaders: Record<string, string> | null = null;

    const requestMock = jest.fn(
      (
        _upstreamUrl: URL | string,
        options: { headers?: Record<string, string> },
        callback: (response: ProxyResponse) => void,
      ) => {
        forwardedHeaders = options.headers ?? {};
        const proxyRequest = new EventEmitter() as EventEmitter & {
          destroy: jest.Mock;
          end: (body?: string) => void;
          setTimeout: jest.Mock;
        };
        proxyRequest.destroy = jest.fn();
        proxyRequest.setTimeout = jest.fn();
        proxyRequest.end = () => {
          const proxyResponse = new EventEmitter() as ProxyResponse;
          proxyResponse.statusCode = 200;
          proxyResponse.headers = { "content-type": "application/json" };
          proxyResponse.resume = jest.fn();
          proxyResponse.pipe = (response: MockResponse) => response.end('{"ok":true}');
          setImmediate(() => callback(proxyResponse));
        };
        return proxyRequest;
      },
    );

    const mockedHttp = {
      createServer: jest.fn(() => ({
        listen: jest.fn(),
        on: jest.fn(),
      })),
      request: requestMock,
    };
    const context = vm.createContext({
      require: (moduleName: string) => {
        switch (moduleName) {
          case "http":
            return mockedHttp;
          case "https":
            return { request: requestMock };
          case "fs":
            return fs;
          case "path":
            return path;
          case "child_process":
            return { exec: jest.fn(), spawn: jest.fn() };
          case "crypto":
            return crypto;
          case "url":
            return { URL };
          default:
            throw new Error(`Unexpected module request: ${moduleName}`);
        }
      },
      process: {
        env: {
          INSTANCE_ID: "inst_123",
          API_SERVER_KEY: "internal-server-key",
          DASHBOARD_BASIC_AUTH_USERNAME: "hermes",
          DASHBOARD_UPSTREAM_URL: "http://agent-inst_123-official-dashboard:9119",
        },
      },
      console: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      Buffer,
      URL,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      setImmediate,
    });

    vm.runInContext(SIDECAR_SERVER_CODE, context);
    vm.runInContext("dashboardUpstreamCookie = 'hermes_session_at=valid-cookie'", context);
    const proxy = vm.runInContext("dashboardProxyOnceWithCookie", context) as (
      req: MockRequest,
      res: MockResponse,
      requestUrl: URL,
      rawBody: string,
      upstreamBase: string,
      allowAuthRetry: boolean,
    ) => Promise<string>;

    const request = new MockRequest();
    request.url = "/api/sessions";
    request.headers = {
      authorization: "Bearer external-sidecar-key",
      cookie: "attacker_cookie=must-not-forward",
      host: "agent.example.com",
    };
    const response = new MockResponse();

    await expect(
      proxy(
        request,
        response,
        new URL("https://agent.example.com/api/sessions"),
        "",
        "http://agent-inst_123-official-dashboard:9119",
        false,
      ),
    ).resolves.toBe("ok");

    expect(forwardedHeaders).not.toBeNull();
    expect(forwardedHeaders).not.toHaveProperty("authorization");
    expect(forwardedHeaders).toMatchObject({
      "x-hermes-session-token": "internal-server-key",
      cookie: "hermes_session_at=valid-cookie",
    });
  });

  it("starts a fallback dashboard inside the main agent container when the dedicated upstream is unavailable", async () => {
    let handler: ServerHandler | null = null;
    let dashboardStarted = false;

    const execMock = jest.fn((command: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback =
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : typeof maybeCallback === "function"
            ? maybeCallback
            : null;

      if (command.includes("docker ps --format")) {
        callback?.(null, "agent-inst_123\nagent-inst_123-web\n", "");
        return { pid: 1 };
      }

      if (command.includes("dashboard --host 0.0.0.0 --port 9119 --no-open --insecure")) {
        dashboardStarted = true;
      }

      callback?.(null, "", "");
      return { pid: 1 };
    });

    const requestMock = jest.fn((upstreamUrl: URL | string, _options: unknown, callback: (response: ProxyResponse) => void) => {
      const proxyRequest = new EventEmitter() as EventEmitter & {
        destroy: jest.Mock;
        end: (body?: string) => void;
        setTimeout: jest.Mock;
      };

      proxyRequest.destroy = jest.fn();
      proxyRequest.setTimeout = jest.fn((_timeout: number, timeoutCallback?: () => void) => {
        if (timeoutCallback) {
          proxyRequest.once("__timeout__", timeoutCallback);
        }
        return proxyRequest;
      });

      proxyRequest.end = () => {
        const target = String(upstreamUrl);

        if (target.includes("agent-inst_123-web:9119")) {
          setImmediate(() => proxyRequest.emit("error", new Error("connect ECONNREFUSED agent-inst_123-web:9119")));
          return;
        }

        if (target.includes("agent-inst_123:9119") && !dashboardStarted) {
          setImmediate(() => proxyRequest.emit("error", new Error("connect ECONNREFUSED agent-inst_123:9119")));
          return;
        }

        if (target.includes("127.0.0.1:9119")) {
          setImmediate(() => proxyRequest.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:9119")));
          return;
        }

        const proxyResponse = new EventEmitter() as ProxyResponse;
        proxyResponse.statusCode = 200;
        proxyResponse.headers = { "content-type": "text/html; charset=utf-8" };
        proxyResponse.resume = jest.fn();
        proxyResponse.pipe = (response: MockResponse) => {
          response.end("<html>dashboard ok</html>");
        };

        setImmediate(() => callback(proxyResponse));
      };

      return proxyRequest;
    });

    const mockedHttp = {
      createServer: jest.fn((nextHandler: ServerHandler) => {
        handler = nextHandler;
        return {
          listen: jest.fn((_port: number | string, callback?: () => void) => callback?.()),
          on: jest.fn(),
        };
      }),
      request: requestMock,
    };

    const sidecarContext = {
      require: (moduleName: string) => {
        switch (moduleName) {
          case "http":
            return mockedHttp;
          case "https":
            return { request: requestMock };
          case "fs":
            return fs;
          case "path":
            return path;
          case "child_process":
            return { exec: execMock, spawn: jest.fn() };
          case "crypto":
            return crypto;
          case "url":
            return { URL };
          default:
            throw new Error(`Unexpected module request: ${moduleName}`);
        }
      },
      process: {
        env: {
          INSTANCE_ID: "inst_123",
          API_SERVER_KEY: "server-key",
          DASHBOARD_UPSTREAM_URL: "http://agent-inst_123-web:9119",
        },
      },
      console: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      Buffer,
      setTimeout,
      clearTimeout,
      setImmediate,
    };

    vm.runInNewContext(SIDECAR_SERVER_CODE, sidecarContext);

    expect(handler).not.toBeNull();

    const request = new MockRequest();
    request.headers = buildSignedHeaders("server-key");

    const response = new MockResponse();
    const finished = waitForFinish(response);

    await handler!(request, response);
    await finished;

    expect(
      execMock.mock.calls.some(([command]) =>
        String(command).includes('dashboard --host 0.0.0.0 --port 9119 --no-open --insecure'),
      ),
    ).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("dashboard ok");
  });

  it("waits for the fallback dashboard to finish booting before giving up", async () => {
    let handler: ServerHandler | null = null;
    let dashboardStartedAtAttempt = -1;
    let mainDashboardProbeCount = 0;

    const execMock = jest.fn((command: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback =
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : typeof maybeCallback === "function"
            ? maybeCallback
            : null;

      if (command.includes("docker ps --format")) {
        callback?.(null, "agent-inst_123\nagent-inst_123-web\n", "");
        return { pid: 1 };
      }

      if (command.includes("dashboard --host 0.0.0.0 --port 9119 --no-open --insecure")) {
        dashboardStartedAtAttempt = mainDashboardProbeCount;
      }

      callback?.(null, "", "");
      return { pid: 1 };
    });

    const requestMock = jest.fn((upstreamUrl: URL | string, _options: unknown, callback: (response: ProxyResponse) => void) => {
      const proxyRequest = new EventEmitter() as EventEmitter & {
        destroy: jest.Mock;
        end: (body?: string) => void;
        setTimeout: jest.Mock;
      };

      proxyRequest.destroy = jest.fn();
      proxyRequest.setTimeout = jest.fn((_timeout: number, timeoutCallback?: () => void) => {
        if (timeoutCallback) {
          proxyRequest.once("__timeout__", timeoutCallback);
        }
        return proxyRequest;
      });

      proxyRequest.end = () => {
        const target = String(upstreamUrl);

        if (target.includes("agent-inst_123-web:9119")) {
          setImmediate(() => proxyRequest.emit("error", new Error("connect ECONNREFUSED agent-inst_123-web:9119")));
          return;
        }

        if (target.includes("agent-inst_123:9119")) {
          mainDashboardProbeCount += 1;
          const bootedLongEnough =
            dashboardStartedAtAttempt >= 0 &&
            mainDashboardProbeCount - dashboardStartedAtAttempt >= 5;

          if (!bootedLongEnough) {
            setImmediate(() => proxyRequest.emit("error", new Error("connect ECONNREFUSED agent-inst_123:9119")));
            return;
          }
        }

        if (target.includes("127.0.0.1:9119")) {
          setImmediate(() => proxyRequest.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:9119")));
          return;
        }

        const proxyResponse = new EventEmitter() as ProxyResponse;
        proxyResponse.statusCode = 200;
        proxyResponse.headers = { "content-type": "text/html; charset=utf-8" };
        proxyResponse.resume = jest.fn();
        proxyResponse.pipe = (response: MockResponse) => {
          response.end("<html>dashboard warmed up</html>");
        };

        setImmediate(() => callback(proxyResponse));
      };

      return proxyRequest;
    });

    const mockedHttp = {
      createServer: jest.fn((nextHandler: ServerHandler) => {
        handler = nextHandler;
        return {
          listen: jest.fn((_port: number | string, callback?: () => void) => callback?.()),
          on: jest.fn(),
        };
      }),
      request: requestMock,
    };

    const sidecarContext = {
      require: (moduleName: string) => {
        switch (moduleName) {
          case "http":
            return mockedHttp;
          case "https":
            return { request: requestMock };
          case "fs":
            return fs;
          case "path":
            return path;
          case "child_process":
            return { exec: execMock, spawn: jest.fn() };
          case "crypto":
            return crypto;
          case "url":
            return { URL };
          default:
            throw new Error(`Unexpected module request: ${moduleName}`);
        }
      },
      process: {
        env: {
          INSTANCE_ID: "inst_123",
          API_SERVER_KEY: "server-key",
          DASHBOARD_UPSTREAM_URL: "http://agent-inst_123-web:9119",
        },
      },
      console: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      Buffer,
      setTimeout,
      clearTimeout,
      setImmediate,
    };

    vm.runInNewContext(SIDECAR_SERVER_CODE, sidecarContext);

    expect(handler).not.toBeNull();

    const request = new MockRequest();
    request.headers = buildSignedHeaders("server-key");

    const response = new MockResponse();
    const finished = waitForFinish(response);

    await handler!(request, response);
    await finished;

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("dashboard warmed up");
  });
});
