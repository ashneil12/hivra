import { NextRequest } from "next/server";

/**
 * Shared request builders for route-handler tests.
 *
 * 178 test files construct a Request/NextRequest inline and 38 define a local
 * makeRequest/buildRequest helper. These cover the shapes those helpers build.
 */
export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  searchParams?: Record<string, string>;
}

/** Build a NextRequest for a route handler under test. */
export function makeRequest(url: string, options: RequestOptions = {}): NextRequest {
  const { method = "GET", body, headers = {}, cookies = {}, searchParams } = options;
  const base = url.startsWith("http") ? url : `http://localhost:3000${url.startsWith("/") ? "" : "/"}${url}`;
  const parsed = new URL(base);
  for (const [key, value] of Object.entries(searchParams ?? {})) parsed.searchParams.set(key, value);

  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { ...headers },
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!("content-type" in headers)) init.headers["content-type"] = "application/json";
  }
  const request = new NextRequest(parsed, init);
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value);
  return request;
}

/** Build a JSON POST/PATCH/PUT request. */
export function makeJsonRequest(url: string, body: unknown, options: RequestOptions = {}): NextRequest {
  return makeRequest(url, { ...options, method: options.method ?? "POST", body });
}

/** The second argument Next.js passes to a dynamic route handler. */
export function makeRouteContext<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}
