/**
 * Error classes that can be thrown from deep helper code (services, libs)
 * and caught by route handlers via `handleApiError` to produce a useful
 * status code instead of a generic 500.
 *
 * This file deliberately avoids importing `next/server` so it stays
 * loadable from client-side bundles and jsdom test runners.
 */

/**
 * Throw from setting-write helpers when user input fails a validation
 * that a Zod schema couldn't easily express (e.g. SSRF check on a URL
 * field embedded in a free-form record). `handleApiError` returns a 400
 * with this message verbatim.
 */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}
