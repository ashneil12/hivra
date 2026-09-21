import posthog from "posthog-js";

import { clientLog, type ClientLogContext } from "@/lib/client/logger";

type JsonDiagnosticsContext = {
  source: string;
  route?: string;
  apiEndpoint?: string;
};

function normalizeResponseSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function responseUrl(response: Response, fallback?: string): string | undefined {
  return response.url || fallback;
}

function reportJsonResponseFailure(error: Error, metadata: ClientLogContext, message: string): void {
  try {
    posthog.captureException(error, metadata);
  } catch {
    // Diagnostics must not replace the original response handling path.
  }

  try {
    clientLog.warn(message, metadata, error);
  } catch {
    // Diagnostics must not replace the original response handling path.
  }
}

export async function readJsonWithDiagnostics<T = unknown>(
  response: Response,
  context: JsonDiagnosticsContext
): Promise<T | null> {
  if (typeof response.text !== "function") {
    try {
      return typeof response.json === "function" ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  }

  let responseText = "";

  try {
    responseText = await response.text();
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Failed to read API response body");
    const metadata = {
      source: context.source,
      route: context.route,
      apiEndpoint: responseUrl(response, context.apiEndpoint),
      requestId: response.headers.get("x-request-id") || undefined,
      responseStatus: response.status,
      failureType: "json_body_read_failed",
    };

    reportJsonResponseFailure(error, metadata, "API response body could not be read");
    return null;
  }

  if (!responseText.trim()) {
    return null;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (err) {
    const error = err instanceof Error ? err : new Error("API response was not valid JSON");
    const metadata = {
      source: context.source,
      route: context.route,
      apiEndpoint: responseUrl(response, context.apiEndpoint),
      requestId: response.headers.get("x-request-id") || undefined,
      responseStatus: response.status,
      rawBodySnippet: normalizeResponseSnippet(responseText),
      failureType: "json_parse_failed",
    };

    Object.assign(error, {
      apiEndpoint: metadata.apiEndpoint,
      requestId: metadata.requestId,
      responseStatus: metadata.responseStatus,
      rawBodySnippet: metadata.rawBodySnippet,
    });

    reportJsonResponseFailure(error, metadata, "API response was not valid JSON");
    return null;
  }
}
