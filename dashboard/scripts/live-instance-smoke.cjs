#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 10_000;

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function validateUrl(name, value) {
  const normalized = stripTrailingSlash(trim(value));
  if (!normalized) {
    throw new Error(`${name} is required`);
  }

  try {
    const parsed = new URL(normalized);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("must use http or https");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be a valid http(s) URL: ${message}`);
  }

  return normalized;
}

function resolveCookieHeader(env) {
  const rawCookieHeader = trim(env.SMOKE_COOKIE_HEADER);
  if (rawCookieHeader) {
    return rawCookieHeader;
  }

  const sessionCookie = trim(env.SMOKE_SESSION_COOKIE);
  if (sessionCookie) {
    return `__session=${sessionCookie}`;
  }

  return "";
}

function resolveTimeoutMs(env) {
  const raw = trim(env.SMOKE_TIMEOUT_MS);
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("SMOKE_TIMEOUT_MS must be a positive integer");
  }

  return parsed;
}

function resolveSmokeConfig(env = process.env) {
  const requestedMode = trim(env.SMOKE_MODE).toLowerCase();
  const timeoutMs = resolveTimeoutMs(env);

  const dashboardUrl = trim(env.SMOKE_DASHBOARD_URL);
  const instanceId = trim(env.SMOKE_INSTANCE_ID);
  const cookieHeader = resolveCookieHeader(env);

  if ((!requestedMode || requestedMode === "dashboard") && dashboardUrl && instanceId && cookieHeader) {
    return {
      mode: "dashboard",
      baseUrl: validateUrl("SMOKE_DASHBOARD_URL", dashboardUrl),
      instanceId,
      timeoutMs,
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
    };
  }

  const gatewayUrl = trim(env.SMOKE_GATEWAY_URL);
  const apiServerKey = trim(env.SMOKE_API_SERVER_KEY);

  if ((!requestedMode || requestedMode === "direct") && gatewayUrl && apiServerKey) {
    return {
      mode: "direct",
      gatewayUrl: validateUrl("SMOKE_GATEWAY_URL", gatewayUrl),
      timeoutMs,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiServerKey}`,
      },
    };
  }

  if (requestedMode === "dashboard") {
    throw new Error(
      "Dashboard smoke mode requires SMOKE_DASHBOARD_URL, SMOKE_INSTANCE_ID, and either SMOKE_COOKIE_HEADER or SMOKE_SESSION_COOKIE."
    );
  }

  if (requestedMode === "direct") {
    throw new Error("Direct smoke mode requires SMOKE_GATEWAY_URL and SMOKE_API_SERVER_KEY.");
  }

  throw new Error(
    "Set dashboard smoke variables (SMOKE_DASHBOARD_URL, SMOKE_INSTANCE_ID, SMOKE_COOKIE_HEADER|SMOKE_SESSION_COOKIE) or direct smoke variables (SMOKE_GATEWAY_URL, SMOKE_API_SERVER_KEY)."
  );
}

function buildChecks(config) {
  if (config.mode === "dashboard") {
    const encodedId = encodeURIComponent(config.instanceId);
    const instanceBase = `${config.baseUrl}/api/instances/${encodedId}`;

    return [
      {
        name: "dashboard health",
        url: `${instanceBase}/health`,
        headers: config.headers,
        validateJson(data) {
          if (!data || data.isReady !== true) {
            throw new Error(`expected { isReady: true } but received ${JSON.stringify(data)}`);
          }
        },
      },
      {
        name: "dashboard sidecar health",
        url: `${instanceBase}/browser-sessions`,
        headers: config.headers,
        validateJson(data) {
          if (!data || typeof data !== "object") {
            throw new Error(`expected JSON object from browser-sessions but received ${JSON.stringify(data)}`);
          }
        },
      },
    ];
  }

  return [
    {
      name: "gateway models probe",
      url: `${config.gatewayUrl}/v1/models`,
      headers: config.headers,
      validateJson(data) {
        if (!data || typeof data !== "object" || !Array.isArray(data.data)) {
          throw new Error(`expected model list payload but received ${JSON.stringify(data)}`);
        }
      },
    },
    {
      name: "sidecar health",
      url: `${config.gatewayUrl}/vnc/core/rfb.js`,
      headers: config.headers,
    },
  ];
}

async function runCheck(check, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(check.url, {
      method: "GET",
      headers: check.headers,
      signal: controller.signal,
    });

    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(
        `${check.name} failed with ${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`
      );
    }

    if (check.validateJson) {
      let parsed;
      try {
        parsed = bodyText ? JSON.parse(bodyText) : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${check.name} returned invalid JSON: ${message}`);
      }

      check.validateJson(parsed);
      return { name: check.name, url: check.url, status: response.status, body: parsed };
    }

    return { name: check.name, url: check.url, status: response.status, body: bodyText };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runSmoke(config, fetchImpl = fetch) {
  const checks = buildChecks(config);
  const results = [];

  for (const check of checks) {
    const result = await runCheck(check, fetchImpl, config.timeoutMs);
    results.push(result);
  }

  return {
    mode: config.mode,
    results,
  };
}

async function main() {
  const config = resolveSmokeConfig(process.env);
  console.log(`[live-instance-smoke] mode=${config.mode}`);

  const summary = await runSmoke(config);
  for (const result of summary.results) {
    console.log(`[live-instance-smoke] PASS ${result.name} -> ${result.status} (${result.url})`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[live-instance-smoke] FAIL ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildChecks,
  resolveSmokeConfig,
  runCheck,
  runSmoke,
};
